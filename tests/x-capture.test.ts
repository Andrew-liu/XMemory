import { expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { BrowserContext } from 'playwright'
import { chromeArgs, downloadChromeImage, XCapture, X_LOGIN_URL } from '../src/main/x-capture'
import { articleDomMarkdown, captureFromPayload, mergeArticleDomBlocks, updatedCaptureBody } from '../src/main/x-parse'
import { Library } from '../src/main/library'

const temporary = path.resolve(process.cwd(), '../../trash/xmemeory-dev/tests')
mkdirSync(temporary, { recursive: true })

it('图片通过 Chrome 标签页响应读取并关闭标签页，失败不会报告成功', async () => {
  const url = 'https://pbs.twimg.com/media/test.jpg'
  const bytes = Buffer.from([255, 216, 255, 217])
  const response = { url: () => url, ok: () => true, status: () => 200, headers: () => ({}), body: async () => bytes }
  const page = { route: vi.fn(), goto: vi.fn().mockResolvedValue(response), close: vi.fn().mockResolvedValue(undefined) }
  const context = { newPage: async () => page } as unknown as BrowserContext
  expect(await downloadChromeImage(context, url)).toEqual(bytes)
  expect(page.goto).toHaveBeenCalledWith(url, expect.objectContaining({ timeout: 30000 }))
  expect(page.close).toHaveBeenCalledTimes(1)
  page.goto.mockResolvedValue({ ...response, ok: () => false, status: () => 403 })
  await expect(downloadChromeImage(context, url)).rejects.toThrow('HTTP 403')
  expect(page.close).toHaveBeenCalledTimes(2)
  page.goto.mockResolvedValue({ ...response, headers: () => ({ 'content-length': '20971521' }) })
  await expect(downloadChromeImage(context, url)).rejects.toThrow('20 MiB')
  await expect(downloadChromeImage(context, 'https://secret@pbs.twimg.com/media/a.jpg')).rejects.toThrow('允许范围')
  await expect(downloadChromeImage(context, 'https://example.com/a.jpg')).rejects.toThrow('允许范围')
})

it('远程图片换成本地短路径仍更新正文，重采保留用户笔记', () => {
  const url = 'https://pbs.twimg.com/media/very-long-original-image-address.jpg?name=orig'
  const remote = `# X 原文\n\n![图片](${url})\n\n# 我的笔记\n`
  const local = remote.replace(url, '../../assets/image.jpg')
  const replacements = { [url]: '../../assets/image.jpg' }
  expect(local.length).toBeLessThan(remote.length)
  expect(updatedCaptureBody({ body: remote }, remote, local, replacements)).toBe(local)
  expect(updatedCaptureBody({ body: remote + '我的观点' }, remote, local, replacements)).toBe(local + '我的观点')
  expect(updatedCaptureBody({ body: remote + '外部修改', userEdited: true }, remote, local, replacements)).toBe(local + '外部修改')
  expect(updatedCaptureBody({ body: local }, remote, local, replacements)).toBe(local)
})

it('Article DOM 多轮快照按相邻块合并并保持图片原位', () => {
  const first = [
    { type: 'text' as const, text: '第一段', tag: 'P' },
    { type: 'image' as const, url: 'https://pbs.twimg.com/media/ONE.jpg' },
    { type: 'text' as const, text: '第三段', tag: 'P' }
  ]
  const second = [
    { type: 'image' as const, url: 'https://pbs.twimg.com/media/ONE.jpg' },
    { type: 'text' as const, text: '第二段', tag: 'P' },
    { type: 'text' as const, text: '第三段', tag: 'P' }
  ]
  const merged = mergeArticleDomBlocks(first, second)
  expect(merged.map(block => block.text || block.url)).toEqual([
    '第一段',
    'https://pbs.twimg.com/media/ONE.jpg',
    '第二段',
    '第三段'
  ])
  const markdown = articleDomMarkdown('标题', merged)
  expect(markdown.indexOf('第一段')).toBeLessThan(markdown.indexOf('![X 图片]'))
  expect(markdown.indexOf('![X 图片]')).toBeLessThan(markdown.indexOf('第二段'))
})

it('Article DOM Markdown 保留正文链接和块格式', () => {
  const markdown = articleDomMarkdown('长文标题', [
    { type: 'text', text: '章节', markdown: '章节', tag: 'DIV', fontSize: 26 },
    { type: 'text', text: '帮助文档', markdown: '[帮助文档](https://help.x.com/example)', tag: 'P', fontSize: 17 },
    { type: 'text', text: '引用', markdown: '引用', tag: 'BLOCKQUOTE', fontSize: 17 },
    { type: 'text', text: '代码', markdown: '代码', tag: 'PRE', fontSize: 15 }
  ])
  expect(markdown).toContain('# 长文标题')
  expect(markdown).toContain('## 章节')
  expect(markdown).toContain('[帮助文档](https://help.x.com/example)')
  expect(markdown).toContain('> 引用')
  expect(markdown).toContain('```\n代码\n```')
})

it('Article 内嵌 X 推文只保留链接且多轮采集不会重复', () => {
  const tweet = { type: 'link' as const, url: 'https://x.com/example/status/1234567890' }
  const merged = mergeArticleDomBlocks(
    [{ type: 'text', text: '上文', tag: 'P' }, tweet],
    [tweet, { type: 'text', text: '下文', tag: 'P' }]
  )
  const markdown = articleDomMarkdown('标题', merged)
  expect(markdown).toContain('<https://x.com/example/status/1234567890>')
  expect(markdown.match(/example\/status\/1234567890/g)).toHaveLength(1)
  expect(markdown).not.toContain('内嵌推文正文')
})

it('首次登录使用普通 Chrome，只有采集模式启用 CDP', () => {
  const login = chromeArgs('profile', 'login')
  expect(login).toContain(X_LOGIN_URL)
  expect(login.some(arg => arg.startsWith('--remote-debugging'))).toBe(false)
  const cdp = chromeArgs('profile', 'cdp')
  expect(cdp).toContain('--remote-debugging-address=127.0.0.1')
  expect(cdp).toContain('--remote-debugging-port=0')
  expect(cdp).toContain('--window-position=-10000,40')
  expect(cdp).not.toContain(X_LOGIN_URL)
})

it('短推响应保存正文、图片和用户笔记分区', () => {
  const captured = captureFromPayload({ data: { tweetResult: { result: {
    rest_id: '1111111111111111111',
    legacy: {
      full_text: '这是一条用于本地保存验收的短推。',
      created_at: 'Mon Sep 14 08:30:00 +0000 2026',
      truncated: false,
      entities: { urls: [] },
      extended_entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/TEST.jpg' }] }
    },
    core: { user_results: { result: { legacy: { screen_name: 'someuser' } } } }
  } } } }, '1111111111111111111', undefined, 'https://x.com/someuser/status/1111111111111111111')!
  expect(captured.post.partial).toBe(false)
  expect(captured.post.publishedAt).toBe('2026-09-14T08:30:00.000Z')
  expect(captured.structured.publishedAt).toBe('2026-09-14T08:30:00.000Z')
  expect(captured.markdown).toContain('# X 原文')
  expect(captured.markdown).toContain('用于本地保存验收')
  expect(captured.markdown).toContain('![X 图片 1](https://pbs.twimg.com/media/TEST.jpg)')
  expect(captured.markdown).toContain('# 我的笔记')
  expect(captured.markdown).toContain('[原文](https://x.com/someuser/status/1111111111111111111)')
  expect(captured.structured.captureMethod).toBe('cdp-response')
  expect(captured.structured.schemaVersion).toBe(2)
})

it('长文响应通过 content_state 取得结构化正文并跳过 DOM', () => {
  const article = {
    title: '长文标题',
    preview_text: '预览',
    content_state: {
      blocks: [
        { key: 'b1', type: 'header-two', text: '第一节', data: {}, inlineStyleRanges: [], entityRanges: [] },
        { key: 'b2', type: 'unstyled', text: '长文正文第一段。', data: {}, inlineStyleRanges: [], entityRanges: [] },
        { key: 'b3', type: 'atomic', text: ' ', data: {}, inlineStyleRanges: [], entityRanges: [{ key: 0, offset: 0, length: 1 }] }
      ],
      entityMap: [{ key: '0', value: { type: 'MEDIA', mutability: 'IMMUTABLE', data: { mediaItems: [{ mediaId: '211' }] } } }]
    },
    media_entities: [{ media_id: '211', media_key: 'k', media_info: { __typename: 'ApiImage', original_img_url: 'https://pbs.twimg.com/media/A.jpg', original_img_width: 800, original_img_height: 600 } }]
  }
  const captured = captureFromPayload({ data: { threaded_conversation_with_injections_v2: {
    instructions: [{ entries: [{ content: { itemContent: { tweet_results: { result: {
      rest_id: '2222222222222222222',
      legacy: { full_text: 'https://t.co/article', truncated: false, entities: { urls: [{ url: 'https://t.co/article', expanded_url: 'https://x.com/i/article/2222222222222222222' }] } },
      core: { user_results: { result: { legacy: { screen_name: 'someuser' } } } },
      article: { article_results: { result: article } }
    } } } } }] }]
  } } }, '2222222222222222222', undefined, 'https://x.com/someuser/status/2222222222222222222')!
  expect(captured.post.partial).toBe(false)
  expect(captured.articleResult).toBeDefined()
  expect(captured.articleTitle).toBe('长文标题')
  expect(captured.markdown).toContain('# 长文标题')
  expect(captured.markdown).toContain('## 第一节')
  expect(captured.markdown).toContain('长文正文第一段')
  expect(captured.markdown).toContain('![X 图片](https://pbs.twimg.com/media/A.jpg)')
  expect(captured.post.images).toContain('https://pbs.twimg.com/media/A.jpg')
})

it('Article 缺少 content_state 时必须标记不完整并回退 DOM', () => {
  const captured = captureFromPayload({
    rest_id: '2222222222222222222',
    legacy: { full_text: 'https://t.co/article', truncated: false, entities: { urls: [{ url: 'https://t.co/article', expanded_url: 'https://x.com/i/article/2222222222222222222' }] } },
    core: { user_results: { result: { legacy: { screen_name: 'someuser' } } } },
    article: { article_results: { result: { title: '只有标题', preview_text: '只有预览' } } }
  }, '2222222222222222222', undefined, 'https://x.com/someuser/status/2222222222222222222')!
  expect(captured.post.partial).toBe(true)
  expect(captured.articleResult).toBeUndefined()
  expect(captured.structured.partialReasons).toContain('content-state-missing')
  expect(captured.markdown).toContain('正文可能不完整')
})

it('批量与单条共用落盘输出一致，capture.json 标记书签来源', async () => {
  const rootA = mkdtempSync(path.join(temporary, 'single-'))
  const rootB = mkdtempSync(path.join(temporary, 'batch-'))
  const libA = new Library(rootA)
  const libB = new Library(rootB)
  try {
    const capA = new XCapture(libA, mkdtempSync(path.join(temporary, 'ua-')), () => {})
    const capB = new XCapture(libB, mkdtempSync(path.join(temporary, 'ub-')), () => {})
    const make = () => captureFromPayload({ rest_id: '123', legacy: { full_text: '共用落盘的合成正文', truncated: false, entities: { urls: [] } }, core: { user_results: { result: { legacy: { screen_name: 'user1' } } } } }, '123')!
    const single = await (capA as any).persistCaptured(make(), '42')
    const batch = await (capB as any).persistCaptured(make(), '42', 'bookmarks')
    expect(single.result).toBe('created')
    expect(batch.result).toBe('created')
    expect(libB.get(batch.noteId).body).toBe(libA.get(single.noteId).body)
    const jsonA = JSON.parse(readFileSync(path.join(rootA, 'metadata', 'x-42-123.capture.json'), 'utf8'))
    const jsonB = JSON.parse(readFileSync(path.join(rootB, 'metadata', 'x-42-123.capture.json'), 'utf8'))
    expect(jsonA.discoveredVia).toBeUndefined()
    expect(jsonB.discoveredVia).toBe('bookmarks')
    expect({ ...jsonB, discoveredVia: undefined, capturedAt: undefined }).toEqual({ ...jsonA, capturedAt: undefined })
  } finally {
    await libA.close()
    await libB.close()
  }
})

it('不完整旧正文被更短但完整的新正文替换，已编辑或带笔记时不覆盖', () => {
  const remote = '# X 原文\n\n完整正文\n\n# 我的笔记\n'
  const stale = remote.replace('# 我的笔记', '> 正文可能不完整，尚未取得可核验的完整结构。\n\n# 我的笔记')
  expect(remote.length).toBeLessThan(stale.length)
  expect(updatedCaptureBody({ body: stale, partial: true }, remote, remote, {}, false)).toBe(remote)
  expect(updatedCaptureBody({ body: stale, partial: true, userEdited: true }, remote, remote, {}, false)).toBe(stale)
  expect(updatedCaptureBody({ body: stale + '\n我的补充', partial: true }, remote, remote, {}, false)).toBe(stale + '\n我的补充')
  expect(updatedCaptureBody({ body: stale, partial: false }, remote, remote, {}, false)).toBe(stale)
  expect(updatedCaptureBody({ body: stale, partial: true }, remote, remote, {}, true)).toBe(stale)
})

it('重采完整长文替换旧的不完整正文并更新 partial，用户编辑后保持原文与标记', async () => {
  const root = mkdtempSync(path.join(temporary, 'upgrade-'))
  const lib = new Library(root)
  try {
    const cap = new XCapture(lib, mkdtempSync(path.join(temporary, 'uu-')), () => {})
    const complete = captureFromPayload({ rest_id: '123', legacy: { full_text: '完整正文', truncated: false, entities: { urls: [] } }, core: { user_results: { result: { legacy: { screen_name: 'user1' } } } } }, '123')!
    const stale = { ...complete, markdown: complete.markdown.replace('# 我的笔记', '> 正文可能不完整，尚未取得可核验的完整结构。\n\n# 我的笔记'), post: { ...complete.post, partial: true } }
    const first = await (cap as any).persistCaptured(stale, '42')
    expect(first.result).toBe('created')
    expect(lib.get(first.noteId).partial).toBe(true)
    const staleLength = lib.get(first.noteId).body.length
    expect(complete.markdown.length).toBeLessThan(staleLength)
    const second = await (cap as any).persistCaptured(complete, '42')
    expect(second.result).toBe('updated')
    const upgraded = lib.get(second.noteId)
    expect(upgraded.partial).toBe(false)
    expect(upgraded.body).not.toContain('正文可能不完整')
    const edited = lib.save({ ...upgraded, body: upgraded.body + '\n用户批注', userEdited: true, partial: true }, upgraded.hash)
    expect((await (cap as any).persistCaptured(complete, '42')).result).toBe('unchanged')
    const kept = lib.get(edited.id)
    expect(kept.body).toContain('用户批注')
    expect(kept.partial).toBe(true)
  } finally {
    await lib.close()
  }
})
