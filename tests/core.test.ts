import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Library, atomic, hash, safePath, walk } from '../src/main/library'
import { GithubSync, githubTokenKind, mergeChoice, mergedHashes, normalizeGithubToken, normalizeRepository, runConfiguredStartupSync, syncAllowed } from '../src/main/sync'
import { prepareMarkdown } from '../src/renderer/markdown'
import { splitDifference, splitMatches } from '../src/renderer/highlight'

const temporary = path.resolve(process.cwd(), '../../trash/xmemeory-dev/tests')
mkdirSync(temporary, { recursive: true })
const libraries: Library[] = []
const library = () => { const l = new Library(mkdtempSync(path.join(temporary, 'library-'))); libraries.push(l); return l }
it('GitHub Token 格式校验不回显凭据，首尾空白清理，拒绝包装和掩码', () => {
  expect(normalizeGithubToken(' github_pat_syntheticNewValue\r\n')).toBe('github_pat_syntheticNewValue')
  expect(githubTokenKind('github_pat_synthetic')).toBe('fine-grained')
  expect(githubTokenKind('ghp_synthetic')).toBe('classic')
  for (const input of ['master', '"github_pat_secret"', 'Bearer github_pat_secret', 'github_pat_se\u200Bcret', 'github_pat_***', 'github_pat_']) {
    let message = ''
    try { normalizeGithubToken(input) } catch (e) { message = (e as Error).message }
    expect(message).not.toBe('')
    expect(message).not.toContain(input)
    expect(githubTokenKind(input)).toBe('invalid')
  }
})
it('Token 401 在身份检查阶段停止，不请求仓库或上传', async () => {
  const urls: string[] = []
  const sync = new GithubSync(library(), () => {}, async input => { urls.push(String(input)); return new Response('{}', { status: 401 }) })
  await expect(sync.check('example/synthetic', 'master', 'github_pat_synthetic')).rejects.toThrow('401（验证 Token）')
  expect(urls).toEqual(['https://api.github.com/user'])
  expect(sync.running).toBe(false)
})
it('私库输入兼容完整 URL 与 owner/repo，拒绝其他主机和凭据', () => {
  for (const input of ['Andrew-liu/my-memory', 'https://github.com/Andrew-liu/my-memory.git', ' https://github.com/Andrew-liu/my-memory/ ']) expect(normalizeRepository(input)).toBe('Andrew-liu/my-memory')
  for (const input of ['https://github.com.evil.test/a/b', 'https://secret@github.com/a/b', 'https://github.com/a/b?token=secret', 'https://github.com/a/b/tree/master', 'a/..', 'file:///a/b']) expect(() => normalizeRepository(input)).toThrow()
})
it('启动时仅在 GitHub 配置完整时同步一次', async () => {
  const calls: unknown[][] = []
  const sync = { run: async (...args: unknown[]) => { calls.push(args) } }
  await expect(runConfiguredStartupSync(sync, ' example/synthetic ', 'master', 'github_pat_synthetic')).resolves.toBe(true)
  expect(calls).toEqual([[' example/synthetic ', 'master', 'github_pat_synthetic']])
})
it.each([
  [undefined, 'github_pat_synthetic'],
  ['', 'github_pat_synthetic'],
  ['example/synthetic', undefined],
  ['example/synthetic', '']
])('启动时配置不完整不发起同步（repo=%s token=%s）', async (repo, token) => {
  let calls = 0
  const sync = { run: async () => { calls++ } }
  await expect(runConfiguredStartupSync(sync, repo, 'main', token)).resolves.toBe(false)
  expect(calls).toBe(0)
})
it('启动同步失败不阻塞应用初始化', async () => {
  const sync = { run: async () => { throw new Error('合成网络失败') } }
  await expect(runConfiguredStartupSync(sync, 'example/synthetic', 'main', 'github_pat_synthetic')).resolves.toBe(true)
})
it('完整仓库 URL 与 master 分支能进入同步请求，保持 private 校验', async () => {
  const urls: string[] = []
  const sync = new GithubSync(library(), () => {}, async input => {
    urls.push(String(input))
    if (urls.length === 1) return new Response(JSON.stringify({ private: true }))
    return new Response('{}', { status: 404 })
  })
  await expect(sync.run('https://github.com/Andrew-liu/my-memory.git', ' master ', 'github_pat_syntheticTokenForTests')).rejects.toThrow('GitHub 404')
  expect(urls).toEqual(['https://api.github.com/repos/Andrew-liu/my-memory', 'https://api.github.com/repos/Andrew-liu/my-memory/git/ref/heads/master'])
})
it('远端读取期间开始编辑时延后同步且不改写本地或远端', async () => {
  const l = library()
  const note = l.save({ kind: 'inspiration', title: '编辑保护', body: '本地正文' })
  const localFile = path.join(l.root, note.path)
  const localRaw = readFileSync(localFile)
  const remoteRaw = Buffer.from(localRaw.toString().replace('本地正文', '远端正文'))
  let dirty = false
  let writes = 0
  const root = 'https://api.github.com/repos/example/synthetic'
  const sync = new GithubSync(l, () => {}, async (input, init) => {
    const endpoint = String(input).replace(root + '/', '')
    if (String(input) === root) return Response.json({ private: true })
    if (endpoint === 'git/ref/heads/master') return Response.json({ object: { sha: 'head' } })
    if (endpoint === 'git/commits/head') return Response.json({ tree: { sha: 'tree' } })
    if (endpoint === 'git/trees/tree?recursive=1') return Response.json({ tree: [{ path: note.path, mode: '100644', type: 'blob', size: remoteRaw.length, sha: 'remote-note' }], truncated: false })
    if (endpoint === 'git/blobs/remote-note') { dirty = true; return Response.json({ encoding: 'base64', content: remoteRaw.toString('base64') }) }
    if (init?.method && init.method !== 'GET') writes++
    return new Response('{}', { status: 404 })
  }, () => dirty)
  await expect(sync.run('example/synthetic', 'master', 'github_pat_syntheticTokenForTests')).rejects.toThrow('本轮同步已延后')
  expect(readFileSync(localFile).equals(localRaw)).toBe(true)
  expect(writes).toBe(0)
  expect(sync.running).toBe(false)
})
it('私库同步完整链路使用正确仓库地址并非强制更新 master', async () => {
  const l = library()
  l.save({ kind: 'inspiration', title: '同步回归', body: '合成正文' })
  const writes: Array<{ endpoint: string; body: any }> = []
  const root = 'https://api.github.com/repos/example/synthetic'
  const sync = new GithubSync(l, () => {}, async (input, init) => {
    const url = String(input)
    if (url === root) return Response.json({ private: true })
    if (!url.startsWith(root + '/')) throw new Error('请求越界')
    const endpoint = url.slice(root.length + 1)
    if (!init?.method || init.method === 'GET') {
      if (endpoint === 'git/ref/heads/master') return Response.json({ object: { sha: 'head' } })
      if (endpoint === 'git/commits/head') return Response.json({ tree: { sha: 'tree' } })
      if (endpoint === 'git/trees/tree?recursive=1') return Response.json({ tree: [], truncated: false })
      return new Response('{}', { status: 404 })
    }
    writes.push({ endpoint, body: JSON.parse(String(init.body)) })
    return Response.json({ sha: endpoint === 'git/commits' ? 'new-commit' : 'new-object' })
  })
  await sync.run('https://github.com/example/synthetic.git', 'master', 'github_pat_syntheticTokenForTests')
  expect(sync.status).toContain('已上传')
  expect(sync.running).toBe(false)
  expect(writes.find(item => item.endpoint === 'git/trees')?.body.tree.some((item: any) => item.path === 'manifest.json')).toBe(true)
  expect(writes.at(-1)).toEqual({ endpoint: 'git/refs/heads/master', body: { sha: 'new-commit', force: false } })
})
it.each([
  [401, false, 'GitHub 未接受此 Token'],
  [403, false, 'Contents 读写权限'],
  [404, false, 'Resource owner'],
  [404, true, '读取分支 master'],
  [409, true, '仓库可能尚无提交']
] as const)('GitHub %s 错误区分仓库与分支阶段（分支=%s）', async (status, atBranch, message) => {
  const sync = new GithubSync(library(), () => {}, async input => {
    if (atBranch && String(input) === 'https://api.github.com/repos/example/synthetic') return Response.json({ private: true })
    return new Response('{}', { status })
  })
  await expect(sync.run('example/synthetic', 'master', 'github_pat_syntheticTokenForTests')).rejects.toThrow(message)
  expect(sync.status).toContain(message)
  expect(sync.running).toBe(false)
})
it('检查连接只读取私库和分支，不上传内容或改写同步状态文件', async () => {
  const l = library()
  const before = readdirSync(path.join(l.root, 'local')).sort()
  const calls: string[] = []
  const sync = new GithubSync(l, () => {}, async (input, init) => {
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    calls.push(String(input))
    return Response.json(calls.length === 1 ? { login: 'synthetic-user' } : calls.length === 2 ? { private: true } : { object: { sha: 'head' } })
  })
  await sync.check('example/synthetic', 'master', 'github_pat_syntheticTokenForTests')
  expect(calls).toEqual(['https://api.github.com/user', 'https://api.github.com/repos/example/synthetic', 'https://api.github.com/repos/example/synthetic/git/ref/heads/master'])
  expect(sync.status).toContain('@synthetic-user')
  expect(sync.status).toContain('未上传内容')
  expect(readdirSync(path.join(l.root, 'local')).sort()).toEqual(before)
})
const syncRoot = 'https://api.github.com/repos/example/synthetic'
const syncStateFile = (l: Library) => path.join(l.root, 'local', `sync-${hash('example/syntheticmaster').slice(0,16)}.json`)
it('远端无更新时跳过远端目录读取，仅上传本地变化', async () => {
  const l = library()
  l.save({ kind: 'inspiration', title: '本地新增', body: '本地内容' })
  const manifestHash = hash(readFileSync(path.join(l.root, 'manifest.json')))
  atomic(syncStateFile(l), JSON.stringify({ hashes: { 'manifest.json': manifestHash }, lastRemoteSha: 'head-1', lastTreeSha: 'tree-1' }))
  const calls: string[] = []
  const uploads: string[] = []
  const sync = new GithubSync(l, () => {}, async (input, init) => {
    const url = String(input); calls.push(`${init?.method || 'GET'} ${url}`)
    if (url === syncRoot) return Response.json({ private: true })
    if (url.endsWith('git/ref/heads/master')) return Response.json({ object: { sha: 'head-1' } })
    if (init?.method === 'POST' && url.endsWith('git/blobs')) uploads.push(Buffer.from(JSON.parse(String(init.body)).content, 'base64').toString())
    if (init?.method === 'POST') return Response.json({ sha: 'new-commit' })
    if (init?.method === 'PATCH') return Response.json({ object: { sha: 'head-1' } })
    return new Response('{}', { status: 404 })
  })
  await sync.run('example/synthetic', 'master', 'github_pat_syntheticTokenForTests')
  expect(calls.filter(c => c.startsWith('GET') && /git\/(trees|blobs)\//.test(c))).toEqual([])
  expect(calls.some(c => c.startsWith('PATCH'))).toBe(true)
  expect(uploads.join('\n')).toContain('本地新增')
  expect(sync.status).toContain('远端无更新')
  expect(sync.status).toContain('已上传 2 项')
  const state = JSON.parse(readFileSync(syncStateFile(l), 'utf8'))
  expect(state.lastRemoteSha).toBe('new-commit')
})
it('远端有更新时先写入本地再上传，远端变化不重复回传', async () => {
  const l = library()
  l.save({ kind: 'inspiration', title: '本地保留', body: '本地内容' })
  const remoteContent = Buffer.from('---\nxmemeory_id: remote-note\ntype: inspiration\ntitle: 远端新增\n---\n远端正文')
  const uploads: string[] = []
  const sync = new GithubSync(l, () => {}, async (input, init) => {
    const url = String(input)
    if (url === syncRoot) return Response.json({ private: true })
    if (url.endsWith('git/ref/heads/master')) return Response.json({ object: { sha: 'head-2' } })
    if (url.endsWith('git/commits/head-2')) return Response.json({ tree: { sha: 'tree-2' } })
    if (url.endsWith('git/trees/tree-2?recursive=1')) return Response.json({ tree: [{ path: 'inspirations/remote-note.md', mode: '100644', type: 'blob', size: remoteContent.length, sha: 'remote-blob' }], truncated: false })
    if (url.endsWith('git/blobs/remote-blob')) return Response.json({ encoding: 'base64', content: remoteContent.toString('base64') })
    if (init?.method === 'POST' && url.endsWith('git/blobs')) uploads.push(Buffer.from(JSON.parse(String(init.body)).content, 'base64').toString())
    if (init?.method === 'POST') return Response.json({ sha: 'new-commit' })
    if (init?.method === 'PATCH') return Response.json({ object: { sha: 'new-commit' } })
    return new Response('{}', { status: 404 })
  })
  await sync.run('example/synthetic', 'master', 'github_pat_syntheticTokenForTests')
  expect(readFileSync(path.join(l.root, 'inspirations/remote-note.md'), 'utf8')).toContain('远端正文')
  expect(uploads.some(content => content.includes('远端正文'))).toBe(false)
  expect(uploads.some(content => content.includes('本地保留'))).toBe(true)
  expect(sync.status).toContain('已拉取 1 项远端更新')
})
it('本地无变化时不创建远端提交', async () => {
  const l = library()
  l.save({ kind: 'inspiration', title: '无变化', body: '内容' })
  const hashes = Object.fromEntries(walk(l.root).filter(syncAllowed).map(f => [f, hash(readFileSync(safePath(l.root, f)))]))
  atomic(syncStateFile(l), JSON.stringify({ hashes, lastRemoteSha: 'head-3', lastTreeSha: 'tree-3' }))
  const calls: string[] = []
  const sync = new GithubSync(l, () => {}, async (input, init) => {
    calls.push(`${init?.method || 'GET'} ${String(input)}`)
    const url = String(input)
    if (url === syncRoot) return Response.json({ private: true })
    if (url.endsWith('git/ref/heads/master')) return Response.json({ object: { sha: 'head-3' } })
    return new Response('{}', { status: 500 })
  })
  await sync.run('example/synthetic', 'master', 'github_pat_syntheticTokenForTests')
  expect(calls.filter(c => !c.startsWith('GET'))).toEqual([])
  expect(sync.status).toContain('远端无更新')
  expect(sync.status).toContain('已上传 0 项')
})
it('分支更新被 422 拒绝后重新拉取并成功', async () => {
  const l = library()
  l.save({ kind: 'inspiration', title: '本地内容', body: 'x' })
  let head = 'head-1', patches = 0, refGets = 0
  const sync = new GithubSync(l, () => {}, async (input, init) => {
    const url = String(input)
    if (url === syncRoot) return Response.json({ private: true })
    if (url.endsWith('git/ref/heads/master')) { refGets++; return Response.json({ object: { sha: head } }) }
    if (init?.method && init.method !== 'GET') {
      if (init.method === 'PATCH') { patches++; if (patches === 1) { head = 'head-2'; return new Response('{}', { status: 422 }) } return Response.json({ object: { sha: head } }) }
      return Response.json({ sha: `new-${head}` })
    }
    if (url.includes('git/commits/')) return Response.json({ tree: { sha: `tree-${head}` } })
    if (url.includes('git/trees/')) return Response.json({ tree: [], truncated: false })
    return new Response('{}', { status: 404 })
  })
  await sync.run('example/synthetic', 'master', 'github_pat_syntheticTokenForTests')
  expect(refGets).toBe(2)
  expect(patches).toBe(2)
  expect(JSON.parse(readFileSync(syncStateFile(l), 'utf8')).lastRemoteSha).toBe('new-head-2')
})
it('远端连续变化三次后报错，本地内容保留', async () => {
  const l = library()
  const note = l.save({ kind: 'inspiration', title: '保留', body: '本地内容' })
  const before = readFileSync(path.join(l.root, note.path))
  let head = 'head-1', patches = 0
  const sync = new GithubSync(l, () => {}, async (input, init) => {
    const url = String(input)
    if (url === syncRoot) return Response.json({ private: true })
    if (url.endsWith('git/ref/heads/master')) return Response.json({ object: { sha: head } })
    if (init?.method && init.method !== 'GET') {
      if (init.method === 'PATCH') { patches++; head = `head-${patches + 1}`; return new Response('{}', { status: 422 }) }
      return Response.json({ sha: 'new' })
    }
    if (url.includes('git/commits/')) return Response.json({ tree: { sha: `tree-${head}` } })
    if (url.includes('git/trees/')) return Response.json({ tree: [], truncated: false })
    return new Response('{}', { status: 404 })
  })
  await expect(sync.run('example/synthetic', 'master', 'github_pat_syntheticTokenForTests')).rejects.toThrow('远端持续变化，本地内容已保留，请稍后重试')
  expect(patches).toBe(3)
  expect(readFileSync(path.join(l.root, note.path)).equals(before)).toBe(true)
  expect(sync.running).toBe(false)
})
it('422 重试时以本轮远端为合并基线，连续远端改动不产生伪冲突', async () => {
  const l = library()
  const note = l.save({ kind: 'inspiration', title: '远端连续修改', body: '本地版' })
  atomic(syncStateFile(l), JSON.stringify({ hashes: { [note.path]: hash(readFileSync(path.join(l.root, note.path))) } }))
  const remote1 = Buffer.from(readFileSync(path.join(l.root, note.path)).toString().replace('本地版', '远端一版'))
  const remote2 = Buffer.from(readFileSync(path.join(l.root, note.path)).toString().replace('本地版', '远端二版'))
  let head = 'head-1', patches = 0
  const sync = new GithubSync(l, () => {}, async (input, init) => {
    const url = String(input)
    if (url === syncRoot) return Response.json({ private: true })
    if (url.endsWith('git/ref/heads/master')) return Response.json({ object: { sha: head } })
    if (url.endsWith(`git/commits/${head}`)) return Response.json({ tree: { sha: `tree-${head}` } })
    if (url.includes('git/trees/')) return Response.json({ tree: [{ path: note.path, mode: '100644', type: 'blob', size: (head === 'head-1' ? remote1 : remote2).length, sha: `blob-${head}` }], truncated: false })
    if (url.includes('git/blobs/blob-')) return Response.json({ encoding: 'base64', content: (head === 'head-1' ? remote1 : remote2).toString('base64') })
    if (init?.method && init.method !== 'GET') {
      if (init.method === 'PATCH') { patches++; if (patches === 1) { head = 'head-2'; return new Response('{}', { status: 422 }) } return Response.json({}) }
      return Response.json({ sha: `new-${head}` })
    }
    return new Response('{}', { status: 404 })
  })
  await sync.run('example/synthetic', 'master', 'github_pat_syntheticTokenForTests')
  expect(patches).toBe(2)
  expect(readFileSync(path.join(l.root, note.path), 'utf8')).toContain('远端二版')
  l.refresh()
  expect(l.conflicts.size).toBe(0)
})
it('缺少 lastRemoteSha 的旧状态文件走完整拉取路径', async () => {
  const l = library()
  l.save({ kind: 'inspiration', title: '旧状态', body: '内容' })
  atomic(syncStateFile(l), JSON.stringify({ hashes: {}, time: '2026-01-01T00:00:00.000Z' }))
  const calls: string[] = []
  const sync = new GithubSync(l, () => {}, async (input, init) => {
    calls.push(`${init?.method || 'GET'} ${String(input)}`)
    const url = String(input)
    if (url === syncRoot) return Response.json({ private: true })
    if (url.endsWith('git/ref/heads/master')) return Response.json({ object: { sha: 'head-9' } })
    if (url.endsWith('git/commits/head-9')) return Response.json({ tree: { sha: 'tree-9' } })
    if (url.endsWith('git/trees/tree-9?recursive=1')) return Response.json({ tree: [], truncated: false })
    if (init?.method === 'POST') return Response.json({ sha: 'new' })
    if (init?.method === 'PATCH') return Response.json({})
    return new Response('{}', { status: 404 })
  })
  await sync.run('example/synthetic', 'master', 'github_pat_syntheticTokenForTests')
  expect(calls.some(c => c === `GET ${syncRoot}/git/trees/tree-9?recursive=1`)).toBe(true)
  expect(JSON.parse(readFileSync(syncStateFile(l), 'utf8'))).toMatchObject({ lastRemoteSha: 'new', lastTreeSha: 'new' })
})
it('SQLite 索引损坏时保留副本并从 Markdown 自动重建', () => {
  const root = mkdtempSync(path.join(temporary, 'corrupt-index-'))
  mkdirSync(path.join(root, 'local'), { recursive: true })
  writeFileSync(path.join(root, 'local/index.sqlite'), '这不是 SQLite 数据库')
  mkdirSync(path.join(root, 'memories'), { recursive: true })
  writeFileSync(path.join(root, 'memories/test.md'), '---\nxmemeory_id: recovered-note\ntype: memory\ntitle: 保留正文\n---\n数据库损坏后仍能恢复的 Markdown')
  const l = new Library(root); libraries.push(l)
  expect(l.get('recovered-note').body).toContain('仍能恢复的 Markdown')
  expect(l.search({ query: '数据库损坏' })).toHaveLength(1)
  expect(l.errors.join('')).toContain('已保留损坏副本')
  expect(readdirSync(path.join(root, 'local')).some(file => file.startsWith('index.sqlite.corrupt-'))).toBe(true)
  expect(l.db.prepare('PRAGMA quick_check').get()).toMatchObject({ quick_check: 'ok' })
})
it('SQLite 被另一连接锁住时仍保存正文，解锁后自动恢复索引', async () => {
  const l = library()
  const blocker = new DatabaseSync(path.join(l.root, 'local/index.sqlite'))
  try {
    blocker.exec('BEGIN IMMEDIATE')
    const note = l.save({ kind: 'inspiration', title: '锁冲突', body: '必须保留的正文' })
    expect(readFileSync(path.join(l.root, note.path), 'utf8')).toContain('必须保留的正文')
    expect(l.search({ query: '必须保留' })).toHaveLength(1)
    expect(l.errors.join('')).toContain('被其他进程占用')
    // Even constructor schema initialization must tolerate an existing writer.
    const reopened = new Library(l.root); libraries.push(reopened)
    expect(reopened.get(note.id).body).toBe('必须保留的正文')
    blocker.exec('ROLLBACK')
    await expect.poll(() => l.errors, { timeout: 5000 }).toEqual([])
    expect(l.db.prepare('SELECT count(*) AS count FROM search').get()?.count).toBe(1)
    expect(() => l.refresh()).not.toThrow()
  } finally { blocker.close() }
})
it('表格内双链别名不被拆列，代码块与普通正文原样保留', () => {
  const source = '[[正文|别名]]\n\n| 名称 | 链接 |\n| --- | --- |\n| 测试 | [[目标|别名]] |\n\n```md\n| 名称 | 链接 |\n| --- | --- |\n| 测试 | [[目标|别名]] |\n```'
  const prepared = prepareMarkdown(source)
  expect(prepared).toContain('| 测试 | [[目标\\|别名]] |')
  expect(prepared.split('```md')[1]).toBe(source.split('```md')[1])
  expect(prepared).toContain('[[正文|别名]]')
  expect(prepareMarkdown(prepared)).toBe(prepared)
})
afterEach(async () => { for (const l of libraries.splice(0)) await l.close() })
describe('本地 Markdown 资料库', () => {
  it('重读外部编辑、中文检索并保留未知 Front Matter', () => {
    const l = library(), n = l.save({ kind: 'inspiration', title: '测试灵感', body: '第一版' })
    const file = path.join(l.root, n.path)
    writeFileSync(file, readFileSync(file, 'utf8').replace('type: inspiration', 'custom: 保留字段\ntype: inspiration').replace('第一版', '外部编辑：中文检索'))
    l.refresh()
    expect(l.search({ query: '中文' })[0].id).toBe(n.id)
    const current = l.get(n.id)
    l.save({ ...current, body: current.body + '\n[[双链]]' }, current.hash)
    expect(readFileSync(file, 'utf8')).toContain('custom: 保留字段')
  })
  it('并发修改不覆盖，选择保留双方后两篇都可检索', () => {
    const l = library(), n = l.save({ kind: 'inspiration', title: '冲突', body: '原文' })
    const file = path.join(l.root, n.path)
    writeFileSync(file, readFileSync(file, 'utf8').replace('原文', '外部版本'))
    expect(() => l.save({ ...n, body: '应用版本' }, n.hash)).toThrow('保留双方')
    expect(l.get(n.id).body).toBe('外部版本')
    l.resolve([...l.conflicts.keys()][0], 'both')
    expect(l.search({ query: '版本' })).toHaveLength(2)
    expect(l.conflicts.size).toBe(0)
  })
  it('删除与恢复持久化，采集更新不标为用户编辑', () => {
  const l = library(), n = l.save({ kind: 'memory', title: '书签', body: '正文', publishedAt: '2026-09-14T08:30:00.000Z' })
  const updated = l.save({ ...n, body: '正文\n图片' }, n.hash)
  expect(updated.publishedAt).toBe('2026-09-14T08:30:00.000Z')
    expect(l.get(n.id).userEdited).not.toBe(true)
    l.remove(n.id); l.refresh(); expect(l.search({})).toHaveLength(0)
    l.remove(n.id, true); l.refresh(); expect(l.search({})).toHaveLength(1)
  })
  it('记忆按账号分层保存，作者与原文写入 Markdown', () => {
    const l = library(), n = l.save({ id: 'x-12-34', kind: 'memory', title: '分层书签', body: '正文', author: 'alice', source: 'https://x.com/alice/status/34' })
    expect(n.path).toBe('memories/12/34.md')
    const raw = readFileSync(path.join(l.root, n.path), 'utf8')
    expect(raw).toContain('author: alice')
    expect(raw).toContain('https://x.com/alice/status/34')
    l.refresh()
    expect(l.get(n.id).author).toBe('alice')
    expect(l.search({ query: 'alice', kind: 'memory' })).toHaveLength(1)
  })
  it('拒绝越界路径与伪装图片', () => {
    const l = library()
    expect(() => safePath(l.root, '../secrets')).toThrow()
    expect(() => l.addImage(Buffer.from('<script>'), 'image.png')).toThrow()
  })
})
it('同步判断区分单端修改和双方冲突，禁止凭据同步', () => {
  expect(mergeChoice('old', 'new', 'old')).toBe('local')
  expect(mergeChoice('old', 'old', 'new')).toBe('remote')
  expect(mergeChoice('old', 'left', 'right')).toBe('conflict')
  expect(syncAllowed('local/credentials.bin')).toBe(false)
  expect(syncAllowed('cookies.txt')).toBe(false)
  expect(syncAllowed('inspirations/测试.md')).toBe(true)
  expect(syncAllowed('metadata/x-1-2.capture.json')).toBe(true)
  expect(syncAllowed('metadata/../credentials.json')).toBe(false)
  const snapshot = new Map([['inspirations/a.md', Buffer.from('local winner')], ['conflicts/c.json', Buffer.from('resolved')]])
  const hashes = mergedHashes(snapshot)
  expect(mergeChoice(hashes['inspirations/a.md'], hashes['inspirations/a.md'], hashes['inspirations/a.md'])).toBe('same')
  expect(Object.keys(hashes)).toEqual(['inspirations/a.md', 'conflicts/c.json'])
})
it('搜索关键词与冲突差异按纯文本分段高亮', () => {
  expect(splitMatches('标题 <script>关键词</script>', '关键词 script').filter(part => part.highlighted).map(part => part.text)).toEqual(['script', '关键词', 'script'])
  const [current, incoming] = splitDifference('共同开头\n本地内容\n共同结尾', '共同开头\n远端内容\n共同结尾')
  expect(current.find(part => part.highlighted)?.text).toBe('本地')
  expect(incoming.find(part => part.highlighted)?.text).toBe('远端')
})
it('候选稿保留本地素材和实际读取的网络来源', () => {
  const l = library()
  const saved = l.save({ kind: 'draft', title: '联网候选稿', body: '生成正文', sources: ['memory-one'], agentMode: 'web', webSources: [{ title: '公开资料', url: 'https://example.com/article', source: 'example.com', accessedAt: '2026-09-15T12:00:00.000Z' }] })
  const reopened = new Library(l.root); libraries.push(reopened)
  expect(reopened.get(saved.id)).toMatchObject({ sources: ['memory-one'], agentMode: 'web', webSources: [{ title: '公开资料', url: 'https://example.com/article', source: 'example.com' }] })
})

