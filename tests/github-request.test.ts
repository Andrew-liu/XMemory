import { afterEach, expect, it, vi } from 'vitest'
import { githubJson } from '../src/main/github-request'

afterEach(() => vi.useRealTimers())
const url = 'https://api.github.com/user'
it('响应正文 terminated 后重试整个读取，成功返回', async () => {
  vi.useFakeTimers()
  let calls = 0
  const statuses: string[] = []
  const task = githubJson(async () => {
    calls++
    if (calls === 1) return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('terminated')) } }))
    return Response.json({ login: 'synthetic' })
  }, url, { method: 'GET' }, '验证 Token', s => statuses.push(s))
  await vi.runAllTimersAsync()
  expect((await task).data.login).toBe('synthetic')
  expect(calls).toBe(2)
  expect(statuses.join('')).toContain('网络重试 1/2')
})
it.each(['terminated', 'timeout'])('网络 %s 最多三次请求，错误包含步骤且不回显凭据', async type => {
  vi.useFakeTimers()
  let calls = 0
  const task = githubJson(async () => {
    calls++
    throw type === 'timeout' ? new DOMException('secret', 'TimeoutError') : new TypeError('terminated secret')
  }, url, { method: 'GET' }, '验证 Token', () => {}).catch(e => e as Error)
  await vi.runAllTimersAsync()
  const error = await task as Error
  expect(calls).toBe(3)
  expect(error.message).toContain('验证 Token')
  expect(error.message).toContain('已重试 2 次')
  expect(error.message).not.toContain('secret')
})
it('HTTP 401 不读取损坏正文、不重试，保留认证状态码', async () => {
  let calls = 0
  const result = await githubJson(async () => {
    calls++
    return new Response(new ReadableStream({ start(c) { c.error(new TypeError('terminated')) } }), { status: 401 })
  }, url, {}, '验证 Token', () => {})
  expect(calls).toBe(1)
  expect(result.response.status).toBe(401)
})
it('写入中断不自动重试，提示远端结果不确定', async () => {
  let calls = 0
  await expect(githubJson(async () => { calls++; throw new TypeError('fetch failed') }, url, { method: 'PATCH' }, '更新远端分支', () => {})).rejects.toThrow('远端可能已接收')
  expect(calls).toBe(1)
})
