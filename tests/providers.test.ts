import { expect, it } from 'vitest'
import { pruneSecrets } from '../src/main/providers'

it('凭据清理只保留 GitHub Token，其余密钥全部移除', () => {
  const secrets = { cookies: 'a', xState: 'b', xEndpoint: 'c', deepseek: 'd', github: 'keep' }
  expect(pruneSecrets(secrets)).toBe(true)
  expect(secrets).toEqual({ github: 'keep' })
})
it('仅有 GitHub Token 时不改写也不重写文件', () => {
  const secrets = { github: 'keep' }
  expect(pruneSecrets(secrets)).toBe(false)
  expect(secrets).toEqual({ github: 'keep' })
})
