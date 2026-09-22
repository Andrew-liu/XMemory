import type { CookieRecord } from './cookies'
import { Library, atomic } from './library'
import { RateLimiter } from './rate-limit'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ArchiveProgress, Note } from '../shared/types'
import { bookmarksChunkFromHtml, browserHeaders, chunkUrls, extractBearer, extractOperations, imageHeaders, isLoggedOutLanding, scriptUrlsFromHtml } from './x-client'
import { accountFromCookies, buildBookmarkCall, type CapturedEndpoint } from './x-auth'

type Json = Record<string, any>
export interface ArchivedPost {
  id: string
  text: string
  author: string
  url: string
  images: string[]
  links: string[]
  publishedAt?: string
  partial: boolean
  videoCover: boolean
}
interface ImageJob { postId: string; url: string; reason?: string }
interface Checkpoint {
  cursor?: string
  count: number
  completedAt?: string
  pendingImages: ImageJob[]
  failedImages: ImageJob[]
  lastSuccessAt?: string
}
const IMAGE_HOSTS = new Set(['pbs.twimg.com', 'abs.twimg.com', 'video.twimg.com', 'ton.twimg.com'])
export function allowedImage(url: string) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && IMAGE_HOSTS.has(parsed.hostname) && !/\.(mp4|m3u8)(\?|$)/i.test(parsed.pathname)
  } catch { return false }
}
export function imageCandidates(url: string) {
  const urls = [url]
  try {
    const parsed = new URL(url)
    parsed.pathname = parsed.pathname.replace(/:(orig|large|medium|small|thumb|360x360|900x900)$/i, '')
    if (parsed.hostname === 'pbs.twimg.com' || parsed.hostname === 'ton.twimg.com') {
      const ext = parsed.pathname.match(/\.(jpg|jpeg|png|webp|gif)$/i)?.[1]?.toLowerCase() || parsed.searchParams.get('format') || 'jpg'
      parsed.searchParams.set('format', ext === 'jpeg' ? 'jpg' : ext)
      for (const name of ['large', 'medium', 'small']) {
        parsed.searchParams.set('name', name)
        urls.push(parsed.href)
      }
    }
  } catch { /* Keep the original URL. */ }
  return [...new Set(urls)]
}
function emptyCheckpoint(): Checkpoint {
  return { count: 0, pendingImages: [], failedImages: [] }
}
export function extractArticleText(article: Json | undefined) {
  if (!article || typeof article !== 'object') return ''
  if (typeof article.plain_text === 'string' && article.plain_text.trim()) return article.plain_text.trim()
  const blocks = article.content?.blocks
  if (Array.isArray(blocks)) {
    const text = blocks.map((block: Json) => typeof block?.text === 'string' ? block.text : '').filter(Boolean).join('\n\n')
    if (text.trim()) return text.trim()
  }
  const title = typeof article.title === 'string' ? article.title.trim() : ''
  const preview = typeof article.preview_text === 'string' ? article.preview_text.trim() : ''
  return [title, preview].filter(Boolean).join('\n\n')
}
export function extractArticleImages(article: Json | undefined) {
  if (!article || typeof article !== 'object') return []
  const urls: string[] = []
  const take = (node: Json | undefined) => {
    const url = node?.media_info?.original_img_url || node?.media_info?.url || node?.original_img_url
    if (typeof url === 'string') urls.push(url)
  }
  take(article.cover_media)
  const entities = article.media_entities
  if (Array.isArray(entities)) for (const item of entities) take(item)
  else if (entities && typeof entities === 'object') for (const item of Object.values(entities)) take(item as Json)
  return urls
}
export function isArticleLink(value: string) {
  return /(?:x\.com|twitter\.com)\/i\/article\/\d+/i.test(value)
}
export function parseTweetResult(input: Json | undefined): ArchivedPost | undefined {
  if (!input) return
  const result: Json = input.tweet || input
  const legacy = result.legacy
  if (!legacy || !/^\d+$/.test(result.rest_id)) return
  const author = result.core?.user_results?.result?.legacy?.screen_name || result.core?.user_results?.result?.core?.screen_name || 'unknown'
  const full = result.note_tweet?.note_tweet_results?.result?.text
  const article = result.article?.article_results?.result || result.article
  let articleText = extractArticleText(article)
  if (typeof article?.title === 'string' && article.title && articleText && !articleText.startsWith(article.title)) articleText = `${article.title}\n\n${articleText}`
  const text = articleText || full || legacy.full_text || ''
  const media = legacy.extended_entities?.media || legacy.entities?.media || []
  const images: string[] = []
  let videoCover = false
  for (const item of media) {
    if (item?.type === 'video' || item?.type === 'animated_gif') {
      videoCover = true
      if (typeof item.media_url_https === 'string') images.push(item.media_url_https)
      continue
    }
    if (typeof item.media_url_https === 'string') images.push(item.media_url_https)
  }
  const card = result.card?.legacy?.binding_values || []
  for (const value of card) if (/image/i.test(value.key || '') && value.value?.image_value?.url) images.push(value.value.image_value.url)
  images.push(...extractArticleImages(article))
  const links = (legacy.entities?.urls || []).map((u: Json) => u.expanded_url || u.url).filter((u: unknown): u is string => typeof u === 'string' && !/\.(mp4|m3u8)(\?|$)/i.test(u))
  const articleLinked = links.some(isArticleLink) || isArticleLink(text)
  const fullArticle = articleText.length > 120
  const published = typeof legacy.created_at === 'string' ? new Date(legacy.created_at) : undefined
  return {
    id: result.rest_id,
    text,
    author,
    url: `https://x.com/${author}/status/${result.rest_id}`,
    images: [...new Set(images.filter(allowedImage))],
    links,
    publishedAt: published && !Number.isNaN(published.getTime()) ? published.toISOString() : undefined,
    partial: (!!legacy.truncated && !full && !fullArticle) || (articleLinked && !fullArticle),
    videoCover
  }
}
export function parseBookmarkPage(data: Json): { posts: ArchivedPost[]; cursor?: string; terminated: boolean } {
  const timeline = data.data?.bookmark_timeline_v2?.timeline || data.data?.bookmark_timeline?.timeline
  if (!Array.isArray(timeline?.instructions)) throw new Error('X 书签响应结构已变化，采集已停止')
  const entries: Json[] = timeline.instructions.flatMap((i: Json) => i.entries || (i.entry ? [i.entry] : []))
  let cursor: string | undefined
  const posts: ArchivedPost[] = []
  for (const entry of entries) {
    const c = entry.content
    if (c?.cursorType === 'Bottom' || c?.cursorType === 'ShowMore') { cursor = c.value || cursor; continue }
    const parsed = parseTweetResult(c?.itemContent?.tweet_results?.result)
    if (parsed) posts.push(parsed)
  }
  const terminated = timeline.instructions.some((i: Json) => i.type === 'TimelineTerminateTimeline')
  if (!entries.length && !terminated) throw new Error('X 返回未知空页，不能判定已抓取全部历史')
  return { posts, cursor, terminated }
}
export function memoryMarkdown(post: ArchivedPost) {
  const title = post.text.replace(/\s+/g, ' ').slice(0, 55) || `书签 ${post.id}`
  const links = post.links.map(url => `<${url}>`).join('\n')
  const notes = [
    post.partial ? '> 正文可能不完整，X 未返回完整内容。' : '',
    post.videoCover ? '> 视频未下载，仅保留封面。' : ''
  ].filter(Boolean).join('\n\n')
  return { title, body: [post.text, links, `[原文](${post.url})`, notes].filter(Boolean).join('\n\n') }
}
export class XArchive {
  status = '未连接 X'
  progress: ArchiveProgress = { phase: 'idle', found: 0, saved: 0, imagesDone: 0, imagesFailed: 0 }
  private stopped = true
  private running = false
  private endpoint?: CapturedEndpoint
  private tweetDetail?: CapturedEndpoint
  private account = ''
  private limiter: RateLimiter
  constructor(private library: Library, private cookies: () => CookieRecord[], private change: () => void, private request: typeof fetch = fetch, private options: { fast?: boolean } = {}) {
    const file = path.join(library.root, 'local/rate.json')
    this.limiter = new RateLimiter(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined, s => atomic(file, JSON.stringify(s)))
  }
  useEndpoint(endpoint?: CapturedEndpoint) { if (endpoint?.id) this.endpoint = endpoint }
  private ensureAccount() {
    if (this.account) return
    const id = accountFromCookies(this.cookies())
    if (id) this.account = id
  }
  private set(text: string, extra: Partial<ArchiveProgress> = {}) {
    this.status = text
    this.progress = { ...this.progress, ...extra }
    this.change()
  }
  private file() { return path.join(this.library.root, 'local', `x-${this.account}.json`) }
  private load(): Checkpoint {
    if (!this.account || !existsSync(this.file())) return emptyCheckpoint()
    try {
      const raw = JSON.parse(readFileSync(this.file(), 'utf8'))
      return { ...emptyCheckpoint(), ...raw, pendingImages: raw.pendingImages || [], failedImages: raw.failedImages || [] }
    } catch { return emptyCheckpoint() }
  }
  private store(state: Checkpoint) {
    atomic(this.file(), JSON.stringify(state))
    const saved = [...this.library.notes.values()].filter(n => n.kind === 'memory' && n.id.startsWith(`x-${this.account}-`) && !n.deleted).length
    this.progress = {
      phase: this.stopped ? (state.completedAt ? 'complete' : 'paused') : this.progress.phase,
      found: Math.max(state.count, saved),
      saved,
      imagesDone: this.progress.imagesDone,
      imagesFailed: state.failedImages.length,
      lastSuccessAt: state.lastSuccessAt,
      cursor: state.cursor
    }
  }
  private async wait() {
    if (!this.options.fast) {
      while (this.limiter.remaining() && !this.stopped) {
        this.set(`限速等待 ${Math.ceil(this.limiter.remaining() / 1000)} 秒`)
        await new Promise(r => setTimeout(r, Math.min(1000, this.limiter.remaining())))
      }
    }
    if (this.stopped) throw new Error('采集已暂停')
    if (!this.options.fast) this.limiter.take()
  }
  private cookieHeader() {
    return this.cookies().map(c => `${c.name}=${c.value}`).join('; ')
  }
  private async readBundle(url: string) {
    const response = await this.request(url, { headers: browserHeaders(), signal: AbortSignal.timeout(30_000), redirect: 'error' })
    if (!response.ok) return ''
    return response.text()
  }
  private async discover() {
    if (this.endpoint) return this.endpoint
    this.set('正在识别 X 书签客户端（使用系统网络与代理）…', { phase: 'connecting' })
    const pages = ['https://x.com/i/bookmarks', 'https://x.com/home', 'https://x.com']
    let last = '未读取到 X 页面'
    for (const page of pages) {
      const response = await this.request(page, { headers: browserHeaders({ cookie: this.cookieHeader(), accept: 'text/html' }), signal: AbortSignal.timeout(30_000), redirect: 'manual' })
      if ([301, 302, 303, 307, 308].includes(response.status)) { last = 'X 将页面重定向到登录，登录态可能已过期，请重新登录'; continue }
      if (!response.ok) { last = `读取 ${page} 失败（${response.status}）`; continue }
      const html = await response.text()
      if (isLoggedOutLanding(html)) { last = '当前是未登录落地页，未包含书签客户端脚本'; continue }
      this.set('正在读取 X 客户端配置…')
      const operations: Record<string, string> = {}
      let bearer = ''
      const chunk = bookmarksChunkFromHtml(html)
      if (chunk) {
        for (const url of chunkUrls(chunk)) {
          const js = await this.readBundle(url)
          Object.assign(operations, extractOperations(js))
          bearer ||= extractBearer(js)
          if (operations.Bookmarks && operations.TweetResultByRestId) break
        }
      }
      for (const url of scriptUrlsFromHtml(html).sort((a, b) => Number(/\/main\./.test(b)) - Number(/\/main\./.test(a)))) {
        if (operations.Bookmarks && operations.TweetResultByRestId && bearer) break
        const js = await this.readBundle(url)
        Object.assign(operations, extractOperations(js))
        bearer ||= extractBearer(js)
      }
      if (operations.TweetResultByRestId) this.tweetDetail = { id: operations.TweetResultByRestId, bearer: bearer || extractBearer('') }
      if (operations.Bookmarks) return this.endpoint = { id: operations.Bookmarks, bearer: bearer || extractBearer('') }
      last = operations.CreateBookmark ? '已找到收藏动作接口，但缺少书签列表接口，客户端分包可能已变化' : '页面已打开，但未找到 Bookmarks 接口定义'
    }
    throw new Error(`${last}；未发出书签请求`)
  }
  private headers(bearer: string) {
    const values = this.cookies()
    if (!values.length) throw new Error('请先登录 X')
    return { ...browserHeaders(), authorization: `Bearer ${bearer}`, cookie: values.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': values.find(c => c.name === 'ct0')?.value || '', 'x-twitter-active-user': 'yes', 'x-twitter-auth-type': 'OAuth2Session' }
  }
  async verify() {
    this.stopped = false
    this.ensureAccount()
    let endpoint = this.endpoint
    if (!endpoint) {
      try { endpoint = await this.discover() } catch { endpoint = { id: '', bearer: extractBearer('') } }
    }
    const headers = this.headers(endpoint.bearer || extractBearer(''))
    const urls = [
      'https://api.x.com/1.1/account/verify_credentials.json?skip_status=true&include_entities=false',
      'https://x.com/i/api/1.1/account/verify_credentials.json?skip_status=true&include_entities=false'
    ]
    for (const url of urls) {
      try {
        const response = await this.request(url, { headers, signal: AbortSignal.timeout(30_000), redirect: 'follow' })
        if (!response.ok) continue
        const json = await response.json() as Json
        const id = String(json.id_str || json.rest_id || '')
        const name = String(json.screen_name || json.username || '')
        if (!/^\d+$/.test(id)) continue
        if (this.account && this.account !== id) throw new Error('登录账号与已有归档账号不一致，请先退出登录')
        this.account = id
        this.set(`已连接 @${name || id}`, { phase: 'idle' })
        this.store(this.load())
        return this.account
      } catch (error) {
        if (error instanceof Error && error.message.includes('不一致')) throw error
      }
    }
    if (this.account) {
      this.set(`已登录，账号 ${this.account}。书签扫描可用。`, { phase: 'idle' })
      this.store(this.load())
      return this.account
    }
    throw new Error('未从登录态中识别到账号，请重新登录 X')
  }
  private async check(response: Response) {
    if (response.status === 429) { this.limiter.limit(Number(response.headers.get('retry-after')) || 0); this.stopped = true; throw new Error('X 已限流，任务暂停；冷却结束后可继续') }
    if ([401, 403].includes(response.status)) { this.stopped = true; throw new Error('X 登录失效或需要验证，请重新登录 X') }
    if (!response.ok) throw new Error(`X 请求失败（${response.status}），任务已保留进度`)
  }
  pause() {
    this.stopped = true
    if (this.progress.phase === 'paused') return
    this.set('采集已暂停，进度已保留', { phase: 'paused' })
  }
  disconnect() {
    this.stopped = true
    this.account = ''
    this.endpoint = undefined
    this.progress = { phase: 'idle', found: 0, saved: 0, imagesDone: 0, imagesFailed: 0 }
    this.set('已断开 X', { phase: 'idle' })
  }
  private async requestBookmarks(endpoint: CapturedEndpoint, variables: Record<string, unknown>) {
    const origins = [...new Set([
      endpoint.origin,
      `https://x.com/i/api/graphql/${endpoint.id}/Bookmarks`,
      `https://api.x.com/graphql/${endpoint.id}/Bookmarks`
    ].filter((value): value is string => !!value))]
    const methods = [...new Set([endpoint.method || 'GET', 'POST', 'GET'])] as Array<'GET' | 'POST'>
    let last: Response | undefined
    for (const origin of origins) {
      for (const method of methods) {
        const call = buildBookmarkCall({ ...endpoint, origin, method }, variables, this.features())
        const response = await this.request(call.url, { method: call.method, headers: { ...this.headers(endpoint.bearer), ...call.headers } as Record<string, string>, body: call.body, redirect: 'follow', signal: AbortSignal.timeout(30_000) })
        last = response
        if (response.ok) {
          this.endpoint = { ...endpoint, origin, method: call.method, bearer: endpoint.bearer }
          return response
        }
        if (![404, 405].includes(response.status)) return response
      }
    }
    return last!
  }
  private features() {
    return {
      graphql_timeline_v2_bookmark_timeline: true,
      longform_notetweets_consumption_enabled: true, longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true, responsive_web_twitter_article_tweet_consumption_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true, responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false, responsive_web_enhance_cards_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true, tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      responsive_web_edit_tweet_api_enabled: true, graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: false, verified_phone_label_enabled: false, articles_preview_enabled: true,
      tweet_awards_web_tipping_enabled: false, freedom_of_speech_not_reach_fetch_enabled: true, standardized_nudges_misinfo: true
    }
  }
  private noteId(postId: string) { return `x-${this.account}-${postId}` }
  private imageRef(note: Note, asset: string) {
    return path.posix.relative(path.posix.dirname(note.path.replaceAll('\\', '/')), asset.replaceAll('\\', '/'))
  }
  private writePost(post: ArchivedPost) {
    const id = this.noteId(post.id)
    const existing = this.library.notes.get(id)
    const { title, body } = memoryMarkdown(post)
    if (!existing) {
      this.library.save({ id, kind: 'memory', title, body, author: post.author, source: post.url, partial: post.partial, capturedImages: [] })
      return { created: true, note: this.library.get(id) }
    }
    if (!existing.userEdited && (body.length > existing.body.length + 40 || (post.images.length > 0 && !/!\[[^\]]*]\([^)]+assets\//.test(existing.body) && !(existing.capturedImages || []).length))) {
      this.library.save({ ...existing, title: title.length >= existing.title.length ? title : existing.title, body, partial: post.partial }, existing.hash)
    }
    return { created: false, note: this.library.get(id) }
  }
  needsEnrich(post: ArchivedPost) {
    const article = post.links.some(isArticleLink) || isArticleLink(post.text)
    return post.partial || (article && post.text.replace(/\s+/g, '').length < 160)
  }
  private async fetchTweetResult(id: string) {
    if (!this.tweetDetail?.id) return
    const variables = { tweetId: id, withCommunity: false, includePromotedContent: false, withVoice: false }
    const origins = [
      `https://x.com/i/api/graphql/${this.tweetDetail.id}/TweetResultByRestId`,
      `https://api.x.com/graphql/${this.tweetDetail.id}/TweetResultByRestId`
    ]
    for (const origin of origins) {
      for (const method of ['GET', 'POST'] as const) {
        const params = new URLSearchParams({ variables: JSON.stringify(variables), features: JSON.stringify(this.features()) })
        const url = method === 'GET' ? `${origin}?${params}` : origin
        const response = await this.request(url, {
          method,
          headers: { ...this.headers(this.tweetDetail.bearer), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
          body: method === 'POST' ? JSON.stringify({ variables, features: this.features(), queryId: this.tweetDetail.id }) : undefined,
          redirect: 'follow',
          signal: AbortSignal.timeout(30_000)
        })
        if (!response.ok) continue
        const json = await response.json() as Json
        const result = json.data?.tweetResult?.result || json.data?.tweet_result?.result || json.data?.tweetResults?.result
        const parsed = parseTweetResult(result)
        if (parsed) return parsed
      }
    }
  }
  private queueImages(state: Checkpoint, post: ArchivedPost, note: Note) {
    if (note.userEdited) return
    const captured = new Set(note.capturedImages || [])
    for (const url of post.images) {
      if (captured.has(url)) continue
      if (state.pendingImages.some(job => job.postId === post.id && job.url === url)) continue
      if (state.failedImages.some(job => job.postId === post.id && job.url === url)) continue
      state.pendingImages.push({ postId: post.id, url })
    }
  }
  private dropJob(state: Checkpoint, job: ImageJob, bucket: 'pending' | 'failed' | 'both' = 'both') {
    if (bucket !== 'failed') state.pendingImages = state.pendingImages.filter(item => item.postId !== job.postId || item.url !== job.url)
    if (bucket !== 'pending') state.failedImages = state.failedImages.filter(item => item.postId !== job.postId || item.url !== job.url)
  }
  private isImageBytes(bytes: Buffer) {
    if (bytes.length < 12) return false
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return true
    if (bytes[0] === 255 && bytes[1] === 216) return true
    if (bytes.subarray(0, 6).toString() === 'GIF87a' || bytes.subarray(0, 6).toString() === 'GIF89a') return true
    if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return true
    return false
  }
  private async readImageResponse(response: Response) {
    if (!response.ok) throw new Error(`图片 HTTP ${response.status || 0}`)
    const length = Number(response.headers.get('content-length') || 0)
    if (length > 20 * 1024 * 1024) throw new Error('图片超过 20 MiB')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > 20 * 1024 * 1024) throw new Error('图片超过 20 MiB')
    if (!this.isImageBytes(bytes)) throw new Error('返回的不是图片（可能是 AVIF/HTML）')
    return bytes
  }
  private async fetchImage(url: string) {
    const pull = (target: string, redirect: RequestRedirect) => this.request(target, { method: 'GET', headers: imageHeaders(), credentials: 'omit', redirect, signal: AbortSignal.timeout(30_000) })
    try { return await this.readImageResponse(await pull(url, 'follow')) } catch { /* Electron session.fetch may ignore follow; hop manually. */ }
    let current = url
    for (let hop = 0; hop < 5; hop++) {
      const response = await pull(current, 'manual')
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location') || response.headers.get('Location')
        if (!location) throw new Error('图片重定向缺少地址')
        current = new URL(location, current).href
        if (!allowedImage(current)) throw new Error('图片跳转到未允许的地址')
        continue
      }
      return this.readImageResponse(response)
    }
    throw new Error('图片重定向过多')
  }
  private async download(state: Checkpoint, job: ImageJob) {
    const current = this.library.notes.get(this.noteId(job.postId))
    if (!current || current.userEdited) { this.dropJob(state, job); return }
    if ((current.capturedImages || []).includes(job.url) && /!\[[^\]]*]\([^)]+assets\//.test(current.body)) { this.dropJob(state, job); return }
    let last = '图片下载失败'
    for (const candidate of imageCandidates(job.url)) {
      if (!allowedImage(candidate)) { last = '图片地址不在允许范围'; continue }
      try {
        const bytes = await this.fetchImage(candidate)
        const rel = this.library.addImage(bytes, job.postId)
        const fresh = this.library.get(current.id)
        const captured = [...new Set([...(fresh.capturedImages || []), job.url])]
        const body = fresh.body.includes(rel) ? fresh.body : `${fresh.body}\n\n![书签图片](${this.imageRef(fresh, rel)})`
        this.library.save({ ...fresh, body, capturedImages: captured }, fresh.hash)
        this.dropJob(state, job)
        this.progress.imagesDone += 1
        return
      } catch (error) { last = error instanceof Error ? error.message : last }
    }
    this.dropJob(state, job, 'pending')
    if (!state.failedImages.some(item => item.postId === job.postId && item.url === job.url)) state.failedImages.push({ ...job, reason: last })
    this.set(`正文已保存，附件待补抓（${state.failedImages.length}）`)
  }
  private async downloadAll(state: Checkpoint, jobs: ImageJob[]) {
    const groups = new Map<string, ImageJob[]>()
    for (const job of jobs) {
      const list = groups.get(job.postId) || []
      list.push(job)
      groups.set(job.postId, list)
    }
    const batches = [...groups.values()]
    let index = 0
    const worker = async () => {
      while (index < batches.length && !this.stopped) {
        const batch = batches[index++]
        if (!batch) break
        for (const job of batch) {
          if (this.stopped) break
          await this.download(state, job)
          this.store(state)
          if (!this.options.fast) await new Promise(r => setTimeout(r, 180 + Math.random() * 220))
        }
      }
    }
    await Promise.all([worker(), worker(), worker()])
  }
  async retryFailed() {
    if (this.running) return
    this.running = true
    this.stopped = false
    try {
      this.ensureAccount()
      if (!this.account) await this.verify()
      const state = this.load()
      const jobs = [...state.failedImages, ...state.pendingImages]
      state.pendingImages = jobs
      state.failedImages = []
      this.store(state)
      this.set(`正在补抓 ${jobs.length} 个附件`, { phase: 'images', imagesFailed: 0 })
      await this.downloadAll(state, jobs)
      this.set(this.stopped ? '附件补抓已暂停' : (state.failedImages.length ? `附件补抓结束，仍有 ${state.failedImages.length} 张失败` : '失败附件已补抓完成'), { phase: state.failedImages.length ? 'partial' : 'idle' })
    } catch (e) { this.set(e instanceof Error ? e.message : '附件补抓失败'); throw e }
    finally { this.running = false }
  }
  async scan() {
    if (this.running) return
    this.running = true
    this.stopped = false
    try {
      this.ensureAccount()
      if (!this.account) await this.verify()
      const endpoint = this.endpoint?.id ? this.endpoint : await this.discover()
      const state = this.load()
      const historical = !state.completedAt
      let cursor: string | undefined = historical ? state.cursor : undefined
      const visited = new Set<string>()
      this.set(historical ? (cursor ? '正在继续回溯历史…' : '正在回溯历史书签…') : '正在扫描新增书签…', { phase: historical ? 'history' : 'incremental' })
      do {
        await this.wait()
        const variables = { count: 20, includePromotedContent: false, ...(cursor ? { cursor } : {}) }
        const response = await this.requestBookmarks(endpoint, variables)
        await this.check(response)
        const page = parseBookmarkPage(await response.json() as Json)
        for (const post of page.posts) {
          if (this.stopped) break
          let current = post
          if (this.needsEnrich(post)) {
            this.set(`正在补取长文 ${post.id}`)
            if (!this.options.fast) await this.wait()
            const detailed = await this.fetchTweetResult(post.id)
            if (detailed) current = { ...post, ...detailed, id: post.id, author: detailed.author || post.author }
          }
          const { created, note } = this.writePost(current)
          if (created) state.count++
          this.queueImages(state, current, note)
          state.lastSuccessAt = new Date().toISOString()
          this.store(state)
          this.set(`已处理 ${state.count} 条，${cursor ? '继续回溯' : '扫描最新一页'}`, { found: state.count, saved: this.progress.saved, lastSuccessAt: state.lastSuccessAt, cursor })
        }
        if (this.stopped) break
        if (page.cursor && (page.cursor === cursor || visited.has(page.cursor))) throw new Error('X 重复返回分页位置，已停止以避免循环')
        if (page.cursor) visited.add(page.cursor)
        cursor = page.cursor
        state.cursor = cursor
        if (!cursor || page.terminated) state.completedAt = new Date().toISOString()
        this.store(state)
        const jobs = [...state.pendingImages]
        this.set(jobs.length ? `正在下载 ${jobs.length} 张图片/封面` : this.status, { phase: jobs.length ? 'images' : this.progress.phase })
        await this.downloadAll(state, jobs)
      } while (cursor && !this.stopped)
      this.set(this.stopped ? '采集已暂停，进度已保留' : `本次遍历完成，已处理 ${state.count} 条`, { phase: this.stopped ? 'paused' : 'complete', cursor: state.cursor, found: state.count })
    } catch (e) { this.set(e instanceof Error ? e.message : '采集失败'); throw e }
    finally { this.running = false }
  }
}
