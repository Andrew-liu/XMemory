import { describe, expect, it, vi } from 'vitest'
import { JinaWeb, parseSearchResults, publicWebUrl } from '../src/main/web-search'

const response = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/markdown' } })

describe('Jina 联网搜索', () => {
  it('解析、去重并过滤不安全的搜索结果', () => {
    const results = parseSearchResults('[公开文章](https://example.com/a#part)\n[重复](https://example.com/a)\n[本地](https://127.0.0.1/admin)\n[Jina](https://r.jina.ai/test)')
    expect(results).toEqual([{ title: '公开文章', url: 'https://example.com/a', source: 'example.com' }])
  })

  it('拒绝非 HTTPS、凭据、localhost 与私网地址', () => {
    for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://localhost/a', 'https://192.168.1.2/a', 'https://[::1]/a']) expect(() => publicWebUrl(url)).toThrow()
    expect(publicWebUrl('https://example.com/path#part')).toBe('https://example.com/path')
  })

  it('编码搜索词，只允许读取本轮结果并截断正文', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => String(url).startsWith('https://s.jina.ai/')
      ? response('[结果](https://example.com/article)')
      : response('正'.repeat(13_000)))
    const web = new JinaWeb(mockFetch as typeof fetch)
    const signal = new AbortController().signal
    const search = await web.search('AI Agent 中文', signal)
    expect(mockFetch.mock.calls[0][0]).toBe('https://s.jina.ai/AI%20Agent%20%E4%B8%AD%E6%96%87')
    expect(search.results).toHaveLength(1)
    expect(await web.read('https://not-searched.example/a', signal)).toMatchObject({ error: '只能读取本次搜索结果中的网页' })
    const page = await web.read(search.results[0].url, signal)
    expect(page.text).toHaveLength(12_000)
    expect(page.truncated).toBe(true)
    expect(page.source).toMatchObject({ title: '结果', source: 'example.com' })
  })

  it('限制每次创作的搜索和阅读次数，并对服务失败降级', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).startsWith('https://s.jina.ai/fail')) throw new Error('secret upstream detail')
      if (String(url).startsWith('https://s.jina.ai/')) return response('[结果](https://example.com/a)')
      return response('正文')
    }) as typeof fetch
    const signal = new AbortController().signal
    const failed = await new JinaWeb(fetcher).search('fail', signal)
    expect(failed.error).toBe('联网服务暂时不可用')
    expect(JSON.stringify(failed)).not.toContain('secret upstream detail')
    const web = new JinaWeb(fetcher)
    await web.search('one', signal); await web.search('two', signal); await web.search('three', signal)
    expect(await web.search('four', signal)).toMatchObject({ error: '本次创作已达到 3 次搜索上限' })
    for (let i = 0; i < 5; i++) await web.read('https://example.com/a', signal)
    expect(await web.read('https://example.com/a', signal)).toMatchObject({ error: '本次创作已达到 5 个网页的读取上限' })
  })
})
