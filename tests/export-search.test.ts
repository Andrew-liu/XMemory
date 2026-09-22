import { it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Library, walk } from '../src/main/library'
import { referencedImages } from '../src/main/export-images'
import { findSearchMatch } from '../src/shared/search-location'

it('解析标准、引用式及 Wiki 图片，忽略代码和普通链接', () => {
  expect(referencedImages('![a](assets/a.png)\n![b][pic]\n\n[pic]: <assets/b b.png>\n\n![[assets/c.png|200]]\n`![x](assets/no.png)`\n\n```md\n![x](assets/no2.png)\n```\n[link](assets/no3.png)\n![remote](https://example.com/a.png)')).toEqual(['assets/a.png', 'assets/b b.png', 'assets/c.png'])
})
it('仅导出当前笔记引用图片，去重并保留相对路径，缺失和越界图片阻止导出', () => {
  const base = path.resolve('../../trash/xmemeory-dev/export-tests')
  mkdirSync(base, { recursive: true })
  const library = new Library(mkdtempSync(path.join(base, 'library-')))
  try {
    writeFileSync(path.join(library.root, 'assets/a.png'), 'synthetic-a')
    writeFileSync(path.join(library.root, 'assets/unrelated.png'), 'synthetic-private')
    const linked = library.save({ title: 'other', kind: 'inspiration', body: '![](assets/unrelated.png)' })
    const note = library.save({ title: 'export', kind: 'inspiration', body: `![](../assets/a.png)\n![[assets/a.png]]\n[[${linked.title}]]` })
    const out = library.export(note.id, base)
    expect(walk(out).sort()).toEqual(['assets/a.png', note.path].sort())
    expect(readFileSync(path.join(out, note.path), 'utf8')).toBe(readFileSync(path.join(library.root, note.path), 'utf8'))
    expect(existsSync(path.join(out, linked.path))).toBe(false)
    const missing = library.save({ title: 'missing', kind: 'inspiration', body: '![](../assets/missing.png)' })
    expect(() => library.export(missing.id, base)).toThrow('引用图片缺失')
    const escape = library.save({ title: 'escape', kind: 'inspiration', body: '![](../../outside.png)' })
    expect(() => library.export(escape.id, base)).toThrow('路径越过资料库')
  } finally { library.close() }
})
it('定位中文、带引号短语、大小写、全角字符和表情后的准确原文范围', () => {
  for (const [text, query, expected] of [['前文目标后文', '目标', '目标'], ['a hello world z', '"hello world"', 'hello world'], ['😀ＡＢＣ中文', 'abc', 'ＡＢＣ'], ['前文foo 后文bar', 'bar foo', 'foo']]) {
    const match = findSearchMatch(text, query)!
    expect(text.slice(match.from, match.to)).toBe(expected)
  }
  expect(findSearchMatch('正文', '只有标题')).toBeUndefined()
})
