import { session } from 'electron'

// Dedicated non-persistent session: system networking, no browser cookies.
export const githubNetworkFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' || url.port || url.username || url.password) throw new Error('GitHub 请求地址不在允许范围')
  return session.fromPartition('github-sync').fetch(url.href, { ...init, credentials: 'omit', redirect: 'error' })
}
