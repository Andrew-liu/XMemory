function networkKind(error: unknown): 'timeout' | 'connection' | undefined {
  if (!(error instanceof Error)) return undefined
  if (/TimeoutError|AbortError/.test(error.name) || /timeout|timed.out|ERR_TIMED_OUT/i.test(error.message)) return 'timeout'
  const cause = error.cause as { code?: string } | undefined
  if (/terminated|fetch failed|net::ERR_|ECONNRESET|socket|network/i.test(error.message) || /^(UND_ERR_|E(CONN|NET|HOST)|ENOTFOUND|EAI_AGAIN)/.test(cause?.code || '')) return 'connection'
  return undefined
}

/** Longest single wait for a rate limit; GitHub's primary limit resets within an hour. */
export const MAX_RATE_WAIT = 65 * 60_000
const RATE_RETRIES = 3

/** Milliseconds GitHub asks us to wait, or undefined when the response is not a rate limit. */
export function rateLimitDelay(response: Response, now = Date.now()): number | undefined {
  if (response.status !== 403 && response.status !== 429) return undefined
  const retryAfter = Number(response.headers.get('retry-after'))
  if (response.headers.get('retry-after') !== null && Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1000 + 1000, MAX_RATE_WAIT)
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
    return Math.min(Math.max(Number.isFinite(reset) ? reset - now : 60_000, 0) + 1000, MAX_RATE_WAIT)
  }
  // A 429 without hints is still a rate limit; GitHub suggests waiting at least a minute.
  return response.status === 429 ? 60_000 : undefined
}

export class SyncCancelled extends Error {
  constructor() { super('同步已停止，远端未更新；下次同步会继续') }
}

const clock = (ms: number) => { const s = Math.ceil(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒` }

/** Wait for a rate limit to clear, reporting the remaining time and stopping early when cancelled. */
export async function waitForRateLimit(ms: number, stage: string, status: (message: string) => void, cancelled: () => boolean = () => false) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (cancelled()) throw new SyncCancelled()
    status(`${stage}：GitHub 请求已达限额，${clock(until - Date.now())}后自动继续…`)
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(until - Date.now(), 0))))
  }
}

/** GitHub's own explanation of a failed request (its `message` and `errors`), shortened; never throws. */
export async function errorMessage(response: Response): Promise<string> {
  try {
    const text = await Promise.race([response.text(), new Promise<string>((_, reject) => setTimeout(() => reject(new Error('slow')), 5000))])
    const body = JSON.parse(text.slice(0, 64 * 1024))
    const parts = [body?.message, ...(Array.isArray(body?.errors) ? body.errors.map((e: any) => typeof e === 'string' ? e : e?.message || e?.code) : [])]
    return parts.filter(part => typeof part === 'string' && part).join('；').replace(/\s+/g, ' ').slice(0, 300)
  } catch {
    await response.body?.cancel().catch(() => {})
    return ''
  }
}

export async function githubJson(request: typeof fetch, url: string, init: RequestInit, stage: string, status: (message: string) => void, cancelled: () => boolean = () => false) {
  const read = !init.method || init.method === 'GET'
  const timeout = read ? 30_000 : 60_000
  let limited = 0
  for (let attempt = 0; ; attempt++) {
    if (cancelled()) throw new SyncCancelled()
    status(`${stage}${attempt - limited ? ` · 网络重试 ${attempt - limited}/2` : ''}…`)
    try {
      const response = await request(url, { ...init, signal: AbortSignal.timeout(timeout) })
      // HTTP errors must retain their status even if their response body is broken.
      if (!response.ok) {
        // A rate-limited request was not processed, so retrying is safe for reads and writes alike.
        const delay = rateLimitDelay(response)
        if (delay !== undefined && limited < RATE_RETRIES) { await response.body?.cancel().catch(() => {}); limited++; await waitForRateLimit(delay, stage, status, cancelled); continue }
        return { response, data: undefined, message: await errorMessage(response) }
      }
      const data = await response.json()
      return { response, data }
    } catch (error) {
      if (error instanceof SyncCancelled) throw error
      const kind = networkKind(error)
      if (read && kind && attempt - limited < 2) {
        status(`${stage}：${kind === 'timeout' ? '请求超时' : '连接中断'}，即将重试 ${attempt - limited + 1}/2…`)
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt - limited + 1)))
        continue
      }
      const reason = kind === 'timeout' ? `请求超过 ${timeout / 1000} 秒` : kind === 'connection' ? '连接中断，未收到完整响应' : '未能读取有效响应'
      throw new Error(`GitHub ${kind === 'timeout' ? '超时' : '连接失败'}（${stage}）：${reason}${read && kind ? '；已重试 2 次' : ''}。请检查网络或系统代理后重试；这不等于 Token 无效。${read ? '' : '本次写入结果未确认，远端可能已接收，请重新检查同步状态。'}`)
    }
  }
}
