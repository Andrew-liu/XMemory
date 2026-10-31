import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { Library, decode, hash } from '../src/main/library'
import { GithubSync } from '../src/main/sync'
import { gitBlobHash } from '../src/main/sync-cache'
import { migrateLibrary } from '../src/main/migrate'
import { PNG, fresh, legacyLibrary } from './legacy-fixture'

const libraries: Library[] = []
afterEach(async () => { for (const l of libraries.splice(0)) await l.close() })
const open = (root = fresh()) => { const l = new Library(root); libraries.push(l); return l }

/** In-memory GitHub: one branch, blobs by SHA, recursive tree, fast-forward-only ref updates. */
function remote(initial: Map<string, Buffer>) {
  const files = new Map(initial)
  const blobs = new Map<string, Buffer>()
  const staged = new Map<string, Map<string, Buffer>>()
  let version = 0, patches = 0
  const requests: string[] = []
  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(input).split('/synthetic')[1]
    if (!endpoint) return Response.json({ private: true })
    const method = init?.method || 'GET'
    requests.push(`${method} ${endpoint}`)
    if (method === 'GET') {
      if (endpoint === '/git/ref/heads/master') return Response.json({ object: { sha: `head-${version}` } })
      if (endpoint.startsWith('/git/commits/')) return Response.json({ tree: { sha: `tree-${version}` } })
      if (endpoint.startsWith('/git/trees/')) return Response.json({ tree: [...files].map(([p, content]) => { const sha = gitBlobHash(content); blobs.set(sha, content); return { path: p, sha, mode: '100644', type: 'blob', size: content.length } }) })
      if (endpoint.startsWith('/git/blobs/')) return Response.json({ encoding: 'base64', content: blobs.get(endpoint.split('/').at(-1)!)!.toString('base64') })
      throw new Error(`Unexpected GET ${endpoint}`)
    }
    const body = JSON.parse(String(init?.body))
    if (endpoint === '/git/blobs') { const bytes = Buffer.from(body.content, 'base64'), sha = gitBlobHash(bytes); blobs.set(sha, bytes); return Response.json({ sha }) }
    if (endpoint === '/git/trees') {
      const next = new Map(files)
      for (const e of body.tree) { if (e.sha === null) next.delete(e.path); else next.set(e.path, blobs.get(e.sha)!) }
      staged.set('new-tree', next); return Response.json({ sha: 'new-tree' })
    }
    if (endpoint === '/git/commits') return Response.json({ sha: 'new-head' })
    if (endpoint === '/git/refs/heads/master') { patches++; files.clear(); for (const [p, b] of staged.get('new-tree')!) files.set(p, b); version++; return Response.json({}) }
    throw new Error(`Unexpected write ${endpoint}`)
  }
  return { files, request, requests, patches: () => patches, bump: () => { version++ } }
}
const run = (l: Library, r: ReturnType<typeof remote>) => new GithubSync(l, () => {}, r.request).run('example/synthetic', 'master', 'github_pat_synthetic')
const text = (r: ReturnType<typeof remote>, file: string) => r.files.get(file)?.toString() ?? ''

describe('v2 同步', () => {
  it('回收站里的笔记以原路径同步，删除标记上传，对端据此移入自己的回收站', async () => {
    const a = open(), b = open(), r = remote(new Map())
    const note = a.save({ id: 'x-9-1', kind: 'memory', title: '要删的记忆', body: '正文', author: 'gina', publishedAt: '2026-04-05T00:00:00.000Z' })
    const logical = note.path
    await run(a, r)
    expect([...r.files.keys()].every(f => !f.startsWith('.xmemeory/trash'))).toBe(true)
    await run(b, r)
    expect(b.get(note.id).deleted).toBeFalsy()
    expect(existsSync(path.join(b.root, logical))).toBe(true)

    a.remove(note.id)
    await run(a, r)
    expect(r.files.has(logical)).toBe(true)
    expect(JSON.parse(text(r, '.xmemeory/tombstones/x-9-1.json')).deleted).toBe(true)
    expect([...r.files.keys()].some(f => f.startsWith('.xmemeory/trash'))).toBe(false)

    await run(b, r)
    expect(b.get(note.id)).toMatchObject({ deleted: true, path: `.xmemeory/trash/${logical}` })
    expect(existsSync(path.join(b.root, logical))).toBe(false)
    expect(b.conflicts.size).toBe(0)

    a.remove(note.id, true)
    await run(a, r)
    await run(b, r)
    expect(b.get(note.id)).toMatchObject({ deleted: false, path: logical })
  })
  it('私有数据（索引、同步状态、备份、Obsidian 配置）不上传', async () => {
    const a = open(), r = remote(new Map())
    a.save({ kind: 'inspiration', title: '灵感', body: '内容' })
    await run(a, r)
    expect([...r.files.keys()].filter(f => f !== 'manifest.json' && !/^(inspirations|memories|topics|drafts)\/|^\.xmemeory\/(metadata|tombstones|conflicts)\/|^attachments\//.test(f))).toEqual([])
    expect([...r.files.keys()].some(f => /index\.sqlite|sync-|backup|\.obsidian|\/local\//.test(f))).toBe(false)
  })
  it('远端是 v1 结构时升级远端：新结构整体写入、旧路径删除，已迁移的本机路径不变', async () => {
    const { root } = legacyLibrary()
    const v1 = new Map<string, Buffer>()
    const add = (dir: string) => { for (const f of readdirSync(path.join(root, dir), { recursive: true }) as string[]) { const full = path.join(root, dir, f); if (existsSync(full) && !readdirSync(path.dirname(full), { withFileTypes: true }).find(d => d.name === path.basename(full))?.isDirectory()) v1.set(`${dir}/${f}`.replaceAll('\\', '/'), readFileSync(full)) } }
    for (const dir of ['memories', 'inspirations', 'topics', 'assets', 'metadata', 'tombstones']) add(dir)
    v1.set('manifest.json', readFileSync(path.join(root, 'manifest.json')))
    // This device saw the same v1 content before upgrading: its baseline is the v1 hashes.
    const legacyHashes = Object.fromEntries([...v1].map(([f, c]) => [f, hash(c)]))
    migrateLibrary(root)
    const stateFile = path.join(root, '.xmemeory/local/sync-' + hash('example/syntheticmaster').slice(0, 16) + '.json')
    const lib = open(root)
    const pathsBefore = Object.fromEntries([...lib.notes.values()].map(n => [n.id, n.path]))
    const r = remote(v1)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(stateFile, JSON.stringify({ hashes: {}, legacyHashes, lastRemoteSha: 'head-0', lastTreeSha: 'tree-0' }))
    await run(lib, r)
    const keys = [...r.files.keys()]
    expect(JSON.parse(text(r, 'manifest.json')).schemaVersion).toBe(2)
    expect(keys.some(f => f.startsWith('assets/') || /^(metadata|tombstones|conflicts)\//.test(f) || f.startsWith('memories/11/'))).toBe(false)
    expect(keys.filter(f => f.startsWith('memories/'))).toHaveLength(3)
    expect(keys).toContain(`attachments/${hash(PNG)}.png`)
    expect(keys).toContain('.xmemeory/tombstones/x-11-444.json')
    for (const n of lib.notes.values()) expect(n.path).toBe(pathsBefore[n.id])
    expect(lib.conflicts.size).toBe(0)
    // A second device on the same v2 content now syncs without conflicts or duplicates.
    const other = open()
    await run(other, r)
    expect(other.notes.size).toBe(5)
    expect(other.conflicts.size).toBe(0)
    const memory = other.get('x-11-222')
    expect(decode(readFileSync(path.join(other.root, memory.path), 'utf8')).metadata.xmemeory_id).toBe('x-11-222')
    expect(other.get('x-11-444').deleted).toBe(true)
    // And the upgraded device sees nothing new to do.
    const before = r.patches()
    await run(lib, r)
    expect(r.patches()).toBe(before)
  })
  it('远端是更高版本时停止同步且不写入', async () => {
    const a = open()
    const r = remote(new Map([['manifest.json', Buffer.from(JSON.stringify({ schemaVersion: 3 }))]]))
    await expect(run(a, r)).rejects.toThrow('远端资料库版本不兼容')
    expect(r.patches()).toBe(0)
  })
})
