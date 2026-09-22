import { isIP } from 'node:net'

export interface WebSearchResult {
  title: string
  url: string
  source: string
}

export interface WebSource extends WebSearchResult {
  accessedAt: string
}

type FetchLike = typeof fetch

const MAX_RESPONSE_BYTES = 1_000_000
const MAX_SEARCH_RESULTS = 8
const PRIVATE_HOSTS = new Set(['localhost', 'localhost.localdomain', '0.0.0.0', '::', '::1'])

function privateIpv4(host: string) {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = parts
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
}

export function publicWebUrl(value: string) {
  const url = new URL(value)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (url.protocol !== 'https:' || url.username || url.password || !host || PRIVATE_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('只允许读取公开 HTTPS 网页')
  if (isIP(host) === 4 && privateIpv4(host)) throw new Error('不允许读取本地或私有网络地址')
  if (isIP(host) === 6 && (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb'))) throw new Error('不允许读取本地或私有网络地址')
  url.hash = ''
  return url.href
}

async function limitedText(response: Response, signal: AbortSignal) {
  if (!response.ok) throw new Error(`服务返回 HTTP ${response.status}`)
  const reader = response.body?.getReader()
  if (!reader) return (await response.text()).slice(0, MAX_RESPONSE_BYTES)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < MAX_RESPONSE_BYTES) {
      if (signal.aborted) throw signal.reason
      const { done, value } = await reader.read()
      if (done) break
      const part = value.subarray(0, MAX_RESPONSE_BYTES - size)
      chunks.push(part); size += part.length
    }
  } finally { await reader.cancel().catch(() => {}) }
  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length }
  return new TextDecoder().decode(joined)
}

async function request(fetcher: FetchLike, url: string, signal: AbortSignal, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any([signal, timeout])
  try {
    const response = await fetcher(url, { signal: combined, redirect: 'follow', headers: { Accept: 'text/plain, text/markdown;q=0.9' } })
    return await limitedText(response, combined)
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (timeout.aborted) throw new Error('联网服务响应超时')
    throw new Error('联网服务暂时不可用')
  }
}

export function parseSearchResults(markdown: string): WebSearchResult[] {
  const found = new Map<string, WebSearchResult>()
  const links = markdown.matchAll(/\[([^\]\n]{1,240})\]\((https:\/\/[^\s)]+)\)/g)
  for (const match of links) {
    try {
      const url = publicWebUrl(match[2])
      const parsed = new URL(url)
      if (parsed.hostname === 's.jina.ai' || parsed.hostname === 'r.jina.ai' || found.has(url)) continue
      found.set(url, { title: match[1].trim(), url, source: parsed.hostname.replace(/^www\./, '') })
      if (found.size >= MAX_SEARCH_RESULTS) break
    } catch { /* Ignore invalid or private links returned by search. */ }
  }
  return [...found.values()]
}

export class JinaWeb {
  private searches = 0
  private reads = 0
  private allowed = new Map<string, WebSearchResult>()
  constructor(private fetcher: FetchLike = fetch) {}

  async search(query: string, signal: AbortSignal) {
    const clean = query.trim().slice(0, 300)
    if (!clean) return { error: '搜索词不能为空', results: [] as WebSearchResult[] }
    if (this.searches >= 3) return { error: '本次创作已达到 3 次搜索上限', results: [] as WebSearchResult[] }
    this.searches++
    try {
      const markdown = await request(this.fetcher, `https://s.jina.ai/${encodeURIComponent(clean)}`, signal, 15_000)
      const results = parseSearchResults(markdown)
      results.forEach(item => this.allowed.set(item.url, item))
      return { results }
    } catch (error) {
      if (signal.aborted) throw error
      return { error: error instanceof Error ? error.message : '联网搜索失败', results: [] as WebSearchResult[] }
    }
  }

  async read(value: string, signal: AbortSignal) {
    let url: string
    try { url = publicWebUrl(value) } catch (error) { return { error: error instanceof Error ? error.message : '网页地址无效' } }
    const result = this.allowed.get(url)
    if (!result) return { error: '只能读取本次搜索结果中的网页' }
    if (this.reads >= 5) return { error: '本次创作已达到 5 个网页的读取上限' }
    this.reads++
    try {
      const text = await request(this.fetcher, `https://r.jina.ai/${url}`, signal, 20_000)
      const source: WebSource = { ...result, accessedAt: new Date().toISOString() }
      return { source, text: text.slice(0, 12_000), truncated: text.length > 12_000 }
    } catch (error) {
      if (signal.aborted) throw error
      return { error: error instanceof Error ? error.message : '网页读取失败' }
    }
  }
}
