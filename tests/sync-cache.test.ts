import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { Library, hash } from '../src/main/library'
import { GithubSync } from '../src/main/sync'
import { gitBlobHash, SyncCache } from '../src/main/sync-cache'

const root = path.resolve('../../trash/xmemeory-dev/sync-cache-tests'); mkdirSync(root, { recursive: true })
const libraries: Library[] = []
afterEach(async () => { for (const l of libraries.splice(0)) await l.close() })
function setup() {
  const l = new Library(mkdtempSync(path.join(root, 'library-'))); libraries.push(l)
  const n = l.save({ kind: 'topic', title: '缓存测试', body: '原正文' })
  const files = new Map<string, Buffer>([[n.path, readFileSync(path.join(l.root, n.path))]])
  const blobs = new Map<string, Buffer>()
  let gets = 0, writes = 0, failCommit = false, brokenDownload = false
  const trees = new Map<string, Map<string, Buffer>>()
  const sync = new GithubSync(l, () => {}, async (input, init) => {
    const endpoint = String(input).split('/synthetic')[1]
    if (!endpoint) return Response.json({ private: true })
    const method = init?.method || 'GET'
    if (method === 'GET') {
      if (endpoint === '/git/ref/heads/master') return Response.json({ object: { sha: 'head' } })
      if (endpoint === '/git/commits/head') return Response.json({ tree: { sha: 'tree' } })
      if (endpoint === '/git/trees/tree?recursive=1') return Response.json({ tree: [...files].map(([path, content]) => { const sha = gitBlobHash(content); blobs.set(sha, content); return { path, sha, mode: '100644', type: 'blob', size: content.length } }) })
      if (endpoint.startsWith('/git/blobs/')) { gets++; return Response.json({ encoding: 'base64', content: (brokenDownload ? Buffer.from('damaged') : blobs.get(endpoint.split('/').at(-1)!)!).toString('base64') }) }
      throw new Error('Unexpected GET')
    }
    writes++
    const body = JSON.parse(String(init?.body))
    if (endpoint === '/git/blobs') { const bytes = Buffer.from(body.content, 'base64'), sha = gitBlobHash(bytes); blobs.set(sha, bytes); return Response.json({ sha }) }
    if (endpoint === '/git/trees') { const next = new Map(files); for (const e of body.tree) next.set(e.path, blobs.get(e.sha)!); trees.set('new-tree', next); return Response.json({ sha: 'new-tree' }) }
    if (endpoint === '/git/commits') return Response.json({ sha: 'new-head' })
    if (endpoint === '/git/refs/heads/master') { if (failCommit) return new Response('{}', { status: 409 }); files.clear(); for (const [p, b] of trees.get('new-tree')!) files.set(p, b); return Response.json({}) }
    throw new Error('Unexpected write')
  })
  return { l, n, files, sync, run: () => sync.run('example/synthetic', 'master', 'github_pat_synthetic'), gets: () => gets, writes: () => writes, fail: (value: boolean) => { failCommit = value }, damage: () => { brokenDownload = true } }
}
it('本地相同首次就跳过下载；第二轮全部复用且不创建提交', async () => {
  const t = setup(); await t.run()
  expect(t.gets()).toBe(0)
  const writes = t.writes(); await t.run()
  expect(t.gets()).toBe(0); expect(t.writes()).toBe(writes)
  expect(t.sync.status).toContain('下载 0')
})
it('本地单端修改命中缓存仍上传修改，不误作双方相同', async () => {
  const t = setup(); await t.run()
  t.l.save({ ...t.l.get(t.n.id), body: '本地修改' }, t.l.get(t.n.id).hash)
  await t.run()
  expect(t.gets()).toBe(0)
  expect(t.files.get(t.n.path)!.toString()).toContain('本地修改')
  expect(t.l.conflicts.size).toBe(0)
  expect(t.sync.status).toContain('缓存命中 2')
})
it('远端仅一个正文变化只下载一个文件，正确回读', async () => {
  const t = setup(); await t.run()
  t.files.set(t.n.path, Buffer.from(t.files.get(t.n.path)!.toString().replace('原正文', '远端修改')))
  await t.run()
  expect(t.gets()).toBe(1); expect(t.l.get(t.n.id).body).toBe('远端修改')
  await t.run(); expect(t.gets()).toBe(1)
})
it.each(['missing', 'corrupt'] as const)('缓存 %s 安全回退下载，缓存不参与远端同步', async mode => {
  const t = setup(); await t.run()
  const scope = hash(JSON.stringify(['example/synthetic', 'master'])).slice(0, 24)
  const file = path.join(t.l.root, 'local/sync-cache', scope, gitBlobHash(t.files.get(t.n.path)!))
  if (mode === 'missing') unlinkSync(file); else writeFileSync(file, '损坏缓存')
  t.l.save({ ...t.l.get(t.n.id), body: '本地修改' }, t.l.get(t.n.id).hash)
  await t.run(); expect(t.gets()).toBe(1)
  expect([...t.files.keys()].some(p => p.startsWith('local/'))).toBe(false)
})
it('双端修改保留冲突，图片已知内容不重复下载', async () => {
  const t = setup(); const picture = Buffer.from([1, 2, 3, 4])
  t.files.set('assets/synthetic.png', picture)
  await t.run(); expect(t.gets()).toBe(1)
  t.l.save({ ...t.l.get(t.n.id), body: '本地修改' }, t.l.get(t.n.id).hash)
  t.files.set(t.n.path, Buffer.from(t.files.get(t.n.path)!.toString().replace('原正文', '远端修改')))
  await t.run(); expect(t.gets()).toBe(2); expect(t.l.conflicts.size).toBe(1)
  expect(readFileSync(path.join(t.l.root, 'assets/synthetic.png'))).toEqual(picture)
})
it('提交失败不前移基线，重试复用已下载的远端版本', async () => {
  const t = setup(); await t.run()
  const baseline = path.join(t.l.root, 'local', `sync-${hash('example/syntheticmaster').slice(0,16)}.json`)
  const before = readFileSync(baseline, 'utf8')
  t.files.set(t.n.path, Buffer.from(t.files.get(t.n.path)!.toString().replace('原正文', '远端修改')))
  t.l.save({ ...t.l.get(t.n.id), body: '本地修改' }, t.l.get(t.n.id).hash)
  t.fail(true); await expect(t.run()).rejects.toThrow('409')
  expect(readFileSync(baseline, 'utf8')).toBe(before)
  expect(t.gets()).toBe(1)
  t.fail(false); await t.run(); expect(t.gets()).toBe(1)
  expect(t.l.conflicts.size).toBe(1)
})
it('下载内容哈希错误时停止，不将错误字节写进正文', async () => {
  const t = setup(); t.files.set(t.n.path, Buffer.from(t.files.get(t.n.path)!.toString().replace('原正文', '远端修改'))); t.damage()
  await expect(t.run()).rejects.toThrow('完整性校验失败')
  expect(t.l.get(t.n.id).body).toBe('原正文')
})
it('Git blob SHA 包含字节长度，缓存隔离仓库范围且安全拒绝越界标识', () => {
  const t = setup(); expect(gitBlobHash(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  const a = new SyncCache(t.l.root, 'a'), b = new SyncCache(t.l.root, 'b'), bytes = Buffer.from('合成')
  a.put(bytes); expect(a.read(gitBlobHash(bytes))).toEqual(bytes); expect(b.read(gitBlobHash(bytes))).toBeUndefined()
  expect(a.read('../anything')).toBeUndefined()
})
