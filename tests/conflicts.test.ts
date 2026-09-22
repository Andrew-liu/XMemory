import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Library, equivalentMarkdown, hash, mergeCompletionTimeOnly } from '../src/main/library'
import { GithubSync } from '../src/main/sync'
import { conflictFields } from '../src/shared/conflicts'

const root = path.resolve('../../trash/xmemeory-dev/conflicts-unit')
mkdirSync(root, { recursive: true })
const libraries: Library[] = []
function library() { const l = new Library(mkdtempSync(path.join(root, 'library-'))); libraries.push(l); return l }
afterEach(async () => { for (const l of libraries.splice(0)) await l.close() })

it('等价比较忽略换行/BOM/YAML 顺序，不忽略正文空格与任意附加字段', () => {
  const a = '---\ntitle: 标题\ncustom: 保留\n---\n正文\n'
  const b = '\uFEFF---\r\ncustom: "保留"\r\ntitle: 标题\r\n---\r\n正文\r\n'
  expect(equivalentMarkdown(a, b)).toBe(true)
  for (const other of [a.replace('正文', '正文 '), a.replace('保留', '修改'), a.replace('标题', '新标题')]) expect(equivalentMarkdown(a, other)).toBe(false)
})

it('正文和完成状态相同时仅 completedAt 不同，自动采用较早时间', () => {
  const earlier = '---\ntitle: 标题\ncompleted: true\ncompletedAt: 2026-09-20T13:01:39.859Z\n---\n正文'
  const later = earlier.replace('13:01:39.859', '15:07:26.921')
  expect(mergeCompletionTimeOnly(earlier, later)).toBe(earlier)
  expect(mergeCompletionTimeOnly(later, earlier)).toBe(earlier)
  for (const other of [later.replace('正文', '修改'), later.replace('标题', '新标题'), later.replace('completed: true', 'completed: false')]) expect(mergeCompletionTimeOnly(earlier, other)).toBeUndefined()
})

it('首次同步无共同基线但内容等价时不创建冲突，上传保留本地格式', async () => {
  const l = library(), n = l.save({ kind: 'inspiration', title: '相同', body: '正文\n' })
  const remote = readFileSync(path.join(l.root, n.path), 'utf8').replace(/\n/g, '\r\n')
  const sync = new GithubSync(l, () => {}, async (input, init) => {
    const endpoint = String(input).split('/synthetic')[1]
    if (!endpoint) return Response.json({ private: true })
    if (init?.method === 'GET') {
      if (endpoint === '/git/ref/heads/master') return Response.json({ object: { sha: 'head' } })
      if (endpoint === '/git/commits/head') return Response.json({ tree: { sha: 'tree' } })
      if (endpoint === '/git/trees/tree?recursive=1') return Response.json({ tree: [{ path: n.path, mode: '100644', type: 'blob', sha: 'file', size: remote.length }], truncated: false })
      if (endpoint === '/git/blobs/file') return Response.json({ content: Buffer.from(remote).toString('base64'), encoding: 'base64' })
      throw new Error('Unexpected request')
    }
    return Response.json({ sha: 'synthetic' })
  })
  await sync.run('example/synthetic', 'master', 'github_pat_synthetic')
  expect(l.conflicts.size).toBe(0)
  expect(l.get(n.id).body).toBe('正文\n')
})

it('已有的 completedAt-only 冲突自动采用较早时间并归档', () => {
  const l = library(), n = l.save({ kind: 'inspiration', title: '完成时间', body: '相同正文', completed: true })
  const currentRaw = readFileSync(path.join(l.root, n.path), 'utf8')
  const currentTime = String(l.get(n.id).completedAt)
  const earlierTime = new Date(Date.parse(currentTime) - 60_000).toISOString()
  const incomingRaw = currentRaw.replace(`completedAt: ${currentTime}`, `completedAt: ${earlierTime}`)
  l.addConflict(n, { ...n, hash: hash(incomingRaw), completedAt: earlierTime }, { currentRaw, incomingRaw })
  const conflictFile = [...l.conflicts.keys()][0]
  l.refresh()
  expect(l.conflicts.size).toBe(0)
  expect(l.get(n.id).completedAt).toBe(earlierTime)
  expect(JSON.parse(readFileSync(path.join(l.root, 'conflicts', `${conflictFile}.json`), 'utf8')).reason).toBe('completion-time')
  expect(readdirSync(path.join(l.root, 'local')).some(f => f.startsWith('conflict-'))).toBe(true)
})

it.each(['incoming', 'both'] as const)('正文相同字段不同仍可显示并完整采用版本：%s', action => {
  const l = library(), n = l.save({ kind: 'inspiration', title: '本地标题', body: '相同正文' })
  const a = readFileSync(path.join(l.root, n.path), 'utf8')
  const b = a.replace('本地标题', '远端标题').replace('completed: false', 'completed: true\ncustom: 自定义内容')
  l.addConflict(n, { ...n, title: '远端标题', hash: hash(b) }, { currentRaw: a, incomingRaw: b })
  const c = [...l.conflicts.values()][0]
  expect(conflictFields(c).map(f => f.key)).toEqual(['completed', 'custom', 'title'])
  l.resolve(c.id, action)
  const adopted = [...l.notes.values()].find(note => note.title.startsWith('远端标题'))!
  expect(adopted.completed).toBe(true)
  expect(readFileSync(path.join(l.root, adopted.path), 'utf8')).toContain('custom: 自定义内容')
  expect(l.notes.size).toBe(action === 'both' ? 2 : 1)
})

it('可证等价历史冲突归档但保留恢复副本；不完整旧记录不丢弃', () => {
  const l = library(), n = l.save({ kind: 'inspiration', title: '历史', body: '相同' })
  const a = readFileSync(path.join(l.root, n.path), 'utf8'), b = a.replace(/\n/g, '\r\n')
  l.addConflict(n, { ...n, hash: hash(b) }, { currentRaw: a, incomingRaw: b })
  const id = [...l.conflicts.keys()][0]
  l.refresh()
  expect(l.conflicts.size).toBe(0)
  expect(JSON.parse(readFileSync(path.join(l.root, 'conflicts', `${id}.json`), 'utf8')).resolved).toBe(true)
  expect(readdirSync(path.join(l.root, 'local')).some(f => f.startsWith('conflict-'))).toBe(true)
  l.addConflict(n, { ...n, hash: 'unknown-legacy-hash' })
  l.refresh()
  expect(l.conflicts.size).toBe(1)
})

it('同一文件的历史冲突链自动收敛为最新一条并保留恢复记录', () => {
  const l = library(), n = l.save({ kind: 'inspiration', title: '冲突链', body: '本地正文' })
  const currentRaw = readFileSync(path.join(l.root, n.path), 'utf8')
  for (let index = 0; index < 7; index++) {
    const incomingRaw = currentRaw.replace('本地正文', `远端版本 ${index}`)
    const conflict = {
      id: `chain-${index}`, noteId: n.id, title: n.title, current: { ...n, hash: index < 5 ? `old-current-${index % 2}` : n.hash },
      incoming: { ...n, body: `远端版本 ${index}`, hash: hash(incomingRaw) }, currentRaw, incomingRaw,
      createdAt: new Date(Date.UTC(2026, 8, 21, 12, index)).toISOString()
    }
    writeFileSync(path.join(l.root, 'conflicts', `${conflict.id}.json`), JSON.stringify(conflict))
  }
  l.refresh()
  expect(l.conflicts.size).toBe(1)
  expect([...l.conflicts.values()][0].incoming.body).toBe('远端版本 6')
  const markers = readdirSync(path.join(l.root, 'conflicts')).map(file => JSON.parse(readFileSync(path.join(l.root, 'conflicts', file), 'utf8')))
  expect(markers.filter(value => value.reason === 'superseded')).toHaveLength(6)
  expect(readdirSync(path.join(l.root, 'local')).filter(file => file.startsWith('conflict-'))).toHaveLength(6)
})

it('处理期间原文再次变化时只刷新一条比较，重新确认后可完成', () => {
  const l = library(), n = l.save({ kind: 'inspiration', title: '并发变化', body: '版本 A' })
  const currentRaw = readFileSync(path.join(l.root, n.path), 'utf8')
  const incomingRaw = currentRaw.replace('版本 A', '版本 B')
  l.addConflict(n, { ...n, body: '版本 B', hash: hash(incomingRaw) }, { currentRaw, incomingRaw })
  const stale = [...l.conflicts.keys()][0]
  writeFileSync(path.join(l.root, n.path), currentRaw.replace('版本 A', '版本 C'))
  expect(() => l.resolve(stale, 'incoming')).toThrow('比较内容已刷新')
  expect(l.conflicts.size).toBe(1)
  const refreshed = [...l.conflicts.values()][0]
  expect(refreshed.id).not.toBe(stale)
  expect(refreshed.current.body).toBe('版本 C')
  l.resolve(refreshed.id, 'incoming')
  expect(l.conflicts.size).toBe(0)
  expect(l.get(n.id).body).toBe('版本 B')
})

it.each([
  ['current', undefined, '版本 A'],
  ['merge', '手动合并', '手动合并']
] as const)('采用 A 或手动合并后不会残留同文件活动冲突：%s', (action, body, expected) => {
  const l = library(), n = l.save({ kind: 'inspiration', title: '完整处理', body: '版本 A' })
  l.addConflict(n, { ...n, body: '版本 B', hash: hash('版本 B') })
  l.resolve([...l.conflicts.keys()][0], action, body)
  expect(l.conflicts.size).toBe(0)
  expect(l.get(n.id).body).toBe(expected)
})
