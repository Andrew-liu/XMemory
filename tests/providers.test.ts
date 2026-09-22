import { expect, it } from 'vitest'
import { validateProviders } from '../src/main/providers'
const p = { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://example.test', model: 'model' }
it('模型 ID 唯一、当前服务及 Key 归属必须有效', () => {
  expect(() => validateProviders([p], p.id, p.id)).not.toThrow()
  for (const run of [() => validateProviders([], ''), () => validateProviders([p, p], p.id), () => validateProviders([p], 'missing'), () => validateProviders([p], p.id, 'missing')]) expect(run).toThrow()
})
it.each(['github', 'cookies', 'xState', '__proto__', 'constructor', 'prototype'])('保留凭据 ID %s 不能用于模型', id => {
  expect(() => validateProviders([{ ...p, id }], id, id)).toThrow('保留名称')
})
