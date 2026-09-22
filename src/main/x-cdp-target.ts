import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page, type Response } from 'playwright'
import type { ArchiveProgress, Note } from '../shared/types'
import { atomic, Library } from './library'
import { allowedImage, parseTweetResult, type ArchivedPost } from './x-source'

export const TARGET_POSTS = [
  'https://x.com/xueyu1125/status/2099104432596328908',
  'https://x.com/xueyu1125/status/2099446491094175744'
] as const

export const X_LOGIN_URL = 'https://x.com/i/flow/login'

export function chromeArgs(profile: string, mode: 'login' | 'cdp') {
  const common = [
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,900'
  ]
  return mode === 'login'
    ? [...common, '--window-position=80,80', X_LOGIN_URL]
    : [...common, '--window-position=-10000,40', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', 'about:blank']
}

interface CapturedTarget {
  post: ArchivedPost
  markdown: string
  structured: Record<string, unknown>
}

// Navigation uses Chrome's own network stack, including its system proxy.
// BrowserContext.request is a separate HTTP client and does not inherit that path.
export async function downloadChromeImage(context: BrowserContext, url: string): Promise<Buffer> {
  const valid = (value: string) => {
    try { const parsed = new URL(value); return allowedImage(value) && !parsed.username && !parsed.password && !parsed.port } catch { return false }
  }
  if (!valid(url)) throw new Error('图片地址不在允许范围')
  const page = await context.newPage()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await page.route('**/*', route => valid(route.request().url()) ? route.fallback() : route.abort())
    const read = async () => {
      const response = await page.goto(url, { timeout: 30_000, waitUntil: 'load' })
      if (!response || !valid(response.url())) throw new Error('图片跳转到未允许的地址')
      if (!response.ok()) throw new Error(`图片服务返回 HTTP ${response.status()}`)
      if (Number(response.headers()['content-length']) > 20 * 1024 * 1024) throw new Error('图片超过 20 MiB')
      const bytes = await response.body()
      if (bytes.length > 20 * 1024 * 1024) throw new Error('图片超过 20 MiB')
      return bytes
    }
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Chrome 图片下载超时')), 30_000)
    })])
  } finally {
    clearTimeout(timer)
    await page.close().catch(() => {})
  }
}

export function replaceCapturedImages(body: string, replacements: Record<string, string>) {
  for (const [url, relative] of Object.entries(replacements)) body = body.replaceAll(`(${url})`, `(${relative})`)
  return body
}

export function updatedCaptureBody(existing: Pick<Note, 'body' | 'userEdited'>, remote: string, localized: string, replacements: Record<string, string>) {
  const hasNotes = !!existing.body.split(/^# 我的笔记\s*$/m).slice(1).join('').trim()
  if (!existing.userEdited && !hasNotes && remote.length >= existing.body.length) return localized
  return replaceCapturedImages(existing.body, replacements)
}

type Json = Record<string, any>

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

export function targetPostId(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'x.com' || url.username || url.password || url.search || url.hash) return
    const match = url.pathname.match(/^\/xueyu1125\/status\/(2099104432596328908|2099446491094175744)\/?$/)
    return match?.[1]
  } catch { return }
}

export type TargetSaveResult = 'created' | 'updated' | 'unchanged'
export function tallyTargetResults(results: TargetSaveResult[]) {
  return {
    created: results.filter(result => result === 'created').length,
    updated: results.filter(result => result === 'updated').length,
    unchanged: results.filter(result => result === 'unchanged').length
  }
}

function blockText(block: Json) {
  if (typeof block?.text === 'string') return block.text.trim()
  if (Array.isArray(block?.children)) return block.children.map((item: Json) => typeof item?.text === 'string' ? item.text : '').join('').trim()
  return ''
}

export function articleMarkdown(article: Json | undefined) {
  if (!article || typeof article !== 'object') return ''
  const title = typeof article.title === 'string' ? article.title.trim() : ''
  const blocks = Array.isArray(article.content?.blocks) ? article.content.blocks : []
  const lines: string[] = []
  for (const block of blocks) {
    const text = blockText(block)
    if (!text) continue
    const type = String(block.type || '').toLowerCase()
    if (/header|heading/.test(type)) lines.push(`## ${text}`)
    else if (/unordered|bullet/.test(type)) lines.push(`- ${text}`)
    else if (/ordered|number/.test(type)) lines.push(`1. ${text}`)
    else if (/blockquote|quote/.test(type)) lines.push(text.split('\n').map((line: string) => `> ${line}`).join('\n'))
    else if (/code/.test(type)) lines.push(`\`\`\`\n${text}\n\`\`\``)
    else lines.push(text)
  }
  const plain = typeof article.plain_text === 'string' ? article.plain_text.trim() : ''
  const preview = typeof article.preview_text === 'string' ? article.preview_text.trim() : ''
  const body = lines.join('\n\n') || plain || preview
  return [title ? `# ${title}` : '', body].filter(Boolean).join('\n\n')
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

export function captureFromPayload(payload: unknown, id: string): CapturedTarget | undefined {
  const result = findTweet(payload, id)
  const post = parseTweetResult(result)
  if (!post) return
  const article = result?.article?.article_results?.result || result?.article
  const rich = articleMarkdown(article)
  if (rich && rich.replace(/[#\s]/g, '').length > post.text.replace(/\s/g, '').length) post.text = rich
  post.url = TARGET_POSTS.find(url => targetPostId(url) === id) || post.url
  const blocks = Array.isArray(article?.content?.blocks) ? article.content.blocks : []
  const isArticle = !!article || post.links.some(link => /\/i\/article\//.test(link))
  post.partial = isArticle ? blocks.length === 0 && !article?.plain_text : post.partial
  const markdown = [
    '# X 原文',
    post.text,
    ...post.links.filter(link => !post.text.includes(link)).map(link => `<${link}>`),
    ...post.images.map((image, index) => `![X 图片 ${index + 1}](${image})`),
    post.videoCover ? '> 视频未下载，仅保留封面和原文链接。' : '',
    post.partial ? '> 正文可能不完整，尚未取得可核验的完整结构。' : '',
    `[原文](${post.url})`,
    '# 我的笔记',
    ''
  ].filter(value => value !== '').join('\n\n')
  return {
    post,
    markdown,
    structured: {
      schemaVersion: 1,
      captureMethod: 'cdp-response',
      contentStatus: post.partial ? 'partial' : 'complete',
      source: post.url,
      postId: post.id,
      author: post.author,
      text: post.text,
      links: post.links,
      images: post.images,
      publishedAt: post.publishedAt,
      videoCover: post.videoCover,
      article: article ? { title: article.title, blocks, mediaEntities: article.media_entities } : undefined
    }
  }
}

function chromeCandidates() {
  const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter((value): value is string => !!value)
  return roots.flatMap(root => [
    path.join(root, 'Google/Chrome/Application/chrome.exe'),
    path.join(root, 'Google/Chrome Beta/Application/chrome.exe')
  ])
}

export function findChrome() {
  return chromeCandidates().find(existsSync)
}

async function waitForFile(file: string, process: ChildProcess) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error('Chrome 启动失败，请关闭占用专属 Profile 的 Chrome 后重试')
    if (existsSync(file)) {
      const [port] = readFileSync(file, 'utf8').trim().split(/\r?\n/)
      if (/^\d+$/.test(port)) return port
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('未取得 Chrome 调试端点，请检查 Chrome 安装或安全软件拦截')
}

function accountFromCookies(cookies: Array<{ name: string; value: string }>) {
  const twid = cookies.find(cookie => cookie.name === 'twid')?.value || ''
  const match = decodeURIComponent(twid).match(/u=(\d+)/)
  return match?.[1] || 'cdp'
}

export class CdpTargetArchive {
  status = 'CDP 测试模式：仅允许采集两条指定内容'
  progress: ArchiveProgress = { phase: 'idle', found: 0, saved: 0, imagesDone: 0, imagesFailed: 0 }
  loggedIn = false
  private process?: ChildProcess
  private loginProcess?: ChildProcess
  private browser?: Browser
  private context?: BrowserContext
  private page?: Page
  private running = false
  private flowActive = false
  private stopped = false

  constructor(private library: Library, private userData: string, private change: () => void) {}

  private set(status: string, extra: Partial<ArchiveProgress> = {}) {
    this.status = status
    this.progress = { ...this.progress, ...extra }
    this.change()
  }

  private async start() {
    if (this.browser?.isConnected() && this.context) return this.context
    const executable = findChrome()
    if (!executable) throw new Error('未找到 Google Chrome，请先安装正式版 Chrome')
    const profile = path.join(this.userData, 'x-cdp-profile')
    mkdirSync(profile, { recursive: true })
    const portFile = path.join(profile, 'DevToolsActivePort')
    if (existsSync(portFile)) rmSync(portFile, { force: true })
    this.process = spawn(executable, chromeArgs(profile, 'cdp'), { stdio: 'ignore', windowsHide: false })
    const port = await waitForFile(portFile, this.process)
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    this.context = this.browser.contexts()[0]
    if (!this.context) throw new Error('未取得 Chrome Profile 上下文')
    this.page = this.context.pages()[0] || await this.context.newPage()
    return this.context
  }

  private async refreshLogin() {
    const context = await this.start()
    const cookies = await context.cookies('https://x.com')
    this.loggedIn = cookies.some(cookie => cookie.name === 'auth_token')
    return this.loggedIn
  }

  async restore() {
    const profile = path.join(this.userData, 'x-cdp-profile')
    this.loggedIn = false
    this.set(existsSync(profile) ? '已找到 Chrome 专属 Profile；点击“检查登录”联网确认' : '请在 Chrome 中登录 X；当前只会采集两条测试内容')
  }

  private async placeWindow(left: number) {
    if (!this.page) return
    const session = await this.page.context().newCDPSession(this.page)
    try {
      const { windowId } = await session.send('Browser.getWindowForTarget')
      await session.send('Browser.setWindowBounds', { windowId, bounds: { left, top: 40, width: 1200, height: 900, windowState: 'normal' } })
    } finally { await session.detach().catch(() => {}) }
  }

  private async hideWindow() { await this.placeWindow(-10000) }
  async showWindow() {
    await this.start()
    await this.placeWindow(80)
    await this.page?.bringToFront()
    this.set('已显示 Chrome；可检查登录状态或处理 X 验证')
  }

  async checkLogin() {
    await this.start()
    const ready = await this.refreshLogin()
    this.set(ready ? 'Chrome 专属 Profile 登录有效；可采集两条测试内容' : 'Chrome 专属 Profile 尚未登录，请点击采集后完成登录')
    if (ready) await this.hideWindow().catch(() => {})
    else {
      await this.placeWindow(80)
      await this.page?.bringToFront()
    }
    return ready
  }

  async login() {
    this.stopped = false
    if (this.browser?.isConnected() || (this.process && this.process.exitCode === null)) await this.disconnect()
    this.stopped = false
    const executable = findChrome()
    if (!executable) throw new Error('未找到 Google Chrome，请先安装正式版 Chrome')
    const profile = path.join(this.userData, 'x-cdp-profile')
    mkdirSync(profile, { recursive: true })
    this.loginProcess = spawn(executable, chromeArgs(profile, 'login'), { stdio: 'ignore', windowsHide: false })
    this.set('请在普通 Chrome 中完成 X 登录；成功后关闭该 Chrome，将自动继续采集', { phase: 'connecting' })
    await new Promise<void>((resolve, reject) => {
      this.loginProcess!.once('error', reject)
      this.loginProcess!.once('exit', () => resolve())
    })
    this.loginProcess = undefined
    if (this.stopped) throw new Error('登录流程已暂停')
    this.set('Chrome 已关闭；可检查登录或直接采集', { phase: 'idle' })
  }

  async collectWithLogin() {
    if (this.flowActive || this.running) throw new Error('登录或采集流程正在进行中')
    this.flowActive = true
    this.stopped = false
    try {
      let ready = false
      try { ready = await this.refreshLogin() } catch { ready = false }
      if (!ready) {
        await this.login()
        ready = await this.refreshLogin()
      }
      if (!ready) {
        this.set('未检测到有效 X 登录，请重新点击采集并完成登录', { phase: 'idle' })
        throw new Error('未检测到有效 X 登录，未开始采集')
      }
      await this.hideWindow().catch(() => {})
      return await this.collectTargets()
    } finally { this.flowActive = false }
  }

  private async localizeImages(captured: CapturedTarget, account: string) {
    if (!this.context) throw new Error('Chrome 尚未连接，无法保存图片')
    let markdown = captured.markdown
    const downloaded: string[] = []
    let failed = 0
    const replacements: Record<string, string> = {}
    const failures: string[] = []
    const noteId = `x-${account}-${captured.post.id}`
    const notePath = this.library.notes.get(noteId)?.path || (/^\d+$/.test(account) ? `memories/${account}/${captured.post.id}.md` : `memories/${noteId}.md`)
    for (const url of captured.post.images) {
      if (this.stopped) throw new Error('测试采集已暂停')
      if (!allowedImage(url)) continue
      try {
        const bytes = await downloadChromeImage(this.context, url)
        const asset = this.library.addImage(bytes, captured.post.id)
        const relative = path.posix.relative(path.posix.dirname(notePath), asset)
        replacements[url] = relative
        markdown = markdown.replaceAll(`(${url})`, `(${relative})`)
        downloaded.push(url)
        this.progress.imagesDone += 1
      } catch (error) {
        failed += 1
        this.progress.imagesFailed += 1
        failures.push(error instanceof Error && /^(图片服务返回 HTTP \d+|图片超过 20 MiB|Chrome 图片下载超时|图片跳转到未允许的地址)$/.test(error.message) ? error.message : '图片下载或本地写入失败')
      }
      this.change()
    }
    return { markdown, downloaded, failed, replacements, failures }
  }

  private async collectOne(url: string, account: string) {
    const id = targetPostId(url)
    if (!id) throw new Error('目标 URL 不在首版白名单内')
    const page = this.page || await (await this.start()).newPage()
    this.page = page
    let captured: CapturedTarget | undefined
    const onResponse = async (response: Response) => {
      if (!/\/(?:i\/api\/)?graphql\//.test(response.url()) || response.status() !== 200) return
      try {
        const found = captureFromPayload(await response.json(), id)
        if (found && (!captured || found.post.text.length > captured.post.text.length)) captured = found
      } catch { /* Ignore unrelated or non-JSON responses. */ }
    }
    page.on('response', onResponse)
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      if (/\/i\/flow\/login|\/account\/access/.test(page.url())) throw new Error('X 要求重新登录或安全验证，采集已停止')
      await this.placeWindow(-1600).catch(() => {})
      await page.waitForTimeout(3500)
      for (let index = 0; index < 4; index++) {
        await page.mouse.wheel(0, 560 + Math.floor(Math.random() * 220))
        await page.waitForTimeout(900 + Math.floor(Math.random() * 700))
      }
      const articleUrl = captured?.post.links.find(link => /https:\/\/x\.com\/i\/article\/\d+/.test(link))
        || await page.locator('a[href*="/i/article/"]').first().getAttribute('href').then(href => href ? new URL(href, 'https://x.com').href : undefined).catch(() => undefined)
      let articleBlocks: ArticleDomBlock[] = []
      let articleTitle = ''
      let articleAtBottom = false
      let stableRounds = 0
      if (articleUrl && (!captured || captured.post.partial)) {
        await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
        if (/\/i\/flow\/login|\/account\/access/.test(page.url())) throw new Error('X 要求重新登录或安全验证，采集已停止')
        const reader = page.locator('[data-testid="twitterArticleReadView"]').first()
        await reader.waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {})
        for (let attempt = 0; attempt < 40; attempt++) {
          const snapshot = await reader.evaluate(article => {
            const title = (article.querySelector('[data-testid="twitter-article-title"]') as HTMLElement | null)?.innerText?.trim() || ''
            const root = article.querySelector('[data-testid="twitterArticleRichTextView"], [data-testid="longformRichTextComponent"]') as HTMLElement | null
            if (!root) return { title, blocks: [] as ArticleDomBlock[], atBottom: false }
            const blocks: ArticleDomBlock[] = []
            const blockSelector = 'div,p,h1,h2,h3,h4,h5,h6,ul,ol,li,figure,blockquote,section,table,pre'
            const safeLink = (href: string) => {
              try {
                const parsed = new URL(href, location.href)
                if (parsed.protocol !== 'https:') return ''
                if (parsed.hostname === 'x.com' && (/\/analytics\/?$/.test(parsed.pathname) || /\/article\/\d+\/media\//.test(parsed.pathname) || /\/photo\/\d+\/?$/.test(parsed.pathname))) return ''
                return parsed.href
              } catch { return '' }
            }
            const inlineMarkdown = (element: Element) => {
              const clone = element.cloneNode(true) as HTMLElement
              for (const link of Array.from(clone.querySelectorAll('a[href]'))) {
                const href = safeLink((link as HTMLAnchorElement).href)
                const label = (link.textContent || '').trim()
                link.replaceWith(document.createTextNode(href && label ? `[${label}](${href})` : label))
              }
              for (const strong of Array.from(clone.querySelectorAll('strong,b'))) strong.replaceWith(document.createTextNode(`**${(strong.textContent || '').trim()}**`))
              for (const emphasis of Array.from(clone.querySelectorAll('em,i'))) emphasis.replaceWith(document.createTextNode(`*${(emphasis.textContent || '').trim()}*`))
              return (clone.innerText || clone.textContent || '').trim()
            }
            const pushImage = (image: HTMLImageElement) => {
              const src = image.currentSrc || image.src || ''
              if (src.includes('pbs.twimg.com/media/')) blocks.push({ type: 'image', url: src })
            }
            const embeddedTweetUrl = (element: Element) => {
              const isTweet = element.matches('[data-testid="tweet"]')
                || (element.matches('a[href*="/status/"]') && !!element.querySelector('[data-testid="tweetText"]'))
              if (!isTweet) return ''
              const links = element.matches('a[href*="/status/"]')
                ? [element as HTMLAnchorElement]
                : Array.from(element.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'))
              for (const link of links) {
                try {
                  const parsed = new URL(link.href, location.href)
                  const match = parsed.pathname.match(/^\/([^/]+)\/status\/(\d+)/)
                  if ((parsed.hostname === 'x.com' || parsed.hostname === 'twitter.com') && match) return `https://x.com/${match[1]}/status/${match[2]}`
                } catch { /* Ignore malformed links inside the card. */ }
              }
              return ''
            }
            const walk = (node: Element) => {
              for (const element of Array.from(node.children)) {
                const tweetUrl = embeddedTweetUrl(element)
                if (tweetUrl) {
                  blocks.push({ type: 'link', url: tweetUrl })
                  continue
                }
                if (element instanceof HTMLImageElement) {
                  pushImage(element)
                  continue
                }
                if (element.querySelector(blockSelector)) {
                  walk(element)
                  continue
                }
                const image = element.querySelector('img')
                if (image) pushImage(image)
                const text = (element as HTMLElement).innerText?.trim() || ''
                if (!text || (image && text === (image.getAttribute('alt') || '').trim())) continue
                blocks.push({
                  type: 'text',
                  text,
                  markdown: inlineMarkdown(element),
                  tag: element.tagName,
                  fontSize: Number.parseFloat(getComputedStyle(element).fontSize || '0')
                })
              }
            }
            walk(root)
            const height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
            return { title, blocks, atBottom: window.scrollY + window.innerHeight >= height - 32 }
          }).catch(() => undefined)
          if (snapshot) {
            articleTitle ||= snapshot.title
            const merged = mergeArticleDomBlocks(articleBlocks, snapshot.blocks)
            stableRounds = merged.length === articleBlocks.length ? stableRounds + 1 : 0
            articleBlocks = merged
            articleAtBottom = snapshot.atBottom
            if (articleAtBottom && stableRounds >= 2) break
          }
          await page.evaluate(() => window.scrollBy({ top: window.innerHeight * 0.9, behavior: 'auto' })).catch(() => {})
          await page.waitForTimeout(500 + Math.floor(Math.random() * 350))
        }
      }
      const articleBody = articleDomMarkdown(articleTitle, articleBlocks)
      if (articleBody) {
        const text = articleBlocks.filter(block => block.type === 'text').map(block => block.text || '').filter(Boolean).join('\n\n')
        const images = [...new Set(articleBlocks.filter(block => block.type === 'image').map(block => block.url || '').filter(allowedImage))]
        const links = [...new Set(articleBlocks.flatMap(block => block.type === 'link' && block.url
          ? [block.url]
          : [...(block.markdown || '').matchAll(/\]\((https:\/\/[^)]+)\)/g)].map(match => match[1])))]
        const complete = articleAtBottom && stableRounds >= 2
        const post: ArchivedPost = { id, text, author: captured?.post.author || 'xueyu1125', url, images, links, publishedAt: captured?.post.publishedAt, partial: !complete, videoCover: captured?.post.videoCover || false }
        captured = {
          post,
          markdown: ['# X 原文', articleBody, complete ? '' : '> 正文尚未通过页面底部与稳定性核验，需要人工检查。', `[原文](${url})`, '# 我的笔记', ''].filter(value => value !== '').join('\n\n'),
          structured: {
            schemaVersion: 1,
            captureMethod: captured ? 'cdp-hybrid' : 'cdp-dom',
            contentStatus: complete ? 'complete' : 'partial',
            partialReasons: complete ? [] : [articleAtBottom ? 'article-content-unstable' : 'article-not-at-bottom'],
            source: url,
            articleUrl,
            postId: id,
            author: post.author,
            text,
            links,
            images,
            videoCover: post.videoCover,
            article: { title: articleTitle, blocks: articleBlocks }
          }
        }
      } else if (!captured) {
        const tweet = await page.locator('article[data-testid="tweet"]').first().evaluate(article => {
          const text = (article.querySelector('[data-testid="tweetText"]') as HTMLElement | null)?.innerText?.trim() || ''
          const images = Array.from(article.querySelectorAll('img')).map(image => image.src).filter(src => src.includes('pbs.twimg.com/media/'))
          return { text, images }
        }).catch(() => undefined)
        if (tweet?.text) {
          captured = captureFromPayload({ rest_id: id, legacy: { full_text: tweet.text, truncated: false, entities: { urls: [] }, extended_entities: { media: tweet.images.map(image => ({ type: 'photo', media_url_https: image })) } }, core: { user_results: { result: { legacy: { screen_name: 'xueyu1125' } } } } }, id)
          if (captured) captured.structured = { ...captured.structured, captureMethod: 'cdp-dom' }
        }
      }
    } finally {
      page.off('response', onResponse)
    }
    if (!captured) throw new Error(`未能从页面响应或正文容器取得 ${id} 的正文，未写入空记录`)
    const localized = await this.localizeImages(captured, account)
    const noteId = `x-${account}-${id}`
    const existing = this.library.notes.get(noteId)
    let result: 'created' | 'updated' | 'unchanged' = 'unchanged'
    if (!existing) {
      const title = captured.post.text.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').slice(0, 80) || `X 内容 ${id}`
      this.library.save({ id: noteId, kind: 'memory', title, body: localized.markdown, author: captured.post.author, source: url, publishedAt: captured.post.publishedAt, partial: captured.post.partial, capturedImages: localized.downloaded })
      result = 'created'
    } else {
      const publishedChanged = !!captured.post.publishedAt && existing.publishedAt !== captured.post.publishedAt
      const nextBody = updatedCaptureBody(existing, captured.markdown, localized.markdown, localized.replacements)
      if (nextBody !== existing.body || (!existing.userEdited && captured.markdown.length >= existing.body.length)) {
        const capturedImages = [...new Set([...(existing.capturedImages || []), ...localized.downloaded])]
        if (existing.body !== nextBody || existing.partial !== captured.post.partial || capturedImages.length !== (existing.capturedImages || []).length || publishedChanged) {
          this.library.save({ ...existing, body: nextBody, publishedAt: captured.post.publishedAt || existing.publishedAt, partial: captured.post.partial, capturedImages }, existing.hash)
          result = 'updated'
        }
      } else if (publishedChanged) {
        this.library.save({ ...existing, publishedAt: captured.post.publishedAt }, existing.hash)
        result = 'updated'
      }
    }
    atomic(path.join(this.library.root, 'metadata', `${noteId}.capture.json`), JSON.stringify({ ...captured.structured, publishedAt: captured.post.publishedAt, attachmentStatus: localized.failed ? localized.downloaded.length ? 'partial' : 'remote-only' : localized.downloaded.length ? 'complete' : 'none', localImages: localized.replacements, imageErrors: localized.failures, capturedAt: new Date().toISOString() }, null, 2))
    return result
  }

  async collectTargets() {
    if (this.running) throw new Error('两条测试内容正在采集中')
    this.running = true
    this.stopped = false
    try {
      this.progress.imagesDone = 0
      this.progress.imagesFailed = 0
      const context = await this.start()
      if (!await this.refreshLogin()) throw new Error('请先在 Chrome 专属 Profile 中登录 X')
      const account = accountFromCookies(await context.cookies('https://x.com'))
      const results: TargetSaveResult[] = []
      this.set('正在采集第 1/2 条测试内容', { phase: 'targeted', found: 0, saved: 0 })
      for (let index = 0; index < TARGET_POSTS.length; index++) {
        if (this.stopped) throw new Error('测试采集已暂停')
        results.push(await this.collectOne(TARGET_POSTS[index], account))
        const totals = tallyTargetResults(results)
        this.set(`已检查 ${index + 1}/2 条测试内容 · 新增 ${totals.created} · 更新 ${totals.updated}`, { phase: 'targeted', found: index + 1, saved: totals.created, lastSuccessAt: new Date().toISOString() })
        if (index === 0) await new Promise(resolve => setTimeout(resolve, 2500))
      }
      const totals = tallyTargetResults(results)
      this.set(`两条测试内容检查完成：新增 ${totals.created} 条，更新 ${totals.updated} 条，未变化 ${totals.unchanged} 条；未扫描书签列表`, { phase: 'complete', found: 2, saved: totals.created })
    } catch (error) {
      const message = error instanceof Error ? error.message : '测试采集失败'
      this.set(message, { phase: 'partial' })
      if (/登录|验证/.test(message)) {
        await this.placeWindow(80).catch(() => {})
        await this.page?.bringToFront().catch(() => {})
      }
      throw error
    } finally { this.running = false }
  }

  pause() {
    this.stopped = true
    if (this.loginProcess && this.loginProcess.exitCode === null) this.loginProcess.kill()
    this.set('测试采集已暂停', { phase: 'paused' })
  }

  async disconnect() {
    this.stopped = true
    this.loggedIn = false
    if (this.loginProcess && this.loginProcess.exitCode === null) this.loginProcess.kill()
    this.loginProcess = undefined
    await this.browser?.close().catch(() => {})
    this.browser = undefined
    this.context = undefined
    this.page = undefined
    if (this.process && this.process.exitCode === null) this.process.kill()
    this.process = undefined
    this.set('已关闭 CDP Chrome；专属 Profile 登录态仍保留', { phase: 'idle' })
  }

  async shutdown() {
    await this.browser?.close().catch(() => {})
    if (this.process && this.process.exitCode === null) this.process.kill()
  }
}
