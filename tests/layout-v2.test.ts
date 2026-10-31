import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Library, decode, hash, walk } from '../src/main/library'
import { migrateFiles, migrateLibrary } from '../src/main/migrate'
import { collisionSuffixes, memoryPath, relativeImage, resolveImage, rewriteImageRefs, safeName } from '../src/main/layout'
import { sourceHash } from '../src/main/partial-retry'
import { referencedImages } from '../src/main/export-images'
import { PNG, fresh, legacyLibrary, snapshot, write } from './legacy-fixture'

const dirs: Library[] = []
afterAll(async () => { for (const l of dirs) await l.close() })

describe('布局规则', () => {
  it('记忆文件名为“日期 作者 - 标题”，去除非法字符并限制长度', () => {
    expect(memoryPath({ publishedAt: '2026-09-13T12:00:00.000Z', author: 'alice', title: '星舰 试飞' })).toBe('memories/2026/2026-09-13 alice - 星舰 试飞.md')
    const p = memoryPath({ publishedAt: '2026-09-13T12:00:00.000Z', author: 'a/b:c', title: '标题?*<>|#^[]\\' + '长'.repeat(200) })
    expect(path.posix.basename(p)).not.toMatch(/[\\/:*?"<>|#^[\]]/)
    expect([...path.posix.basename(p)].length).toBeLessThanOrEqual(120)
    expect(memoryPath({ createdAt: '2026-01-02T00:00:00.000Z' })).toBe('memories/2026/2026-01-02 X - 无标题.md')
  })
  it('冲突后缀先用推文 ID，再用完整 ID', () => {
    expect(collisionSuffixes('x-11-222')).toEqual(['222', 'x-11-222'])
    expect(collisionSuffixes('abc')).toEqual(['abc'])
    expect(safeName('  ..a  b..  ')).toBe('a b')
  })
  it('图片引用按笔记层级解析，assets/ 与 attachments/ 按库根解析', () => {
    expect(resolveImage('../../assets/a.png', 'memories/11/1.md')).toBe('assets/a.png')
    expect(resolveImage('../../attachments/a b.png', 'memories/2026/x.md')).toBe('attachments/a b.png')
    expect(resolveImage('../attachments/a%20b.png', 'inspirations/x.md')).toBe('attachments/a b.png')
    expect(resolveImage('attachments/a.png', 'memories/2026/x.md')).toBe('attachments/a.png')
    expect(relativeImage('attachments/a.png', 'memories/2026/x.md')).toBe('../../attachments/a.png')
    expect(relativeImage('attachments/a.png', '.xmemeory/trash/memories/2026/x.md')).toBe('../../attachments/a.png')
  })
  it('改写 assets 图片引用，代码块与外链不动，Wiki 嵌入用库路径', () => {
    const body = '![a](../../assets/a.png)\n`![x](../../assets/c.png)`\n```\n![y](../../assets/d.png)\n```\n![r](https://e.com/a.png)\n![[assets/b.png|200]]\n![s](<../../assets/e f.png>)\n[l](../../assets/z.png)'
    const out = rewriteImageRefs(body, 'memories/11/1.md', 'memories/2026/n.md')
    expect(out).toContain('![a](../../attachments/a.png)')
    expect(out).toContain('`![x](../../assets/c.png)`')
    expect(out).toContain('![y](../../assets/d.png)')
    expect(out).toContain('![r](https://e.com/a.png)')
    expect(out).toContain('![[attachments/b.png|200]]')
    expect(out).toContain('![s](<../../attachments/e f.png>)')
    expect(out).toContain('[l](../../assets/z.png)')
  })
})

describe('迁移（纯函数）', () => {
  it('同样的输入得到同样的输出，同名记忆用推文 ID 区分', () => {
    const { root } = legacyLibrary()
    const input = new Map<string, Buffer>()
    for (const f of walk(root)) if (/^(memories|inspirations|topics)\//.test(f) || f === 'manifest.json' || f.startsWith('assets/') || /^(metadata|tombstones)\//.test(f)) input.set(f, readFileSync(path.join(root, f)))
    const a = migrateFiles(input), b = migrateFiles(new Map([...input].reverse()))
    expect([...a.files.keys()].sort()).toEqual([...b.files.keys()].sort())
    const names = [...a.files.keys()].filter(f => f.startsWith('memories/'))
    expect(names).toContain('memories/2026/2026-09-13 alice - 星舰 试飞.md')
    expect(names).toContain('memories/2026/2026-09-13 alice - 星舰 试飞 (333).md')
    expect(new Set(names.map(f => f.toLocaleLowerCase())).size).toBe(names.length)
  })
})

describe('迁移（磁盘）', () => {
  it('升级后：结构、字段、图片引用、基线一致，条目与正文不丢', () => {
    const { root, source } = legacyLibrary()
    const result = migrateLibrary(root)!
    expect(result.notes).toBe(5)
    expect(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')).schemaVersion).toBe(2)
    expect(readdirSync(root).filter(f => !f.startsWith('.')).sort()).toEqual(['attachments', 'drafts', 'inspirations', 'manifest.json', 'memories', 'topics'])
    expect(existsSync(path.join(root, '.obsidian/app.json'))).toBe(true)
    expect(existsSync(path.join(root, `attachments/${hash(PNG)}.png`))).toBe(true)
    expect(existsSync(path.join(root, 'assets'))).toBe(false)
    // Sorted by ID, 222 keeps the plain name and 333 gets its tweet ID as suffix.
    const moved = 'memories/2026/2026-09-13 alice - 星舰 试飞.md'
    expect(existsSync(path.join(root, 'memories/2026/2026-09-13 alice - 星舰 试飞 (333).md'))).toBe(true)
    const { metadata, body } = decode(readFileSync(path.join(root, moved), 'utf8'))
    expect(metadata).toMatchObject({ xmemeory_id: 'x-11-222', title: '星舰 试飞', author: 'alice', aliases: ['星舰 试飞'] })
    expect(metadata.created).toBe('2026-09-14T08:30:00.000Z')
    expect(metadata.published).toBe('2026-09-13T20:00:00.000Z')
    expect(metadata).not.toHaveProperty('createdAt')
    expect(body).toBe(source.replace(`../../assets/`, `../../attachments/`))
    expect(referencedImages(body).map(r => resolveImage(r, moved)).every(f => existsSync(path.join(root, f)))).toBe(true)
    // The "source untouched since capture" proof must still hold for the rewritten body.
    const capture = JSON.parse(readFileSync(path.join(root, '.xmemeory/metadata/x-11-222.capture.json'), 'utf8'))
    expect(capture.sourceHash).toBe(sourceHash(body))
    expect(Object.values(capture.localImages)[0]).toBe(`../../attachments/${hash(PNG)}.png`)
    expect(existsSync(path.join(root, '.xmemeory/tombstones/x-11-444.json'))).toBe(true)
    expect(existsSync(path.join(root, '.xmemeory/local/sync-0123456789abcdef.json'))).toBe(true)
    expect(existsSync(path.join(result.backup, 'manifest.json'))).toBe(true)
    expect(existsSync(path.join(root, '.xmemeory/migration.json'))).toBe(false)
  })
  it('升级后用 Library 打开：全部条目可读，已删除的进回收站目录，笔记正文一字不差', async () => {
    const { root } = legacyLibrary()
    const before = new Map<string, string>()
    for (const f of ['memories/11/222.md', 'memories/11/333.md', 'memories/11/444.md', 'inspirations/idea-1.md', 'topics/topic-1.md']) before.set(decode(readFileSync(path.join(root, f), 'utf8')).metadata.xmemeory_id as string, decode(readFileSync(path.join(root, f), 'utf8')).body.replaceAll('assets/', 'attachments/'))
    migrateLibrary(root)
    const lib = new Library(root); dirs.push(lib)
    expect(lib.notes.size).toBe(5)
    for (const [id, body] of before) expect(lib.get(id).body).toBe(body)
    const trashed = lib.get('x-11-444')
    expect(trashed.deleted).toBe(true)
    expect(trashed.path.startsWith('.xmemeory/trash/memories/')).toBe(true)
    expect(readdirSync(path.join(root, 'memories/2026')).some(f => f.includes('已删除'))).toBe(false)
    expect(lib.get('x-11-222').createdAt).toBe('2026-09-14T08:30:00.000Z')
    expect(lib.get('x-11-222').publishedAt).toBe('2026-09-13T20:00:00.000Z')
  })
  it('升级后再次打开不重复升级，旧版 manifest 的库用 Library 直接打开会被拒绝', () => {
    const { root } = legacyLibrary()
    expect(() => new Library(root)).toThrow('尚未升级')
    migrateLibrary(root)
    const state = snapshot(root)
    expect(migrateLibrary(root)).toBeUndefined()
    expect(snapshot(root)).toEqual(state)
  })
  it('中途中断后重新升级：从备份恢复再完成，结果与一次完成相同', () => {
    const a = legacyLibrary(), b = legacyLibrary()
    expect(() => migrateLibrary(a.root, new Date('2026-10-31T00:00:00Z'), 'after-write')).toThrow('模拟中断')
    expect(existsSync(path.join(a.root, '.xmemeory/migration.json'))).toBe(true)
    migrateLibrary(a.root, new Date('2026-10-31T01:00:00Z'))
    migrateLibrary(b.root, new Date('2026-10-31T00:00:00Z'))
    const strip = (root: string) => Object.fromEntries(Object.entries(snapshot(root)).filter(([f]) => !f.includes('backup-') && !f.startsWith('.xmemeory/local/')))
    const walkAll = (root: string) => [...walk(root), ...walk(root, '.xmemeory/metadata'), ...walk(root, '.xmemeory/tombstones')].filter(f => !f.includes('backup-'))
    expect(walkAll(a.root).sort()).toEqual(walkAll(b.root).sort())
    for (const f of walkAll(a.root)) expect(hash(readFileSync(path.join(a.root, f)))).toBe(hash(readFileSync(path.join(b.root, f))))
    expect(Object.keys(strip(a.root)).length).toBeGreaterThan(0)
    expect(readdirSync(path.join(a.root, '.xmemeory')).filter(f => f.startsWith('backup-'))).toHaveLength(1)
  })
  it('校验失败自动回滚到升级前，旧版文件逐字节一致', () => {
    const { root } = legacyLibrary()
    const before = snapshot(root)
    expect(() => migrateLibrary(root, new Date(), 'verify')).toThrow('已从备份恢复原状')
    expect(snapshot(root)).toEqual(before)
    expect(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')).schemaVersion).toBe(1)
    expect(existsSync(path.join(root, '.xmemeory/migration.json'))).toBe(false)
  })
  it('升级前有未完成的保存时先落盘，不丢最后一次编辑', () => {
    const { root } = legacyLibrary()
    const file = 'inspirations/idea-1.md'
    const before = readFileSync(path.join(root, file), 'utf8')
    write(root, 'local/pending.json', JSON.stringify({ path: file, before: hash(before), raw: before.replace('灵感正文', '中断前的最后编辑') }))
    migrateLibrary(root)
    const lib = new Library(root); dirs.push(lib)
    expect(lib.get('idea-1').body).toContain('中断前的最后编辑')
  })
})

describe('v2 读写', () => {
  const open = () => { const root = fresh(); const lib = new Library(root); dirs.push(lib); return lib }
  it('新库直接是 v2：私有数据只在 .xmemeory，根目录只有笔记与附件，带 Obsidian 配置', () => {
    const lib = open()
    lib.save({ kind: 'inspiration', title: '灵感', body: '正文' })
    expect(readdirSync(lib.root).filter(f => !f.startsWith('.')).sort()).toEqual(['attachments', 'drafts', 'inspirations', 'manifest.json', 'memories', 'topics'])
    expect(JSON.parse(readFileSync(path.join(lib.root, '.obsidian/app.json'), 'utf8')).attachmentFolderPath).toBe('attachments')
    expect(existsSync(path.join(lib.root, '.xmemeory/local/index.sqlite'))).toBe(true)
    expect(existsSync(path.join(lib.root, '.xmemeory/metadata'))).toBe(true)
  })
  it('不覆盖已有的 .obsidian 配置', () => {
    const root = fresh(); write(root, '.obsidian/app.json', '{"mine":true}')
    const lib = new Library(root); dirs.push(lib)
    expect(readFileSync(path.join(root, '.obsidian/app.json'), 'utf8')).toBe('{"mine":true}')
  })
  it('Front Matter 使用 Obsidian 字段，标题进入 aliases，读取兼容旧字段', () => {
    const lib = open()
    const n = lib.save({ id: 'x-5-66', kind: 'memory', title: '好书签', body: '正文', author: 'carol', publishedAt: '2026-05-06T10:00:00.000Z', source: 'https://x.com/carol/status/66' })
    const meta = decode(readFileSync(path.join(lib.root, n.path), 'utf8')).metadata
    expect(meta).toMatchObject({ xmemeory_id: 'x-5-66', aliases: ['好书签'], author: 'carol', published: '2026-05-06T10:00:00.000Z' })
    expect(meta.created).toBeTypeOf('string'); expect(meta).not.toHaveProperty('createdAt'); expect(meta).not.toHaveProperty('publishedAt')
    write(lib.root, 'inspirations/legacy.md', '---\nxmemeory_id: legacy\ntype: inspiration\ntitle: 旧字段\ncreatedAt: 2020-01-01T00:00:00.000Z\npublishedAt: 2020-01-02T00:00:00.000Z\n---\n旧')
    lib.refresh()
    expect(lib.get('legacy')).toMatchObject({ createdAt: '2020-01-01T00:00:00.000Z', publishedAt: '2020-01-02T00:00:00.000Z' })
    lib.save({ ...lib.get('legacy'), body: '新' }, lib.get('legacy').hash)
    const saved = decode(readFileSync(path.join(lib.root, 'inspirations/legacy.md'), 'utf8')).metadata
    expect(saved).toMatchObject({ created: '2020-01-01T00:00:00.000Z', published: '2020-01-02T00:00:00.000Z' })
    expect(saved).not.toHaveProperty('createdAt')
  })
  it('同名记忆自动区分，重名不覆盖', () => {
    const lib = open()
    const a = lib.save({ id: 'x-1-100', kind: 'memory', title: '同名', body: 'A', author: 'dave', publishedAt: '2026-03-04T00:00:00.000Z' })
    const b = lib.save({ id: 'x-1-200', kind: 'memory', title: '同名', body: 'B', author: 'dave', publishedAt: '2026-03-04T00:00:00.000Z' })
    expect(a.path).not.toBe(b.path)
    expect(b.path).toContain('(200)')
    expect(lib.get(a.id).body).toBe('A'); expect(lib.get(b.id).body).toBe('B')
  })
  it('改标题不改文件名；文件名只在新建时确定', () => {
    const lib = open()
    const n = lib.save({ id: 'x-1-9', kind: 'memory', title: '旧标题', body: 'x', author: 'e', publishedAt: '2026-03-04T00:00:00.000Z' })
    const renamed = lib.save({ ...n, title: '新标题' }, n.hash)
    expect(renamed.path).toBe(n.path)
  })
  it('删除把文件移入 .xmemeory/trash 并保留原相对路径，恢复移回原处', () => {
    const lib = open()
    const n = lib.save({ id: 'x-1-77', kind: 'memory', title: '要删', body: 'x', author: 'f', publishedAt: '2026-03-04T00:00:00.000Z' })
    const original = n.path
    lib.remove(n.id)
    expect(existsSync(path.join(lib.root, original))).toBe(false)
    expect(existsSync(path.join(lib.root, '.xmemeory/trash', original))).toBe(true)
    expect(lib.get(n.id)).toMatchObject({ deleted: true, path: `.xmemeory/trash/${original}` })
    lib.refresh()
    expect(lib.get(n.id)).toMatchObject({ deleted: true, path: `.xmemeory/trash/${original}` })
    expect(lib.search({ deleted: true })).toHaveLength(1)
    lib.remove(n.id, true)
    expect(existsSync(path.join(lib.root, original))).toBe(true)
    expect(existsSync(path.join(lib.root, '.xmemeory/trash', original))).toBe(false)
    expect(lib.get(n.id)).toMatchObject({ deleted: false, path: original })
    lib.refresh()
    expect(lib.get(n.id).path).toBe(original)
  })
  it('回收站里的笔记可导出，恢复后可继续保存', () => {
    const lib = open()
    const n = lib.save({ kind: 'inspiration', title: '临时', body: '内容' })
    lib.remove(n.id)
    const out = lib.export(n.id, fresh())
    expect(walk(out)).toEqual([`inspirations/${n.id}.md`])
    lib.remove(n.id, true)
    expect(() => lib.save({ ...lib.get(n.id), body: '改了' }, lib.get(n.id).hash)).not.toThrow()
  })
  it('旧版（v0.6.0）写出的 v1 库被拒绝且不被改动', () => {
    const { root } = legacyLibrary()
    const before = snapshot(root)
    expect(() => new Library(root)).toThrow()
    expect(snapshot(root)).toEqual(before)
  })
  it('新增的图片进入 attachments/，同内容只存一份', () => {
    const lib = open()
    expect(lib.addImage(PNG, 'a')).toBe(`attachments/${hash(PNG)}.png`)
    lib.addImage(PNG, 'b')
    expect(readdirSync(path.join(lib.root, 'attachments'))).toHaveLength(1)
  })
})
