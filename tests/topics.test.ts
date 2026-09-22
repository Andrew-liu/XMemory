import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Library } from '../src/main/library'
import { GithubSync, syncAllowed } from '../src/main/sync'
import { sortTopics, topicTemplate } from '../src/shared/topics'

const root = path.resolve('../../trash/xmemeory-dev/topics-unit')
mkdirSync(root, { recursive: true })
const libraries: Library[] = []
function library() { const l = new Library(mkdtempSync(path.join(root, 'library-'))); libraries.push(l); return l }
afterEach(async () => { for (const l of libraries.splice(0)) await l.close() })

it('选题以 Markdown 持久化，搜索、外部编辑、完成状态、删除恢复和导出可用', () => {
  const l = library()
  const n = l.save({ kind: 'topic', title: '长文选题', body: topicTemplate + '可检索的正文' })
  expect(n.path).toBe(`topics/${n.id}.md`)
  const file = path.join(l.root, n.path)
  expect(readFileSync(file, 'utf8')).toContain('type: topic')
  expect(l.search({ kind: 'topic', query: '可检索' }).map(n => n.id)).toEqual([n.id])
  const completed = l.save({ ...n, completed: true }, n.hash)
  expect(completed.completedAt).toBeTruthy()
  writeFileSync(file, readFileSync(file, 'utf8').replace('completed: true', 'completed: false').replace('可检索的正文', '外部修改正文'))
  l.refresh()
  expect(l.get(n.id).completed).toBe(false)
  expect(l.get(n.id).body).toContain('外部修改正文')
  l.remove(n.id)
  expect(l.search({ kind: 'topic' })).toHaveLength(0)
  l.remove(n.id, true)
  expect(l.search({ kind: 'topic' })).toHaveLength(1)
  const destination = path.join(l.root, 'local/export')
  const exported = l.export(n.id, destination)
  expect(readFileSync(path.join(exported, n.path), 'utf8')).toContain('外部修改正文')
})

it('未完成优先，组内创建日期倒序且编辑不重排，完成可以撤销', () => {
  const l = library()
  const a = { ...l.save({ kind: 'topic', title: 'A', body: '' }), createdAt: '2026-01-01', updatedAt: '2026-03-01' }
  const b = { ...l.save({ kind: 'topic', title: 'B', body: '' }), createdAt: '2026-02-01' }
  const c = { ...l.save({ kind: 'topic', title: 'C', body: '', completed: true }), createdAt: '2026-03-01' }
  expect(sortTopics([a, c, b]).map(n => n.title)).toEqual(['B', 'A', 'C'])
  expect(sortTopics([a, { ...c, completed: false }, b]).map(n => n.title)).toEqual(['C', 'B', 'A'])
})

it('选题与附件进入同步树，本地文件与凭据不进入同步', async () => {
  const l = library()
  const n = l.save({ kind: 'topic', title: '同步选题', body: '![图片](../assets/topic.png)', completed: true })
  writeFileSync(path.join(l.root, 'assets/topic.png'), Buffer.from([1, 2, 3]))
  for (const file of [n.path, 'assets/topic.png']) expect(syncAllowed(file)).toBe(true)
  for (const file of ['local/index.sqlite', 'local/secrets.json', 'topics/key.txt']) expect(syncAllowed(file)).toBe(false)
  const writes: Array<{ endpoint: string; body: any }> = []
  const sync = new GithubSync(l, () => {}, async (input, init) => {
    const url = String(input)
    if (url === 'https://api.github.com/repos/example/synthetic') return Response.json({ private: true })
    const endpoint = url.split('/synthetic/')[1]
    if (!init?.method || init.method === 'GET') {
      if (endpoint === 'git/ref/heads/master') return Response.json({ object: { sha: 'head' } })
      if (endpoint === 'git/commits/head') return Response.json({ tree: { sha: 'tree' } })
      if (endpoint === 'git/trees/tree?recursive=1') return Response.json({ tree: [], truncated: false })
      throw new Error('Unexpected request')
    }
    writes.push({ endpoint, body: JSON.parse(String(init.body)) })
    return Response.json({ sha: 'synthetic-sha' })
  })
  await sync.run('example/synthetic', 'master', 'github_pat_synthetic')
  const paths = writes.find(w => w.endpoint === 'git/trees')!.body.tree.map((f: any) => f.path)
  expect(paths).toContain(n.path)
  expect(paths).toContain('assets/topic.png')
  expect(paths.some((p: string) => p.startsWith('local/'))).toBe(false)
})

it.each(['incoming', 'both'] as const)('同步选题冲突保留远端标题、正文和完成状态：%s', async action => {
  const l = library()
  const n = l.save({ kind: 'topic', title: '本地选题', body: '本地正文', completed: true })
  const remote = readFileSync(path.join(l.root, n.path), 'utf8').replace('本地选题', '远端选题').replace('本地正文', '远端正文').replace('completed: true', 'completed: false')
  const sync = new GithubSync(l, () => {}, async (input, init) => {
    const url = String(input)
    if (url === 'https://api.github.com/repos/example/synthetic') return Response.json({ private: true })
    const endpoint = url.split('/synthetic/')[1]
    if (!init?.method || init.method === 'GET') {
      if (endpoint === 'git/ref/heads/master') return Response.json({ object: { sha: 'head' } })
      if (endpoint === 'git/commits/head') return Response.json({ tree: { sha: 'tree' } })
      if (endpoint === 'git/trees/tree?recursive=1') return Response.json({ tree: [{ path: n.path, mode: '100644', type: 'blob', sha: 'topic', size: Buffer.byteLength(remote) }], truncated: false })
      if (endpoint === 'git/blobs/topic') return Response.json({ encoding: 'base64', content: Buffer.from(remote).toString('base64') })
      throw new Error('Unexpected request')
    }
    return Response.json({ sha: 'synthetic-sha' })
  })
  await sync.run('example/synthetic', 'master', 'github_pat_synthetic')
  expect(l.conflicts.size).toBe(1)
  const conflict = [...l.conflicts.values()][0]
  expect(conflict.incoming.completed).toBe(false)
  expect(conflict.current.completed).toBe(true)
  l.resolve(conflict.id, action)
  const adopted = [...l.notes.values()].find(n => n.title.startsWith('远端选题'))!
  expect(adopted.kind).toBe('topic')
  expect(adopted.body).toBe('远端正文')
  expect(adopted.completed).toBe(false)
  expect(l.notes.size).toBe(action === 'both' ? 2 : 1)
  if (action === 'both') expect(l.get(n.id).completed).toBe(true)
})
