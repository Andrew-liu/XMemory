import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Library } from '../src/main/library'

const temporary = path.resolve(process.cwd(), '../../trash/xmemeory-dev/tests')
mkdirSync(temporary, { recursive: true })
const libraries: Library[] = []
afterEach(async () => { await Promise.all(libraries.splice(0).map(l => l.close())) })
const make = (changed = () => {}) => { const l = new Library(mkdtempSync(path.join(temporary, 'save-perf-')), changed); libraries.push(l); return l }
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const indexed = (l: Library, id: string) => (l.db.prepare('SELECT text FROM search WHERE id = ?').all(id) as { text: string }[]).map(row => row.text)

it('保存只重读这一条并更新单行索引，不全量刷新', () => {
  const l = make()
  const others = Array.from({ length: 5 }, (_, i) => l.save({ kind: 'inspiration', title: `其他${i}`, body: `内容${i}` }))
  const note = l.save({ kind: 'inspiration', title: '打字', body: '第一版' })
  const refresh = vi.spyOn(l, 'refresh')
  const saved = l.save({ ...note, body: '第二版正文' }, note.hash)
  expect(refresh).not.toHaveBeenCalled()
  expect(saved.body).toBe('第二版正文')
  expect(saved.hash).not.toBe(note.hash)
  expect(l.notes.size).toBe(6)
  expect(indexed(l, note.id)).toHaveLength(1)
  expect(indexed(l, note.id)[0]).toContain('第二版正文')
  for (const other of others) expect(indexed(l, other.id)).toHaveLength(1)
  const created = l.save({ kind: 'topic', title: '新选题', body: '大纲' })
  expect(refresh).not.toHaveBeenCalled()
  expect(l.get(created.id).title).toBe('新选题')
  expect(indexed(l, created.id)).toHaveLength(1)
})

it('静默保存不广播全量变更，普通保存照常广播', () => {
  let changes = 0
  const l = make(() => { changes++ })
  const note = l.save({ kind: 'inspiration', title: '静默', body: 'a' })
  changes = 0
  l.save({ ...note, body: 'b' }, note.hash, { quiet: true })
  expect(changes).toBe(0)
  const latest = l.get(note.id)
  l.save({ ...latest, body: 'c' }, latest.hash)
  expect(changes).toBe(1)
})

it('有待处理冲突的条目保存时仍走全量刷新', () => {
  const l = make()
  const note = l.save({ kind: 'inspiration', title: '冲突', body: '原文' })
  l.addConflict(note, { ...note, body: '另一版', hash: 'other' })
  const refresh = vi.spyOn(l, 'refresh')
  const current = l.get(note.id)
  l.save({ ...current, body: '继续编辑' }, current.hash)
  expect(refresh).toHaveBeenCalled()
})

it('文件监听跳过应用自己的写入，外部修改单个文件只增量重读', async () => {
  let changes = 0
  const l = make(() => { changes++ })
  const note = l.save({ kind: 'inspiration', title: '监听', body: '原文' })
  l.start()
  await wait(400)
  const refresh = vi.spyOn(l, 'refresh')
  changes = 0
  l.save({ ...l.get(note.id), body: '自己保存' }, l.get(note.id).hash, { quiet: true })
  await wait(1200)
  expect(changes).toBe(0)
  expect(refresh).not.toHaveBeenCalled()
  const file = path.join(l.root, l.get(note.id).path)
  writeFileSync(file, readFileSync(file, 'utf8').replace('自己保存', '外部编辑'))
  await wait(1500)
  expect(l.get(note.id).body).toBe('外部编辑')
  expect(indexed(l, note.id)[0]).toContain('外部编辑')
  expect(changes).toBeGreaterThan(0)
  expect(refresh).not.toHaveBeenCalled()
}, 10_000)
