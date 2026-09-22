import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Library, safePath } from '../src/main/library'
import { CookieWatcher, parseCookies } from '../src/main/cookies'
import { RateLimiter } from '../src/main/rate-limit'
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
  expect(sync.status).toContain('已同步')
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
it('Cookie 只接收 X 必需登录字段，并拒绝过期与注入', () => {
  const cookie = (name: string, value: string, domain = '.x.com') => ({ name, value, domain, path: '/' })
  const valid = [cookie('auth_token', 'synthetic-auth'), cookie('ct0', 'synthetic-csrf')]
  expect(parseCookies(JSON.stringify([...valid, cookie('private', 'ignored', '.example.com')]))).toHaveLength(2)
  expect(() => parseCookies(JSON.stringify(valid.map(v => ({ ...v, expirationDate: 1 }))))).toThrow()
  expect(() => parseCookies(JSON.stringify([cookie('auth_token', 'bad;value'), valid[1]]))).toThrow()
})
it('限速冷却持久化且 429 退避递增', () => {
  let now = 0
  const limiter = new RateLimiter(undefined, () => {}, () => now, () => 0)
  limiter.take(); expect(limiter.remaining()).toBe(8000)
  expect(() => limiter.take()).toThrow()
  now = 8000; limiter.limit(); expect(limiter.remaining()).toBe(1_800_000)
  limiter.limit(); expect(limiter.remaining()).toBe(3_600_000)
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
it('自动接收已有导出、监听新文件、去重，并在关闭后停止', async () => {
  const folder = mkdtempSync(path.join(temporary, 'cookies-'))
  const exported = (value: string) => JSON.stringify(['auth_token','ct0'].map(name => ({ domain: '.x.com', path: '/', name, value })))
  writeFileSync(path.join(folder, 'cookies.txt'), exported('synthetic-one'))
  const values: string[] = []
  const watcher = new CookieWatcher(async cookies => { values.push(cookies[0].value) }, () => {})
  try {
    await watcher.watch(folder)
    expect(values).toEqual(['synthetic-one'])
    writeFileSync(path.join(folder, 'x.com_cookies (1).json'), exported('synthetic-two'))
    await expect.poll(() => values, { timeout: 5000 }).toEqual(['synthetic-one', 'synthetic-two'])
    await watcher.import(path.join(folder, 'x.com_cookies (1).json'))
    expect(values).toHaveLength(2)
    await watcher.close()
    writeFileSync(path.join(folder, 'x.com_cookies (2).json'), exported('synthetic-three'))
    expect(watcher.status).toContain('内容未变化')
  } finally { await watcher.close() }
})
