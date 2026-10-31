import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { Library, decode, hash } from '../src/main/library'
import { GithubSync } from '../src/main/sync'
import { gitBlobHash } from '../src/main/sync-cache'
import { migrateLibrary } from '../src/main/migrate'
import { PNG, fresh, legacyLibrary } from './legacy-fixture'
import { chunkedBody, tarBuffer, tarGz } from './tar-helper'

const libraries: Library[] = []
afterEach(async () => { for (const l of libraries.splice(0)) await l.close() })
const open = (root = fresh()) => { const l = new Library(root); libraries.push(l); return l }

interface RemoteOptions {
  /** How the tarball endpoint answers: an archive of the current files, an error, a redirect elsewhere, or a cut-off stream. */
  tarball?: 'ok' | 'fail' | 'elsewhere' | 'cut'
  /** Called before each blob upload is accepted (e.g. to cancel the sync mid-upload). */
  onBlobPost?: () => void
  /** Number of commit creations that fail with HTTP 500 before succeeding. */
  failCommits?: number
  /** A path GitHub refuses in any tree request, with this message. */
  rejectPath?: string
  /** Tree requests with more entries than this get HTTP 502, like GitHub timing out on a large write. */
  busyAbove?: number
  /** The first N commit creations get HTTP 502. */
  busyCommits?: number
}
/** In-memory GitHub: one branch, blobs by SHA, recursive tree, tarball, fast-forward-only ref updates. */
function remote(initial: Map<string, Buffer>, options: RemoteOptions = {}) {
  const files = new Map(initial)
  const blobs = new Map<string, Buffer>()
  for (const content of initial.values()) blobs.set(gitBlobHash(content), content)
  const staged = new Map<string, Map<string, Buffer>>()
  let version = 0, patches = 0, treeCount = 0, commitTree = '', failCommits = options.failCommits || 0
  const requests: string[] = []
  const treePosts: any[] = []
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
      if (endpoint.startsWith('/tarball/') && options.tarball) {
        if (options.tarball === 'fail') return new Response('{}', { status: 502 })
        const archive = options.tarball === 'cut' ? gzipSync(tarBuffer([...files]).subarray(0, 4096)) : tarGz([...files])
        const response = new Response(chunkedBody(archive, 4096))
        Object.defineProperty(response, 'url', { value: options.tarball === 'elsewhere' ? 'https://downloads.example.com/a.tar.gz' : 'https://codeload.github.com/example/synthetic/legacy.tar.gz/head' })
        return response
      }
      throw new Error(`Unexpected GET ${endpoint}`)
    }
    const body = JSON.parse(String(init?.body))
    if (endpoint === '/git/blobs') { options.onBlobPost?.(); const bytes = Buffer.from(body.content, 'base64'), sha = gitBlobHash(bytes); blobs.set(sha, bytes); return Response.json({ sha }) }
    if (endpoint === '/git/trees') {
      // Like GitHub: start from base_tree, then apply entries (sha, inline content, or null to delete).
      treePosts.push(body)
      if (options.busyAbove !== undefined && body.tree.length > options.busyAbove) return new Response('{"message":"Server Error"}', { status: 502 })
      const next = new Map(body.base_tree && staged.has(body.base_tree) ? staged.get(body.base_tree)! : files)
      // GitHub rejects a tree that references a blob it does not have.
      if (body.tree.some((e: any) => typeof e.sha === 'string' && !blobs.has(e.sha))) return new Response('{"message":"tree.sha is not a valid blob"}', { status: 422 })
      if (options.rejectPath && body.tree.some((e: any) => e.path === options.rejectPath)) return new Response(JSON.stringify({ message: 'GitRPC::BadObjectState', documentation_url: 'https://docs.github.com' }), { status: 422 })
      for (const e of body.tree) { if (e.sha === null) next.delete(e.path); else next.set(e.path, typeof e.content === 'string' ? Buffer.from(e.content, 'utf8') : blobs.get(e.sha)!) }
      const sha = `new-tree-${++treeCount}`; staged.set(sha, next); return Response.json({ sha })
    }
    if (endpoint === '/git/commits') { if ((options.busyCommits || 0) > 0) { options.busyCommits!--; return new Response('{"message":"Server Error"}', { status: 502 }) } if (failCommits > 0) { failCommits--; return new Response('{}', { status: 500 }) } commitTree = body.tree; return Response.json({ sha: 'new-head' }) }
    if (endpoint === '/git/refs/heads/master') { patches++; files.clear(); for (const [p, b] of staged.get(commitTree)!) files.set(p, b); version++; return Response.json({}) }
    throw new Error(`Unexpected write ${endpoint}`)
  }
  const count = (prefix: string) => requests.filter(r => r.startsWith(prefix)).length
  return { files, request, requests, treePosts, patches: () => patches, bump: () => { version++ },
    blobGets: () => count('GET /git/blobs/'), blobPosts: () => count('POST /git/blobs'), tarballs: () => count('GET /tarball/'),
    /** Simulate GitHub discarding unreferenced blobs. */
    discard: (shas: string[]) => { for (const sha of shas) blobs.delete(sha) } }
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
  it('全新空库首次连接 v1 远端：拉全所有条目、正文与图片可用，远端升级为 v2 且条目不丢', async () => {
    const { root } = legacyLibrary()
    const v1 = new Map<string, Buffer>()
    const add = (dir: string) => { for (const f of readdirSync(path.join(root, dir), { recursive: true }) as string[]) { const full = path.join(root, dir, f); if (existsSync(full) && !readdirSync(path.dirname(full), { withFileTypes: true }).find(d => d.name === path.basename(full))?.isDirectory()) v1.set(`${dir}/${f}`.replaceAll('\\', '/'), readFileSync(full)) } }
    for (const dir of ['memories', 'inspirations', 'topics', 'assets', 'metadata', 'tombstones']) add(dir)
    v1.set('manifest.json', readFileSync(path.join(root, 'manifest.json')))
    const r = remote(v1)
    const empty = open()
    await run(empty, r)
    expect(empty.notes.size).toBe(5)
    expect(empty.conflicts.size).toBe(0)
    expect(empty.get('x-11-444').deleted).toBe(true)
    const memory = empty.get('x-11-222')
    expect(memory.body).toContain(`../../attachments/${hash(PNG)}.png`)
    expect(existsSync(path.join(empty.root, `attachments/${hash(PNG)}.png`))).toBe(true)
    expect(JSON.parse(text(r, 'manifest.json')).schemaVersion).toBe(2)
    expect([...r.files.keys()].filter(f => f.startsWith('memories/') || f.startsWith('inspirations/') || f.startsWith('topics/'))).toHaveLength(5)
    expect([...r.files.keys()].some(f => f.startsWith('assets/') || f.startsWith('memories/11/'))).toBe(false)
    const before = r.patches()
    await run(empty, r)
    expect(r.patches()).toBe(before)
  })
  it('远端是更高版本时停止同步且不写入', async () => {
    const a = open()
    const r = remote(new Map([['manifest.json', Buffer.from(JSON.stringify({ schemaVersion: 3 }))]]))
    await expect(run(a, r)).rejects.toThrow('远端资料库版本不兼容')
    expect(r.patches()).toBe(0)
  })
})

/** A v2 remote with `notes` inspirations and `images` attachments, as another device would have pushed it. */
function bigRemote(notes: number, images: number) {
  const files = new Map<string, Buffer>([['manifest.json', Buffer.from(JSON.stringify({ schemaVersion: 2, application: 'XMemeory' }))]])
  for (let i = 0; i < notes; i++) files.set(`inspirations/n-${i}.md`, Buffer.from(`---\nxmemeory_id: n-${i}\ntype: inspiration\ntitle: 灵感 ${i}\n---\n正文 ${i}`))
  for (let i = 0; i < images; i++) files.set(`attachments/img-${i}.png`, Buffer.concat([PNG, Buffer.from(`#${i}`)]))
  return files
}

describe('大仓库同步', () => {
  it('空库首次同步：一次打包下载取回全部文件，逐个读取 0 次，界面推送次数受节流', async () => {
    const r = remote(bigRemote(300, 60), { tarball: 'ok' })
    const l = open()
    let pushes = 0
    const sync = new GithubSync(l, () => { pushes++ }, r.request)
    await sync.run('example/synthetic', 'master', 'github_pat_synthetic')
    expect(r.tarballs()).toBe(1)
    expect(r.blobGets()).toBe(0)
    expect([...l.notes.values()].filter(n => n.kind === 'inspiration')).toHaveLength(300)
    expect(readdirSync(path.join(l.root, 'attachments'))).toHaveLength(60)
    // manifest.json is identical to the empty library's own copy and is reused, so 360 files come from the archive.
    expect(sync.status).toContain('打包下载 360')
    expect(pushes).toBeLessThan(30)
  })
  it.each(['fail', 'elsewhere', 'cut'] as const)('打包下载 %s 时回退逐个读取，结果完全相同', async mode => {
    const r = remote(bigRemote(150, 10), { tarball: mode })
    const l = open()
    await run(l, r)
    // A cut-off archive may still have delivered (and verified) a few files; everything else is read one by one.
    if (mode === 'cut') { expect(r.blobGets()).toBeGreaterThan(0); expect(r.blobGets()).toBeLessThanOrEqual(160) } else expect(r.blobGets()).toBe(160)
    expect([...l.notes.values()].filter(n => n.kind === 'inspiration')).toHaveLength(150)
    expect(l.get('n-42').body).toBe('正文 42')
  })
  it('文件不多时不走打包下载', async () => {
    const r = remote(bigRemote(20, 0), { tarball: 'ok' })
    await run(open(), r)
    expect(r.tarballs()).toBe(0)
    expect(r.blobGets()).toBe(20)
  })
  it('大量本地内容上传：正文内联、分批建树并逐批叠加，只更新一次分支，远端内容完整', async () => {
    const l = open()
    for (let i = 0; i < 600; i++) l.save({ id: `local-${i}`, kind: 'inspiration', title: `本地 ${i}`, body: `本地正文 ${i}` })
    const r = remote(new Map())
    await run(l, r)
    expect(r.blobPosts()).toBe(0)
    expect(r.treePosts.length).toBeGreaterThanOrEqual(3)
    expect(r.treePosts.every(post => post.tree.length <= 200)).toBe(true)
    for (let i = 1; i < r.treePosts.length; i++) expect(r.treePosts[i].base_tree).toBe(`new-tree-${i}`)
    expect(r.patches()).toBe(1)
    expect([...r.files.keys()].filter(f => f.startsWith('inspirations/'))).toHaveLength(600)
    expect(text(r, 'inspirations/local-599.md')).toContain('本地正文 599')
    expect(r.files.get('inspirations/local-7.md')!.equals(readFileSync(path.join(l.root, 'inspirations/local-7.md')))).toBe(true)
  })
  it('提交中断后再次同步：已上传的图片不重传', async () => {
    const l = open()
    for (let i = 0; i < 3; i++) { const image = l.addImage(Buffer.concat([PNG, Buffer.from(`up-${i}`)]), 'p'); l.save({ kind: 'inspiration', title: `图 ${i}`, body: `![](../${image})` }) }
    const r = remote(new Map(), { failCommits: 3 })
    await expect(run(l, r)).rejects.toThrow('500')
    expect(r.blobPosts()).toBe(3)
    expect(r.patches()).toBe(0)
    await run(l, r)
    expect(r.blobPosts()).toBe(3)
    expect([...r.files.keys()].filter(f => f.startsWith('attachments/'))).toHaveLength(3)
    expect(existsSync(path.join(l.root, '.xmemeory/local', readdirSync(path.join(l.root, '.xmemeory/local')).find(f => f.startsWith('sync-uploaded-')) || 'none'))).toBe(true)
  }, 30_000)
  it('记录过的图片已被 GitHub 丢弃时：目录被拒（422）后清空记录、重新上传并成功', async () => {
    const l = open()
    const shas: string[] = []
    for (let i = 0; i < 2; i++) { const bytes = Buffer.concat([PNG, Buffer.from(`gc-${i}`)]); shas.push(gitBlobHash(bytes)); const image = l.addImage(bytes, 'p'); l.save({ kind: 'inspiration', title: `丢 ${i}`, body: `![](../${image})` }) }
    const r = remote(new Map(), { failCommits: 3 })
    await expect(run(l, r)).rejects.toThrow('500')
    r.discard(shas)
    await run(l, r)
    expect(r.blobPosts()).toBe(4)
    expect(r.patches()).toBe(1)
    expect([...r.files.keys()].filter(f => f.startsWith('attachments/'))).toHaveLength(2)
  }, 30_000)
  it('上传中取消：本轮停止、远端分支不变，下次同步照常完成', async () => {
    const l = open()
    for (let i = 0; i < 3; i++) { const image = l.addImage(Buffer.concat([PNG, Buffer.from(`c-${i}`)]), 'p'); l.save({ kind: 'inspiration', title: `取消 ${i}`, body: `![](../${image})` }) }
    let sync: GithubSync | undefined
    let cancelOnce = true
    const r = remote(new Map(), { onBlobPost: () => { if (cancelOnce) { cancelOnce = false; sync!.cancel() } } })
    sync = new GithubSync(l, () => {}, r.request)
    await expect(sync.run('example/synthetic', 'master', 'github_pat_synthetic')).rejects.toThrow('同步已停止')
    expect(sync.running).toBe(false)
    expect(r.patches()).toBe(0)
    await sync.run('example/synthetic', 'master', 'github_pat_synthetic')
    expect(r.patches()).toBe(1)
    expect(r.blobPosts()).toBe(3)
  })
  it('目录被拒且与上传记录无关时：定位到具体文件并带上 GitHub 原文，远端不变', async () => {
    const l = open()
    for (let i = 0; i < 40; i++) l.save({ id: `r-${i}`, kind: 'inspiration', title: `拒 ${i}`, body: `正文 ${i}` })
    const r = remote(new Map(), { rejectPath: 'inspirations/r-27.md' })
    const error = await run(l, r).then(() => new Error("应当失败"), e => e as Error)
    expect(error.message).toContain('写入正文 inspirations/r-27.md')
    expect(error.message).toContain('GitHub 返回：GitRPC::BadObjectState')
    expect(r.patches()).toBe(0)
    expect(r.treePosts.length).toBeLessThanOrEqual(1 + 8)
  })
  it('GitHub 对大批目录返回 502：自动对半拆分重试直到成功，提交 502 也重试，只更新一次分支', async () => {
    const l = open()
    for (let i = 0; i < 300; i++) l.save({ id: `b-${i}`, kind: 'inspiration', title: `忙 ${i}`, body: `正文 ${i}` })
    const r = remote(new Map(), { busyAbove: 60, busyCommits: 1 })
    await run(l, r)
    expect(r.patches()).toBe(1)
    expect([...r.files.keys()].filter(f => f.startsWith('inspirations/'))).toHaveLength(300)
    expect(text(r, 'inspirations/b-299.md')).toContain('正文 299')
  })
  it('拆到最小批次仍然 502：报错说明远端未改动', async () => {
    const l = open()
    for (let i = 0; i < 30; i++) l.save({ id: `z-${i}`, kind: 'inspiration', title: `满 ${i}`, body: `正文 ${i}` })
    const r = remote(new Map(), { busyAbove: 0 })
    const error = await run(l, r).then(() => new Error('应当失败'), e => e as Error)
    expect(error.message).toContain('远端未改动')
    expect(r.patches()).toBe(0)
  }, 30_000)
})
