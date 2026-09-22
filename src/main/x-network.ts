import { networkFailure } from './network-error'
import { browserHeaders } from './x-client'
import { session } from 'electron'
import { X_PARTITION } from './x-auth'

// Same persistent partition as the in-app login window: system proxy and remembered cookies.
export const xNetworkFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.protocol !== 'https:' || !['x.com','api.x.com','twitter.com','abs.twimg.com','pbs.twimg.com'].includes(url.hostname) || url.username || url.password) throw new Error('X 请求地址不在允许范围')
  try {
    const headers = { ...browserHeaders(), ...(init?.headers as Record<string, string> | undefined) }
    return await session.fromPartition(X_PARTITION).fetch(url.href, { ...init, headers, credentials: init?.credentials ?? 'include', redirect: init?.redirect ?? 'error', signal: init?.signal || AbortSignal.timeout(30_000) })
  } catch(e) { throw networkFailure(e,url.hostname) }
}
