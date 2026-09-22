export function networkFailure(error: unknown, host: string) {
  const e = error as { name?: string; message?: string; cause?: {code?: string} }
  const code = e?.cause?.code || e?.message?.match(/net::ERR_[A-Z_]+/)?.[0] || (e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR')
  const safeCode = /^[A-Z_]+$|^net::ERR_[A-Z_]+$/.test(code) ? code : 'NETWORK_ERROR'
  const reason = /PROXY|TUNNEL/.test(safeCode) ? '系统代理连接失败，请确认代理已启动并允许此应用连接' : /CERT|TLS|SSL/.test(safeCode) ? '证书或 TLS 校验失败，请检查系统时间和代理证书' : /TIMEOUT|TIMED_OUT/.test(safeCode) ? '连接超时，请检查系统代理或网络' : /NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/.test(safeCode) ? '域名解析失败，请检查 DNS 或代理' : '网络连接失败，请检查系统代理或网络'
  return new Error(`${host}：${reason}（${safeCode}）。Cookie 已保留，此错误不代表 Cookie 失效。`)
}
