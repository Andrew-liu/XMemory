import { _electron as electron, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BrowserContext } from 'playwright'
import { createBackgroundPage, downloadChromeImage, findChrome, XCapture } from '../src/main/x-capture'
import { updatedCaptureBody } from '../src/main/x-parse'
import { Library } from '../src/main/library'

const temporary = path.resolve(process.cwd(), '../../trash/xmemeory-dev/browser-images')
mkdirSync(temporary, { recursive: true })
if (!findChrome()) throw new Error('真实图片测试需要安装 Chrome')

// 独立 Electron 哨兵窗口：用原生窗口焦点检测采集是否抢占前台，只使用本测试自己的进程。
const sentinelDir = mkdtempSync(path.join(temporary, 'sentinel-'))
writeFileSync(path.join(sentinelDir, 'package.json'), JSON.stringify({ name: 'focus-sentinel', main: 'main.js' }))
writeFileSync(path.join(sentinelDir, 'main.js'), `const path=require('node:path');
const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'user-data'));
app.whenReady().then(()=>{ const win=new BrowserWindow({width:420,height:180}); global.focusLosses=[]; global.sentinel=win; win.on('blur',()=>global.focusLosses.push(Date.now())); win.loadURL('data:text/html,<h1>后台采集焦点回归</h1><input autofocus placeholder="焦点监测窗口">'); });
app.on('window-all-closed',()=>app.quit());`)
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
delete env.ELECTRON_RUN_AS_NODE
const sentinelApp = await electron.launch({ args: [sentinelDir], env })
const library = new Library(mkdtempSync(path.join(temporary, 'library-')))
const capture = new XCapture(library, mkdtempSync(path.join(temporary, 'user-data-')), () => {})
const phases: string[] = []
const mark = async (name: string) => {
  const count = await sentinelApp.evaluate(() => (global as any).focusLosses.length as number)
  phases.push(`${name}:${count}@${new Date().toISOString().slice(11, 23)}`)
}
let listPage: Awaited<ReturnType<typeof createBackgroundPage>> | undefined
try {
  const sentinelPage = await sentinelApp.firstWindow()
  await sentinelApp.evaluate(() => { const win = (global as any).sentinel; win.show(); win.focus() })
  await expect.poll(async () => sentinelApp.evaluate(() => (global as any).sentinel.isFocused() as boolean), { timeout: 10_000 }).toBe(true)
  await sentinelApp.evaluate(() => { (global as any).focusLosses = [] })
  await expect(sentinelPage.locator('input')).toBeFocused()

  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2l8AAAAASUVORK5CYII=', 'base64')
  const imageUrl = 'https://pbs.twimg.com/media/synthetic-long-image-address.png?name=orig'
  const pageUrl = 'https://synthetic.invalid/bookmarks'
  const firstId = '1111111111111111111', articleId = '2222222222222222222', lastId = '3333333333333333333'
  const makeTweet = (id: string) => ({ rest_id: id, legacy: { full_text: `合成书签正文 ${id}`, truncated: false, created_at: 'Mon Sep 14 08:30:00 +0000 2026', entities: { urls: [] }, extended_entities: { media: [{ type: 'photo', media_url_https: imageUrl }] } }, core: { user_results: { result: { legacy: { screen_name: 'synthetic' } } } } })
  const articlePreview = { ...makeTweet(articleId), legacy: { full_text: 'https://t.co/focusArticle', truncated: false, entities: { urls: [{ url: 'https://t.co/focusArticle', expanded_url: `https://x.com/i/article/${articleId}` }] } }, article: { article_results: { result: { title: '后台长文焦点回归', preview_text: '合成长文预览' } } } }
  const articleFull = { ...articlePreview, article: { article_results: { result: { title: '后台长文焦点回归', preview_text: '合成长文预览', content_state: { blocks: [{ key: 'a', type: 'header-two', text: '合成章节', data: {}, inlineStyleRanges: [], entityRanges: [] }, { key: 'b', type: 'unstyled', text: '完整合成长文正文。', data: {}, inlineStyleRanges: [], entityRanges: [] }], entityMap: [] } } } } }
  const feed = (tweets: unknown[]) => ({ data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: tweets.map((tweet: any) => ({ entryId: `tweet-${tweet.rest_id}`, content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweet_results: { result: tweet } } } })) }] } } } })
  const bookmarkHtml = `<!doctype html><html><body><div style="height:10000px">合成书签</div><script>let batch=1;fetch('/i/api/graphql/focus/Bookmarks?batch=1');addEventListener('scroll',()=>{if(batch<3)fetch('/i/api/graphql/focus/Bookmarks?batch='+ (++batch));});</script></body></html>`
  const detailHtml = `<!doctype html><html><body><div style="height:6000px">合成长文</div><script>fetch('/i/api/graphql/focus/TweetDetail');</script></body></html>`
  const bookmarkBatches: number[] = []

  // 阶段一：真实 Chrome 无窗口启动并接入 CDP。
  const context: BrowserContext = await (capture as any).start()
  await mark('chrome-startup')
  // 阶段二：后台创建采集页并加载/滚动合成页面，全部流量本地兑现或中断。
  listPage = await createBackgroundPage(context)
  await mark('create-list-page')
  await context.route('**/*', route => {
    const url = route.request().url()
    const parsed = new URL(url)
    if (parsed.hostname === 'pbs.twimg.com' && parsed.pathname.startsWith('/media/synthetic-long-image-address')) return route.fulfill({ status: 200, contentType: 'image/png', body: bytes })
    if (url === pageUrl) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body><div style="height:6000px">书签列表</div></body></html>' })
    if (url === 'https://x.com/i/bookmarks') return route.fulfill({ status: 200, contentType: 'text/html', body: bookmarkHtml })
    if (parsed.pathname === '/i/api/graphql/focus/Bookmarks') {
      const batch = Number(parsed.searchParams.get('batch'))
      bookmarkBatches.push(batch)
      const payload = batch === 1 ? feed([makeTweet(firstId), articlePreview]) : batch === 2 ? feed([makeTweet(lastId)]) : feed([])
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) })
    }
    if (url === `https://x.com/synthetic/status/${articleId}`) return route.fulfill({ status: 200, contentType: 'text/html', body: detailHtml })
    if (parsed.pathname === '/i/api/graphql/focus/TweetDetail') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { tweetResult: { result: articleFull } } }) })
    return route.abort()
  })
  await listPage.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
  const outcome = await listPage.evaluate(d => {
    const before = window.scrollY
    window.scrollBy({ top: d, behavior: 'auto' })
    const el = document.scrollingElement || document.documentElement
    return { moved: window.scrollY > before, atEnd: window.scrollY + window.innerHeight >= el.scrollHeight - 200 }
  }, 800)
  expect(outcome.moved).toBe(true)
  await mark('navigate-and-scroll')
  // 阶段三：连续图片下载（每个下载各建一个后台标签页）。
  const pagesBeforeDownloads = context.pages().length
  for (let index = 0; index < 3; index++) {
    const downloaded = await downloadChromeImage(context, imageUrl)
    expect(downloaded.equals(bytes)).toBe(true)
  }
  expect(context.pages()).toHaveLength(pagesBeforeDownloads)
  await mark('image-downloads')
  // 阶段四：关闭后台采集页。
  await listPage.close()
  listPage = undefined
  await mark('page-close')
  // 阶段五：完整合成书签采集，走真实 ensureReady/scanner/collectOne/persist 路径。
  await context.addCookies([{ name: 'auth_token', value: 'synthetic-focus-test', domain: '.x.com', path: '/', secure: true }, { name: 'twid', value: 'u%3D42', domain: '.x.com', path: '/', secure: true }])
  const result = await capture.collectBookmarks(20)
  expect(result).toMatchObject({ created: 3, failed: 0, articlesQueued: 1, stopReason: 'bottom' })
  expect(bookmarkBatches).toEqual([1, 2, 3])
  expect(library.get(`x-42-${articleId}`).body).toContain('## 合成章节')
  expect(library.get(`x-42-${articleId}`).body).toContain('完整合成长文正文。')
  expect(library.get(`x-42-${articleId}`).partial).toBe(false)
  expect(capture.progress.imagesDone).toBe(2)
  expect(capture.progress.imagesFailed).toBe(0)
  expect(context.pages()).toHaveLength(1)
  await mark('full-bookmark-collection')

  const losses = await sentinelApp.evaluate(() => (global as any).focusLosses.length as number)
  const focused = await sentinelApp.evaluate(() => (global as any).sentinel.isFocused() as boolean)
  console.log('焦点验收:', phases.join(' > '), `blur=${losses}, focused=${focused}`)
  expect(losses).toBe(0)
  expect(focused).toBe(true)
  await expect(sentinelPage.locator('input')).toBeFocused()

  const asset = library.addImage(bytes, 'synthetic')
  const original = library.save({ kind: 'memory', id: 'x-1-2', title: '合成图片回归', body: `# X 原文\n\n![图片](${imageUrl})\n\n# 我的笔记\n我的观点` })
  const relative = path.posix.relative(path.posix.dirname(original.path), asset)
  const body = updatedCaptureBody(original, original.body, original.body.replace(imageUrl, relative), { [imageUrl]: relative })
  const saved = library.save({ ...original, body }, original.hash)
  expect(saved.body).toContain('我的观点')
  expect(saved.body).not.toContain(imageUrl)
  expect(readFileSync(path.resolve(library.root, path.dirname(saved.path), relative)).equals(bytes)).toBe(true)
  console.log('PASS: 真实 Chrome 无窗口启动、后台建页/滚动/图片下载/整条书签采集/关页期间哨兵窗口未失焦，Markdown 相对路径与笔记保留（合成响应，无真实账号）')
} finally {
  await listPage?.close().catch(() => {})
  await capture.disconnect().catch(() => {})
  await library.close()
  await sentinelApp.close()
}
