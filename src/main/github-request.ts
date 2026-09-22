function networkKind(error: unknown): 'timeout' | 'connection' | undefined {
  if (!(error instanceof Error)) return undefined
  if (/TimeoutError|AbortError/.test(error.name) || /timeout|timed.out|ERR_TIMED_OUT/i.test(error.message)) return 'timeout'
  const cause = error.cause as { code?: string } | undefined
  if (/terminated|fetch failed|net::ERR_|ECONNRESET|socket|network/i.test(error.message) || /^(UND_ERR_|E(CONN|NET|HOST)|ENOTFOUND|EAI_AGAIN)/.test(cause?.code || '')) return 'connection'
  return undefined
}

export async function githubJson(request: typeof fetch, url: string, init: RequestInit, stage: string, status: (message: string) => void) {
  const read = !init.method || init.method === 'GET'
  const timeout = read ? 30_000 : 60_000
  for (let attempt = 0; ; attempt++) {
    status(`${stage}${attempt ? ` · 网络重试 ${attempt}/2` : ''}…`)
    try {
      const response = await request(url, { ...init, signal: AbortSignal.timeout(timeout) })
      // HTTP errors must retain their status even if their response body is broken.
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return { response, data: undefined } }
      const data = await response.json()
      return { response, data }
    } catch (error) {
      const kind = networkKind(error)
      if (read && kind && attempt < 2) {
        status(`${stage}：${kind === 'timeout' ? '请求超时' : '连接中断'}，即将重试 ${attempt + 1}/2…`)
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)))
        continue
      }
      const reason = kind === 'timeout' ? `请求超过 ${timeout / 1000} 秒` : kind === 'connection' ? '连接中断，未收到完整响应' : '未能读取有效响应'
      throw new Error(`GitHub ${kind === 'timeout' ? '超时' : '连接失败'}（${stage}）：${reason}${read && kind ? '；已重试 2 次' : ''}。请检查网络或系统代理后重试；这不等于 Token 无效。${read ? '' : '本次写入结果未确认，远端可能已接收，请重新检查同步状态。'}`)
    }
  }
}
