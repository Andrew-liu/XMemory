import type { Note } from '../shared/types'

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

const IMAGE_HOSTS = new Set(['pbs.twimg.com', 'abs.twimg.com', 'video.twimg.com', 'ton.twimg.com'])
export function allowedImage(url: string) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && IMAGE_HOSTS.has(parsed.hostname) && !/\.(mp4|m3u8)(\?|$)/i.test(parsed.pathname)
  } catch { return false }
}

export function imageCandidates(url: string) {
  const urls: string[] = []
  try {
    const parsed = new URL(url)
    parsed.pathname = parsed.pathname.replace(/:(orig|large|medium|small|thumb|360x360|900x900)$/i, '')
    if (parsed.hostname === 'pbs.twimg.com' || parsed.hostname === 'ton.twimg.com') {
      const ext = parsed.pathname.match(/\.(jpg|jpeg|png|webp|gif)$/i)?.[1]?.toLowerCase() || parsed.searchParams.get('format') || 'jpg'
      parsed.searchParams.set('format', ext === 'jpeg' ? 'jpg' : ext)
      for (const name of ['orig', 'large', 'medium']) {
        parsed.searchParams.set('name', name)
        urls.push(parsed.href)
      }
    }
  } catch { /* Keep the original URL. */ }
  urls.push(url)
  return [...new Set(urls)]
}

export function dedupeImages(urls: string[]) {
  const groups = new Map<string, string[]>()
  for (const url of urls) {
    let key = url
    try {
      const parsed = new URL(url)
      key = parsed.hostname + parsed.pathname.replace(/:(orig|large|medium|small|thumb|360x360|900x900)$/i, '').replace(/\.(jpg|jpeg|png|webp|gif)$/i, '')
    } catch { /* Keep unparseable URLs under their own key. */ }
    const group = groups.get(key)
    if (group) group.push(url)
    else groups.set(key, [url])
  }
  const result: string[] = []
  for (const group of groups.values()) {
    result.push(group.find(url => { try { return new URL(url).searchParams.get('name') === 'orig' } catch { return false } }) || group[0])
  }
  return result
}

const POST_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'mobile.x.com'])
export function normalizePostUrl(input: string): { url: string; id: string; user?: string } | undefined {
  let parsed: URL
  try { parsed = new URL(input.trim()) } catch { return }
  if (parsed.protocol !== 'https:' || !POST_HOSTS.has(parsed.hostname)) return
  if (parsed.username || parsed.password || parsed.port) return
  const path = parsed.pathname.replace(/\/$/, '')
  const web = path.match(/^\/i\/web\/status\/(\d+)$/)
  if (web) {
    if (web[1].length > 25) return
    return { url: `https://x.com/i/web/status/${web[1]}`, id: web[1] }
  }
  const match = path.match(/^\/([A-Za-z0-9_]{1,15})\/(status|article)\/(\d+)$/)
  if (!match) return
  const [, user, , id] = match
  if (user.toLowerCase() === 'i' || id.length > 25) return
  return { url: `https://x.com/${user}/status/${id}`, id, user }
}

export function isArticleLink(value: string) {
  return /(?:x\.com|twitter\.com)\/i\/article\/\d+/i.test(value)
}

export function extractArticleImages(article: Json | undefined) {
  if (!article || typeof article !== 'object') return []
  const urls: string[] = []
  const take = (node: Json | undefined) => {
    const url = node?.media_info?.original_img_url || node?.media_info?.preview_image?.original_img_url || node?.media_info?.url || node?.original_img_url
    if (typeof url === 'string') urls.push(url)
  }
  take(article.cover_media)
  const entities = article.media_entities
  if (Array.isArray(entities)) for (const item of entities) take(item)
  else if (entities && typeof entities === 'object') for (const item of Object.values(entities)) take(item as Json)
  return urls
}

function decodeEntities(text: string) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

export function parseTweetResult(input: Json | undefined, fallbackAuthor?: string): ArchivedPost | undefined {
  if (!input) return
  const result: Json = input.tweet || input
  const legacy = result.legacy
  if (!legacy || !/^\d+$/.test(result.rest_id)) return
  const found = result.core?.user_results?.result?.legacy?.screen_name || result.core?.user_results?.result?.core?.screen_name || 'unknown'
  const author = found === 'unknown' && fallbackAuthor ? fallbackAuthor : found
  const note = result.note_tweet?.note_tweet_results?.result
  let text = typeof note?.text === 'string' && note.text ? note.text : legacy.full_text || ''
  const urlEntities: Json[] = (typeof note?.text === 'string' && note.text ? note.entity_set?.urls : legacy.entities?.urls) || []
  for (const entity of urlEntities) {
    if (typeof entity?.url === 'string' && typeof entity?.expanded_url === 'string') text = text.split(entity.url).join(entity.expanded_url)
  }
  const media = legacy.extended_entities?.media || legacy.entities?.media || []
  const images: string[] = []
  let videoCover = false
  for (const item of media) {
    if (typeof item?.url === 'string') text = text.split(item.url).join('')
    if (item?.type === 'video' || item?.type === 'animated_gif') {
      videoCover = true
      if (typeof item.media_url_https === 'string') images.push(item.media_url_https)
      continue
    }
    if (typeof item.media_url_https === 'string') images.push(item.media_url_https)
  }
  text = decodeEntities(text).replace(/\s+$/, '').trim()
  const card = result.card?.legacy?.binding_values || []
  for (const value of card) if (/image/i.test(value.key || '') && value.value?.image_value?.url) images.push(value.value.image_value.url)
  const article = result.article?.article_results?.result || result.article
  images.push(...extractArticleImages(article))
  const links = urlEntities.map((u: Json) => u.expanded_url || u.url).filter((u: unknown): u is string => typeof u === 'string' && !/\.(mp4|m3u8)(\?|$)/i.test(u))
  const articleLinked = !!article || links.some(isArticleLink) || isArticleLink(text)
  const published = typeof legacy.created_at === 'string' ? new Date(legacy.created_at) : undefined
  return {
    id: result.rest_id,
    text,
    author,
    url: `https://x.com/${author}/status/${result.rest_id}`,
    images: dedupeImages(images.filter(allowedImage)),
    links,
    publishedAt: published && !Number.isNaN(published.getTime()) ? published.toISOString() : undefined,
    partial: (!!legacy.truncated && !note?.text) || articleLinked,
    videoCover
  }
}

export interface ArticleContent {
  title: string
  markdown: string
  images: string[]
  coverUrl?: string
  partialReasons: string[]
  blockCount: number
}

export function articleFromContentState(article: Json | undefined, _url?: string): ArticleContent | undefined {
  if (!article || typeof article !== 'object') return
  const state = article.content_state
  const blocks: Json[] = Array.isArray(state?.blocks) ? state.blocks : []
  if (!state || typeof state !== 'object') return
  if (!blocks.some(block => block?.type !== 'atomic' && typeof block?.text === 'string' && block.text.trim())) return
  const entityMap = state.entityMap
  const reasons: string[] = []
  const findEntity = (key: unknown): Json | undefined => {
    if (Array.isArray(entityMap)) {
      const entry = entityMap.find(item => String(item?.key) === String(key))
      return entry?.value && typeof entry.value === 'object' ? entry.value as Json : undefined
    }
    if (entityMap && typeof entityMap === 'object') {
      const value = entityMap[String(key)]
      return value && typeof value === 'object' ? value as Json : undefined
    }
  }
  const mediaRef = (mediaId: unknown): { url?: string; video: boolean } | undefined => {
    const entities = Array.isArray(article.media_entities) ? article.media_entities : []
    const item = entities.find((m: Json) => String(m?.media_id) === String(mediaId))
    const info = item?.media_info
    const imageUrl = info?.original_img_url
    if (typeof imageUrl === 'string' && allowedImage(imageUrl)) return { url: imageUrl, video: false }
    if (info?.__typename === 'ApiVideo' || info?.__typename === 'ApiGif') {
      const preview = info?.preview_image?.original_img_url
      return { url: typeof preview === 'string' && allowedImage(preview) ? preview : undefined, video: true }
    }
    return undefined
  }
  const trimRange = (text: string, offset = 0, length = 0): [number, number] => {
    let start = Math.max(0, Math.min(text.length, Number(offset) || 0))
    let end = Math.max(start, Math.min(text.length, start + (Number(length) || 0)))
    while (start < end && /\s/.test(text[start])) start++
    while (end > start && /\s/.test(text[end - 1])) end--
    return [start, end]
  }
  const inline = (text: string, styles: Json[], ranges: Json[]) => {
    // rank: outer wrappers (links) sort before inner styles when ranges share a boundary.
    const opens = new Map<number, Array<{ rank: number; start: number; mark: string }>>()
    const closes = new Map<number, Array<{ rank: number; start: number; mark: string }>>()
    const add = (map: Map<number, Array<{ rank: number; start: number; mark: string }>>, at: number, rank: number, start: number, mark: string) => {
      const list = map.get(at) || []
      list.push({ rank, start, mark })
      map.set(at, list)
    }
    for (const range of Array.isArray(ranges) ? ranges : []) {
      const entity = findEntity(range?.key)
      if (!entity) continue
      if (entity.type === 'LINK' && typeof entity.data?.url === 'string' && entity.data.url.startsWith('https://')) {
        const [start, end] = trimRange(text, range.offset, range.length)
        if (start >= end) continue
        let href = entity.data.url
        try {
          if (new URL(href).hostname === 't.co') {
            const anchor = text.slice(start, end).trim()
            try { if (new URL(anchor).protocol === 'https:') href = anchor } catch { /* Anchor is plain text, keep the short link. */ }
          }
        } catch { /* Keep the entity URL when it cannot be parsed. */ }
        add(closes, end, 0, start, `](${href})`)
        add(opens, start, 0, start, '[')
      } else if (entity.type === 'TWEMOJI') {
        // The emoji character is already part of the block text; the svg link adds nothing.
      } else {
        reasons.push(`unknown-entity:${String(entity.type || 'UNKNOWN')}`)
      }
    }
    for (const style of Array.isArray(styles) ? styles : []) {
      const mark = style?.style === 'Bold' ? '**' : style?.style === 'Italic' ? '*' : ''
      if (!mark) continue
      const [start, end] = trimRange(text, style.offset, style.length)
      if (start >= end) continue
      add(closes, end, 1, start, mark)
      add(opens, start, 1, start, mark)
    }
    let out = text
    for (const at of [...new Set([...opens.keys(), ...closes.keys()])].sort((a, b) => b - a)) {
      const close = (closes.get(at) || []).sort((a, b) => b.rank - a.rank || b.start - a.start).map(item => item.mark).join('')
      const open = (opens.get(at) || []).sort((a, b) => a.rank - b.rank || a.start - b.start).map(item => item.mark).join('')
      out = out.slice(0, at) + close + open + out.slice(at)
    }
    return out
  }
  const bodyImages: string[] = []
  const emit: Array<{ text: string; list?: 'ul' | 'ol' }> = []
  let ordered = 0
  for (const block of blocks) {
    const type = String(block?.type || '')
    if (type === 'ordered-list-item') ordered += 1
    else ordered = 0
    if (type === 'atomic') {
      for (const range of Array.isArray(block?.entityRanges) ? block.entityRanges : []) {
        const entity = findEntity(range?.key)
        const entityType = String(entity?.type || '')
        if (entityType === 'MEDIA') {
          const items = Array.isArray(entity?.data?.mediaItems) ? entity.data.mediaItems : []
          const parts: string[] = []
          let unresolved = 0
          for (const item of items) {
            const ref = mediaRef(item?.mediaId)
            if (!ref) { unresolved++; continue }
            if (ref.video) {
              if (ref.url) { bodyImages.push(ref.url); parts.push(`![X 视频封面](${ref.url})`) }
              parts.push('> 视频未下载，仅保留封面，请打开原文观看。')
            } else {
              bodyImages.push(ref.url!)
              parts.push(`![X 图片](${ref.url})`)
            }
          }
          if (parts.length) emit.push({ text: parts.join('\n') })
          if (unresolved) reasons.push('media-unresolved')
        } else if (entityType === 'MARKDOWN') {
          const markdown = typeof entity?.data?.markdown === 'string' ? entity.data.markdown.trim() : ''
          if (markdown) emit.push({ text: markdown })
        } else if (entityType === 'DIVIDER') {
          emit.push({ text: '---' })
        } else if (entityType === 'TWEET') {
          const tweetId = String(entity?.data?.tweetId || '')
          if (/^\d+$/.test(tweetId)) emit.push({ text: `<https://x.com/i/web/status/${tweetId}>` })
          else reasons.push('unknown-entity:TWEET')
        } else {
          reasons.push(`unknown-entity:${entityType || 'UNKNOWN'}`)
        }
      }
      continue
    }
    const content = inline(String(block?.text || ''), block?.inlineStyleRanges, block?.entityRanges).trim()
    if (!content) continue
    if (type === 'unstyled') emit.push({ text: content })
    else if (type === 'header-one' || type === 'header-two') emit.push({ text: `## ${content}` })
    else if (type === 'header-three') emit.push({ text: `### ${content}` })
    else if (type === 'unordered-list-item') emit.push({ text: `- ${content}`, list: 'ul' })
    else if (type === 'ordered-list-item') emit.push({ text: `${ordered}. ${content}`, list: 'ol' })
    else if (type === 'blockquote') emit.push({ text: content.split('\n').map(line => `> ${line}`).join('\n') })
    else if (type === 'code-block') emit.push({ text: `\`\`\`\n${content}\n\`\`\`` })
    else {
      emit.push({ text: content })
      reasons.push(`unknown-block:${type}`)
    }
  }
  const body = emit.map((segment, index) => `${index > 0 ? (segment.list && segment.list === emit[index - 1].list ? '\n' : '\n\n') : ''}${segment.text}`).join('')
  if (!body) return
  const title = typeof article.title === 'string' ? article.title.trim() : ''
  const cover = article.cover_media?.media_info?.original_img_url
  const coverUrl = typeof cover === 'string' && allowedImage(cover) ? cover : undefined
  const markdown = [title ? `# ${title}` : '', coverUrl ? `![X 封面](${coverUrl})` : '', body].filter(Boolean).join('\n\n')
  return { title, markdown, images: dedupeImages([coverUrl, ...bodyImages].filter((url): url is string => !!url)), coverUrl, partialReasons: [...new Set(reasons)], blockCount: blocks.length }
}

export interface ArticleDomBlock {
  type: 'text' | 'image' | 'link'
  text?: string
  markdown?: string
  url?: string
  tag?: string
  fontSize?: number
}

function articleDomBlockKey(block: ArticleDomBlock) {
  return block.type === 'image' || block.type === 'link'
    ? `${block.type}:${block.url || ''}`
    : `text:${block.tag || ''}:${block.markdown || block.text || ''}`
}

export function mergeArticleDomBlocks(current: ArticleDomBlock[], incoming: ArticleDomBlock[]) {
  if (current.length === 0) return [...incoming]
  const merged = [...current]
  for (let index = 0; index < incoming.length; index++) {
    const block = incoming[index]
    const key = articleDomBlockKey(block)
    if (merged.some(item => articleDomBlockKey(item) === key)) continue
    let insertAt = -1
    for (let previous = index - 1; previous >= 0; previous--) {
      const known = merged.findIndex(item => articleDomBlockKey(item) === articleDomBlockKey(incoming[previous]))
      if (known >= 0) {
        insertAt = known + 1
        break
      }
    }
    if (insertAt < 0) {
      for (let next = index + 1; next < incoming.length; next++) {
        const known = merged.findIndex(item => articleDomBlockKey(item) === articleDomBlockKey(incoming[next]))
        if (known >= 0) {
          insertAt = known
          break
        }
      }
    }
    merged.splice(insertAt < 0 ? merged.length : insertAt, 0, block)
  }
  return merged
}

export function articleDomMarkdown(title: string, blocks: ArticleDomBlock[]) {
  const body = blocks.map(block => {
    if (block.type === 'image') return block.url ? `![X 图片](${block.url})` : ''
    if (block.type === 'link') return block.url ? `<${block.url}>` : ''
    const text = (block.markdown || block.text || '').trim()
    if (!text) return ''
    if (/^H[1-6]$/.test(block.tag || '') || (block.fontSize || 0) >= 21) return `## ${text}`
    if (block.tag === 'BLOCKQUOTE') return text.split('\n').map(line => `> ${line}`).join('\n')
    if (block.tag === 'LI') return `- ${text}`
    if (block.tag === 'PRE') return `\`\`\`\n${block.text || text}\n\`\`\``
    return text
  }).filter(Boolean)
  return [title ? `# ${title}` : '', ...body].filter(Boolean).join('\n\n')
}

export function replaceCapturedImages(body: string, replacements: Record<string, string>) {
  for (const [url, relative] of Object.entries(replacements)) body = body.replaceAll(`(${url})`, `(${relative})`)
  return body
}

export function updatedCaptureBody(existing: Pick<Note, 'body' | 'userEdited' | 'partial'>, remote: string, localized: string, replacements: Record<string, string>, incomingPartial = false) {
  const hasNotes = !!existing.body.split(/^# 我的笔记\s*$/m).slice(1).join('').trim()
  if (!existing.userEdited && !hasNotes && (remote.length >= existing.body.length || (existing.partial === true && !incomingPartial))) return localized
  return replaceCapturedImages(existing.body, replacements)
}

function findTweet(node: unknown, id: string, seen = new Set<unknown>()): Json | undefined {
  if (!node || typeof node !== 'object' || seen.has(node)) return
  seen.add(node)
  const value = node as Json
  if (String(value.rest_id || '') === id && value.legacy) return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTweet(item, id, seen)
      if (found) return found
    }
    return
  }
  for (const child of Object.values(value)) {
    const found = findTweet(child, id, seen)
    if (found) return found
  }
}

export interface CapturedTarget {
  post: ArchivedPost
  markdown: string
  structured: Record<string, unknown>
  articleResult?: ArticleContent
  articleTitle?: string
}

export function captureFromPayload(payload: unknown, id: string, fallbackAuthor?: string, sourceUrl?: string): CapturedTarget | undefined {
  const result = findTweet(payload, id)
  const post = parseTweetResult(result, fallbackAuthor)
  if (!post) return
  if (sourceUrl && (!sourceUrl.includes('/i/web/status/') || post.author === 'unknown')) post.url = sourceUrl
  const article = result?.article?.article_results?.result || result?.article
  const articleResult = articleFromContentState(article)
  const reasons: string[] = []
  if (articleResult) {
    post.text = articleResult.markdown
    post.images = articleResult.images
    reasons.push(...articleResult.partialReasons)
    post.partial = reasons.length > 0
  } else if (article || post.links.some(isArticleLink) || isArticleLink(post.text)) {
    post.partial = true
    reasons.push('content-state-missing')
  }
  const coverImage = articleResult?.coverUrl || extractArticleImages(article)[0]
  const markdown = [
    '# X 原文',
    post.text,
    ...post.links.filter(link => !post.text.includes(link)).map(link => `<${link}>`),
    ...(articleResult ? [] : post.images.map((image, index) => `![X 图片 ${index + 1}](${image})`)),
    post.videoCover ? '> 视频未下载，仅保留封面和原文链接。' : '',
    post.partial ? '> 正文可能不完整，尚未取得可核验的完整结构。' : '',
    `[原文](${post.url})`,
    '# 我的笔记',
    ''
  ].filter(value => value !== '').join('\n\n')
  return {
    post,
    markdown,
    articleResult,
    articleTitle: articleResult?.title,
    structured: {
      schemaVersion: 2,
      captureMethod: 'cdp-response',
      contentStatus: post.partial ? 'partial' : 'complete',
      partialReasons: [...new Set(reasons)],
      coverImage,
      source: post.url,
      postId: post.id,
      author: post.author,
      text: post.text,
      links: post.links,
      images: post.images,
      publishedAt: post.publishedAt,
      videoCover: post.videoCover,
      article: article ? { title: article.title, contentState: article.content_state, mediaEntities: article.media_entities, coverMedia: article.cover_media } : undefined
    }
  }
}

export function memoryTitle(post: ArchivedPost, articleTitle?: string) {
  const article = articleTitle?.trim()
  if (article) return article.slice(0, 80)
  const line = (post.text.split('\n').find(item => item.trim()) || '')
    .replace(/^[#>\s]+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return line.slice(0, 80) || `X 内容 ${post.id}`
}

const isTweet = (result: Json | undefined): result is Json => !!result && /^\d+$/.test(String(result.rest_id || '')) && !!result.legacy
export function bookmarkEntries(payload: unknown): { found: boolean; tweets: Json[]; unavailable: number; bottomCursor?: string; errors: string[] } {
  const root = payload as Json | undefined
  const errors: string[] = []
  if (Array.isArray(root?.errors)) for (const error of root.errors) errors.push(String(error?.message || error?.code || '未知错误'))
  const instructions = root?.data?.bookmark_timeline_v2?.timeline?.instructions
  if (!Array.isArray(instructions)) return { found: false, tweets: [], unavailable: 0, errors }
  const tweets: Json[] = []
  let unavailable = 0
  let bottomCursor: string | undefined
  for (const instruction of instructions) {
    if (instruction?.type !== 'TimelineAddEntries' || !Array.isArray(instruction.entries)) continue
    for (const entry of instruction.entries) {
      const content = entry?.content
      if (content?.entryType === 'TimelineTimelineCursor') {
        if (content?.cursorType === 'Bottom' && typeof content?.value === 'string') bottomCursor = content.value
        continue
      }
      const item = content?.itemContent
      if (!item || item.itemType !== 'TimelineTweet' || item.promotedMetadata) continue
      const result = item.tweet_results?.result
      if (result?.__typename === 'TweetWithVisibilityResults') {
        if (isTweet(result.tweet)) tweets.push(result.tweet)
        else unavailable++
        continue
      }
      if (result?.__typename === 'TweetTombstone' || result?.__typename === 'TweetUnavailable') { unavailable++; continue }
      if (isTweet(result)) tweets.push(result)
      else unavailable++
    }
  }
  return { found: true, tweets, unavailable, bottomCursor, errors }
}
