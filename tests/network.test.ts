import { expect, it } from 'vitest'
import { networkFailure } from '../src/main/network-error'
it('网络错误给出可操作原因，不泄漏底层敏感消息',()=>{
  const timeout=networkFailure({message:'fetch failed',cause:{code:'UND_ERR_CONNECT_TIMEOUT'}},'x.com')
  expect(timeout.message).toContain('连接超时')
  expect(timeout.message).toContain('Cookie 已保留')
  expect(networkFailure({message:'net::ERR_PROXY_CONNECTION_FAILED private-header-value'},'x.com').message).toContain('代理连接失败')
  expect(networkFailure({message:'secret-cookie-content'},'x.com').message).not.toContain('secret-cookie-content')
  expect(networkFailure({message:'net::ERR_CERT_AUTHORITY_INVALID'},'x.com').message).toContain('证书')
})
