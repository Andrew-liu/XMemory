import type { Provider } from '../shared/types'

const reserved = new Set(['github', 'cookies', 'xState', '__proto__', 'prototype', 'constructor'])
export function validateProviders(providers: Provider[], active: string, secretId?: string) {
  const ids = providers.map(p => p.id)
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('至少保留一个服务，服务 ID 不能重复')
  if (ids.some(id => reserved.has(id) || !/^[\w-]{1,100}$/.test(id))) throw new Error('模型服务 ID 无效或使用了保留名称')
  if (!ids.includes(active)) throw new Error('请选择有效的模型服务')
  if (secretId !== undefined && !ids.includes(secretId)) throw new Error('只能为已有模型服务保存 Key')
}
