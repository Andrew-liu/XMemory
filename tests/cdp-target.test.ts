import { expect, it, vi } from 'vitest'
import type { BrowserContext } from 'playwright'
import { articleDomMarkdown, articleMarkdown, captureFromPayload, chromeArgs, downloadChromeImage, mergeArticleDomBlocks, tallyTargetResults, targetPostId, TARGET_POSTS, updatedCaptureBody, X_LOGIN_URL } from '../src/main/x-cdp-target'

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

it('首版只接受两个固定 X 状态 URL', () => {
  expect(targetPostId(TARGET_POSTS[0])).toBe('2099104432596328908')
  expect(targetPostId(`${TARGET_POSTS[1]}/`)).toBe('2099446491094175744')
  expect(targetPostId('https://x.com/xueyu1125/status/1')).toBeUndefined()
  expect(targetPostId('https://twitter.com/xueyu1125/status/2099104432596328908')).toBeUndefined()
  expect(targetPostId(`${TARGET_POSTS[0]}?s=20`)).toBeUndefined()
  expect(X_LOGIN_URL).toBe('https://x.com/i/flow/login')
  expect(targetPostId(X_LOGIN_URL)).toBeUndefined()
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

it('已有一条记录时只把另一条计为新增', () => {
  expect(tallyTargetResults(['unchanged', 'created'])).toEqual({ created: 1, updated: 0, unchanged: 1 })
  expect(tallyTargetResults(['updated', 'created'])).toEqual({ created: 1, updated: 1, unchanged: 0 })
})

it('短推响应保存正文、图片和用户笔记分区', () => {
  const captured = captureFromPayload({ data: { tweetResult: { result: {
    rest_id: '2099104432596328908',
    legacy: {
      full_text: '这是一条用于本地保存验收的短推。',
      created_at: 'Mon Sep 14 08:30:00 +0000 2026',
      truncated: false,
      entities: { urls: [] },
      extended_entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/TEST.jpg' }] }
    },
    core: { user_results: { result: { legacy: { screen_name: 'xueyu1125' } } } }
  } } } }, '2099104432596328908')!
  expect(captured.post.partial).toBe(false)
  expect(captured.post.publishedAt).toBe('2026-09-14T08:30:00.000Z')
  expect(captured.structured.publishedAt).toBe('2026-09-14T08:30:00.000Z')
  expect(captured.markdown).toContain('# X 原文')
  expect(captured.markdown).toContain('用于本地保存验收')
  expect(captured.markdown).toContain('![X 图片 1](https://pbs.twimg.com/media/TEST.jpg)')
  expect(captured.markdown).toContain('# 我的笔记')
  expect(captured.structured.captureMethod).toBe('cdp-response')
})

it('Article 响应优先转换结构块并保留表格原始结构', () => {
  const article = {
    title: '长文标题',
    preview_text: '预览',
    content: { blocks: [
      { type: 'heading', text: '第一节' },
      { type: 'unstyled', text: '长文正文第一段。' },
      { type: 'unordered-list-item', text: '列表项' },
      { type: 'blockquote', text: '引用内容' },
      { type: 'table', text: 'A | B' }
    ] }
  }
  const markdown = articleMarkdown(article)
  expect(markdown).toContain('# 长文标题')
  expect(markdown).toContain('## 第一节')
  expect(markdown).toContain('- 列表项')
  expect(markdown).toContain('> 引用内容')
  const captured = captureFromPayload({ data: { threaded_conversation_with_injections_v2: {
    instructions: [{ entries: [{ content: { itemContent: { tweet_results: { result: {
      rest_id: '2099446491094175744',
      legacy: { full_text: 'https://t.co/article', truncated: false, entities: { urls: [{ expanded_url: 'https://x.com/i/article/2099421537489100800' }] } },
      core: { user_results: { result: { legacy: { screen_name: 'xueyu1125' } } } },
      article: { article_results: { result: article } }
    } } } } }] }]
  } } }, '2099446491094175744')!
  expect(captured.post.partial).toBe(false)
  expect(captured.markdown).toContain('长文正文第一段')
  expect((captured.structured.article as { blocks: unknown[] }).blocks).toHaveLength(5)
})

it('Article 只有预览时必须标记不完整', () => {
  const captured = captureFromPayload({
    rest_id: '2099446491094175744',
    legacy: { full_text: 'https://t.co/article', truncated: false, entities: { urls: [{ expanded_url: 'https://x.com/i/article/2099421537489100800' }] } },
    core: { user_results: { result: { legacy: { screen_name: 'xueyu1125' } } } },
    article: { article_results: { result: { title: '只有标题', preview_text: '只有预览' } } }
  }, '2099446491094175744')!
  expect(captured.post.partial).toBe(true)
  expect(captured.markdown).toContain('正文可能不完整')
})
