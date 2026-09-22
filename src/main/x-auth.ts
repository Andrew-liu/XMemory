import type { CookieRecord } from './cookies'
import { X_PUBLIC_BEARER } from './x-client'

export const X_PARTITION = 'persist:xmemeory-x'
export interface StorageState {
  cookies?: Array<{ name: string; value: string; domain: string; path?: string; expires?: number; httpOnly?: boolean; secure?: boolean }>
  origins?: unknown[]
}
export interface CapturedEndpoint {
  id: string
  bearer: string
  method?: 'GET' | 'POST'
  origin?: string
  features?: Record<string, boolean>
  fieldToggles?: Record<string, unknown>
}

export function accountFromCookies(cookies: { name: string; value: string }[]) {
  const twid = cookies.find(c => c.name === 'twid')?.value || ''
  return decodeURIComponent(twid).match(/(?:^|;)u=(\d+)/)?.[1] || ''
}

export function captureFromHttp(url: string, method = 'GET', headers: Record<string, string> = {}, body?: string): CapturedEndpoint | undefined {
  let parsed: URL
  try { parsed = new URL(url) } catch { return }
  const match = parsed.pathname.match(/^(?:\/i\/api)?\/graphql\/([\w-]+)\/Bookmarks\/?$/)
  if (!match || parsed.protocol !== 'https:' || !['x.com', 'twitter.com', 'api.x.com'].includes(parsed.hostname)) return
  const authorization = headers.authorization || headers.Authorization || ''
  const bearer = authorization.replace(/^Bearer\s+/i, '') || X_PUBLIC_BEARER
  let features: Record<string, boolean> | undefined
  let fieldToggles: Record<string, unknown> | undefined
  const read = (raw?: string | null) => {
    if (!raw) return
    try { return JSON.parse(raw) as Record<string, unknown> } catch { return }
  }
  if (body) {
    const json = read(body)
    if (json && typeof json === 'object') {
      if (json.features && typeof json.features === 'object') features = json.features as Record<string, boolean>
      if (json.fieldToggles && typeof json.fieldToggles === 'object') fieldToggles = json.fieldToggles as Record<string, unknown>
    }
  }
  features ||= read(parsed.searchParams.get('features')) as Record<string, boolean> | undefined
  fieldToggles ||= read(parsed.searchParams.get('fieldToggles'))
  return {
    id: match[1],
    bearer,
    method: method.toUpperCase() === 'POST' ? 'POST' : 'GET',
    origin: `${parsed.origin}${parsed.pathname}`,
    features,
    fieldToggles
  }
}

export function cookiesFromStorage(state: StorageState): CookieRecord[] {
  return cookiesFromList(state.cookies || [])
}

export function cookiesFromList(list: Array<{ name?: string; value?: string; domain?: string; path?: string; expires?: number; expirationDate?: number; httpOnly?: boolean; secure?: boolean }>): CookieRecord[] {
  const unique = new Map<string, CookieRecord>()
  for (const cookie of list) {
    if (!cookie || !/\.?(x|twitter)\.com$/i.test(cookie.domain || '')) continue
    if (!cookie.name || !cookie.value || /[\r\n;]/.test(cookie.name + cookie.value)) continue
    unique.set(`${cookie.domain}:${cookie.path || '/'}:${cookie.name}`, {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain || '.x.com',
      path: cookie.path || '/',
      secure: !!cookie.secure,
      httpOnly: !!cookie.httpOnly,
      expirationDate: cookie.expires && cookie.expires > 0 ? cookie.expires : cookie.expirationDate
    })
  }
  return [...unique.values()]
}

export function hasLoginCookies(cookies: CookieRecord[]) {
  return cookies.some(c => c.name === 'auth_token') && cookies.some(c => c.name === 'ct0')
}

export function endpointFromRequest(url: string, headers: Record<string, string> = {}, method = 'GET', body?: string) {
  return captureFromHttp(url, method, headers, body)
}

export function buildBookmarkCall(endpoint: CapturedEndpoint, variables: Record<string, unknown>, fallbackFeatures: Record<string, boolean>) {
  const features = endpoint.features && Object.keys(endpoint.features).length ? endpoint.features : fallbackFeatures
  const origin = endpoint.origin || `https://x.com/i/api/graphql/${endpoint.id}/Bookmarks`
  const method = endpoint.method || 'GET'
  if (method === 'POST') {
    const payload: Record<string, unknown> = { variables, features, queryId: endpoint.id }
    if (endpoint.fieldToggles) payload.fieldToggles = endpoint.fieldToggles
    return { url: origin, method: 'POST' as const, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
  }
  const params = new URLSearchParams({ variables: JSON.stringify(variables), features: JSON.stringify(features) })
  if (endpoint.fieldToggles) params.set('fieldToggles', JSON.stringify(endpoint.fieldToggles))
  return { url: `${origin}?${params}`, method: 'GET' as const, headers: {}, body: undefined as string | undefined }
}
