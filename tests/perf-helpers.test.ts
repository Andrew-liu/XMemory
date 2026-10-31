import { describe, expect, it } from 'vitest'
import { ASSET_SCHEME, assetURL, parseAssetURL } from '../src/shared/assets'
import { memoryMatches, memoryMatchesParsed, parseMemoryQuery } from '../src/renderer/Memory'
import type { Note } from '../src/shared/types'

const note = (patch: Partial<Note>): Note => ({ id: 'x-1-1', kind: 'memory', title: '标题', body: '正文 Hello World', tags: [], hash: 'h', path: 'memories/1/1.md', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', ...patch }) as Note

describe('图片协议地址', () => {
  it('生成后可还原，含中文、空格与特殊字符', () => {
    const url = assetURL('../../assets/图 1 & a.png', 'memories/1/1.md')
    expect(url.startsWith(`${ASSET_SCHEME}://library/`)).toBe(true)
    expect(parseAssetURL(url)).toEqual({ relative: '../../assets/图 1 & a.png', from: 'memories/1/1.md' })
  })
  it('拒绝其他协议、其他主机与缺少路径的地址', () => {
    expect(parseAssetURL('https://library/?p=a.png')).toBeUndefined()
    expect(parseAssetURL(`${ASSET_SCHEME}://other/?p=a.png`)).toBeUndefined()
    expect(parseAssetURL(`${ASSET_SCHEME}://library/`)).toBeUndefined()
    expect(parseAssetURL('not a url')).toBeUndefined()
  })
})

describe('记忆搜索缓存', () => {
  it('解析后的查询与字符串查询结果一致', () => {
    const n = note({ author: 'ElonMusk', source: 'https://x.com/a/status/9' })
    for (const q of ['hello', '@elon 正文', '@sama', 'status/9', '不存在的词', '']) {
      expect(memoryMatchesParsed(n, parseMemoryQuery(q))).toBe(memoryMatches(n, q))
    }
  })
  it('同一条笔记被替换为新对象后按新正文匹配', () => {
    const before = note({ body: '旧内容' })
    expect(memoryMatches(before, '新内容')).toBe(false)
    const after = { ...before, body: '新内容' }
    expect(memoryMatches(after, '新内容')).toBe(true)
    expect(memoryMatches(before, '旧内容')).toBe(true)
  })
})
