import { expect, it } from 'vitest'
import { accountFromCookies, buildBookmarkCall, captureFromHttp, cookiesFromList, cookiesFromStorage, endpointFromRequest, hasLoginCookies } from '../src/main/x-auth'

it('从 storageState 提取 x.com Cookie，忽略其他域', () => {
  const cookies = cookiesFromStorage({
    cookies: [
      { name: 'auth_token', value: 'token', domain: '.x.com', path: '/', secure: true, httpOnly: true },
      { name: 'ct0', value: 'csrf', domain: '.x.com', path: '/', secure: true },
      { name: 'other', value: 'no', domain: '.example.com', path: '/' }
    ]
  })
  expect(hasLoginCookies(cookies)).toBe(true)
  expect(cookies.map(c => c.name).sort()).toEqual(['auth_token', 'ct0'])
  expect(cookies.find(c => c.name === 'auth_token')?.httpOnly).toBe(true)
})

it('从 Cookie 列表提取登录字段', () => {
  expect(hasLoginCookies(cookiesFromList([
    { name: 'auth_token', value: 'token', domain: '.x.com', path: '/', secure: true, httpOnly: true },
    { name: 'ct0', value: 'csrf', domain: '.x.com', path: '/', secure: true }
  ]))).toBe(true)
})

it('缺少登录字段时不算已登录', () => {
  expect(hasLoginCookies(cookiesFromStorage({ cookies: [{ name: 'ct0', value: 'csrf', domain: '.x.com', path: '/' }] }))).toBe(false)
})

it('从 twid Cookie 识别账号', () => {
  expect(accountFromCookies([{ name: 'twid', value: 'u%3D123456789' }])).toBe('123456789')
  expect(accountFromCookies([{ name: 'twid', value: 'u=987' }])).toBe('987')
  expect(accountFromCookies([{ name: 'ct0', value: 'x' }])).toBe('')
})

it('复用页面捕获的 Bookmarks POST 特征', () => {
  const captured = captureFromHttp('https://x.com/i/api/graphql/LiveId/Bookmarks', 'POST', { authorization: 'Bearer AAA' }, JSON.stringify({ features: { live: true }, fieldToggles: { withArticlePlainText: false } }))
  expect(captured?.id).toBe('LiveId')
  expect(captured?.method).toBe('POST')
  const call = buildBookmarkCall(captured!, { count: 20 }, { fallback: true })
  expect(call.method).toBe('POST')
  expect(call.body).toContain('"live":true')
  expect(call.body).not.toContain('fallback')
})

it('从 GraphQL 请求解析 Bookmarks 端点', () => {
  const found = endpointFromRequest('https://x.com/i/api/graphql/tF6KOjmZM0WGcB2Q0mfwhw/Bookmarks?variables=%7B%7D', { authorization: 'Bearer AAAAAATEST' })
  expect(found).toMatchObject({ id: 'tF6KOjmZM0WGcB2Q0mfwhw', bearer: 'AAAAAATEST' })
  expect(endpointFromRequest('https://api.x.com/graphql/tF6KOjmZM0WGcB2Q0mfwhw/Bookmarks', { authorization: 'Bearer AAAAAATEST' })?.id).toBe('tF6KOjmZM0WGcB2Q0mfwhw')
  expect(endpointFromRequest('https://x.com/i/api/graphql/abc/HomeTimeline')).toBeUndefined()
  expect(endpointFromRequest('https://evil.example/i/api/graphql/abc/Bookmarks')).toBeUndefined()
})
