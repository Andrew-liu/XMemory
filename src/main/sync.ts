import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Library, atomic, decode, hash, safePath, walk, equivalentMarkdown, mergeCompletionTimeOnly } from './library'
import { githubJson } from './github-request'
import { SyncCache, gitBlobHash } from './sync-cache'
import type { Note } from '../shared/types'

export function normalizeGithubToken(value: string) {
  const token = value.trim()
  if (!token) throw new Error('请先填写 GitHub 个人访问 Token')
  if (/^(?:Bearer|token)\s/i.test(token)) throw new Error('Token 输入框只填密钥本身，不要包含 Bearer 或 token 前缀')
  if (!/^(?:github_pat_|ghp_)[A-Za-z0-9_]+$/.test(token) && !/^[a-f0-9]{40}$/i.test(token)) throw new Error('Token 格式不正确：请粘贴 GitHub 生成的完整值，不要填写名称、引号、掩码或隐藏字符')
  return token
}

export function githubTokenKind(value: string | undefined) {
  if (!value) return undefined
  try { const token = normalizeGithubToken(value); return token.startsWith('github_pat_') ? 'fine-grained' as const : 'classic' as const } catch { return 'invalid' as const }
}

export function normalizeRepository(value: string) {
  let repo = value.trim()
  if (/^https:\/\//i.test(repo)) {
    const url = new URL(repo)
    if (url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) throw new Error('请填写 GitHub 仓库地址或 owner/repo')
    repo = url.pathname.replace(/^\//, '')
  }
  repo = repo.replace(/\/$/, '').replace(/\.git$/, '')
  if (!/^[\w-]+\/[\w.-]+$/.test(repo) || ['.', '..'].includes(repo.split('/')[1])) throw new Error('请填写 GitHub 仓库地址或 owner/repo')
  return repo
}

export function syncAllowed(file: string) {
  return file === 'manifest.json' || /^(inspirations|memories|drafts|topics)\/[\w\u0080-\uFFFF .()/+-]+\.md$/.test(file) || /^(metadata|tombstones|conflicts)\/[\w-]+\.json$/.test(file) || /^metadata\/[\w-]+\.capture\.json$/.test(file) || /^assets\/[\w .()-]+\.(png|jpg|jpeg|webp|gif)$/i.test(file)
}
export function mergeChoice(base: string | undefined, local: string | undefined, remote: string | undefined): 'same' | 'local' | 'remote' | 'conflict' {
  if (local === remote) return 'same'
  if (local === base) return 'remote'
  if (remote === base) return 'local'
  return 'conflict'
}
export function mergedHashes(files: Map<string, Buffer>) {
  return Object.fromEntries([...files].map(([file, content]) => [file, hash(content)]))
}
export async function runConfiguredStartupSync(sync: Pick<GithubSync, 'run'>, repo: string | undefined, branch: string, token: string | undefined) {
  if (!repo?.trim() || !token?.trim()) return false
  try { await sync.run(repo, branch, token) } catch {}
  return true
}
export class GithubSync {
  running = false
  status = '尚未连接数据仓库'
  constructor(private library: Library, private changed: () => void, private request: typeof fetch = (input, init) => fetch(input, init), private editorDirty: () => boolean = () => false) {}
  check(repo: string, branch: string, token: string) { return this.run(repo, branch, token, true) }
  async run(repo: string, branch: string, token: string, checkOnly = false) {
    if (this.running) throw new Error('正在检查或同步，请等待当前操作结束')
    repo = normalizeRepository(repo)
    branch = branch.trim()
    if (!/^[\w./-]+$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.startsWith('-') || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) throw new Error('请填写有效分支名，例如 main 或 master')
    token = normalizeGithubToken(token)
    this.running = true
    const stateFile = path.join(this.library.root, 'local', `sync-${hash(repo+branch).slice(0,16)}.json`)
    let authenticatedAs = ''
    const updateStatus = (message: string) => { this.status = message; this.changed() }
    const api = async (endpoint: string, method = 'GET', body?: unknown): Promise<any> => {
      const stage = !endpoint ? '读取仓库' : endpoint.startsWith('git/ref/heads/') ? `读取分支 ${branch}` : method !== 'GET' ? (endpoint.startsWith('git/refs/') ? '更新远端分支' : '写入远端内容') : endpoint.startsWith('git/trees/') ? '读取远端目录' : endpoint.startsWith('git/blobs/') ? '读取远端文件' : '读取远端提交'
      const { response, data } = await githubJson(this.request, `https://api.github.com/repos/${repo}${endpoint ? `/${endpoint}` : ''}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error' }, stage, updateStatus)
      if (!response.ok) {
        const reason = response.status === 401 ? 'GitHub 未接受此 Token，可能已失效、被撤销或复制不完整。请重新生成并粘贴完整新值，再检查连接；修改分支或 Contents 权限不能修复认证失败'
          : response.status === 404 && !endpoint ? `${authenticatedAs ? `Token 已认证为 @${authenticatedAs}，但` : ''}仓库 ${repo} 不可访问。细粒度 Token 请核对 Resource owner 为 ${repo.split('/')[0]}、Repository access 已选中 ${repo.split('/')[1]}，并确认授权已批准；同步还需 Contents: Read and write`
          : response.status === 404 && endpoint.startsWith('git/ref/heads/') ? '仓库可访问，但无法读取此分支；请检查分支是否存在及 Token 的 Contents 权限'
          : response.status === 409 && method === 'GET' ? '仓库可能尚无提交，请先在 GitHub 创建首个文件和提交，并填写实际分支'
          : response.status === 403 ? '访问受限，请检查 Token 的 Contents 读写权限、组织授权及 API 限额'
          : '同步已暂停，请检查权限或稍后重试'
        throw new Error(`GitHub ${response.status}（${stage}）：${reason}`)
      }
      return data
    }
    try {
      if (checkOnly) {
        this.status = '正在验证 Token 身份…'; this.changed()
        const { response, data: identity } = await githubJson(this.request, 'https://api.github.com/user', { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, redirect: 'error' }, '验证 Token', updateStatus)
        if (response.status === 401) throw new Error('GitHub 401（验证 Token）：GitHub 未接受当前保存的 Token。请重新生成并粘贴完整新值，再检查连接；此时尚未检查仓库或分支权限')
        if (!response.ok) throw new Error(`GitHub ${response.status}（验证 Token）：身份检查未通过，请检查 API 限额、账号限制或稍后重试`)
        if (typeof identity.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(identity.login)) authenticatedAs = identity.login
      }
      this.status = '校验私有仓库…'; this.changed()
      const meta = await api('')
      if (meta.private !== true) throw new Error('数据仓库必须为 private，已停止同步')
      const head = await api(`git/ref/heads/${branch}`)
      if (checkOnly) {
        this.status = `连接检查通过${authenticatedAs ? `（@${authenticatedAs}）` : ''}：可读取私库 ${repo} 的 ${branch} 分支。未上传内容；写入仍需 Contents: Read and write 权限`
        return
      }
      const state: { hashes: Record<string,string> } = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { hashes: {} }
      const commit = await api(`git/commits/${head.object.sha}`)
      const tree = await api(`git/trees/${commit.tree.sha}?recursive=1`)
      if (tree.truncated) throw new Error('远端目录过大，本次未读取完整，停止同步')
      const remote = new Map<string, Buffer>()
      const cache = new SyncCache(this.library.root, hash(JSON.stringify([repo, branch])).slice(0, 24))
      let downloaded = 0, reused = 0, cached = 0
      const entries = tree.tree.filter((e: any) => syncAllowed(e.path))
      for (const e of entries) {
        if (e.mode !== '100644' || e.type !== 'blob' || e.size > 20*1024*1024) throw new Error('远端包含不支持的对象或超限文件')
        const target = safePath(this.library.root, e.path)
        if (typeof e.sha !== 'string' || !/^[\w-]+$/.test(e.sha)) throw new Error('远端文件标识无效')
        const local = existsSync(target) ? readFileSync(target) : undefined
        if (local && gitBlobHash(local) === e.sha) {
          remote.set(e.path, local); reused++; cache.put(local); continue
        }
        const saved = cache.read(e.sha)
        if (saved) { remote.set(e.path, saved); cached++; continue }
        const blob = await api(`git/blobs/${e.sha}`)
        if (blob.encoding !== 'base64') throw new Error('远端文件编码不支持')
        const content = Buffer.from(blob.content, 'base64')
        if (content.length > 20 * 1024 * 1024) throw new Error('远端文件超出大小限制')
        if (/^[a-f0-9]{40}$/.test(e.sha) && gitBlobHash(content) !== e.sha) throw new Error('远端文件完整性校验失败，已停止同步')
        remote.set(e.path, content); downloaded++; cache.put(content)
      }
      const remoteManifest = remote.get('manifest.json')
      if (remoteManifest && JSON.parse(remoteManifest.toString()).schemaVersion !== 1) throw new Error('远端资料库版本不兼容')
      if (this.editorDirty()) throw new Error('检测到正在编辑的未保存内容，本轮同步已延后；保存完成后可重新同步')
      this.status = '比较本地与远端内容…'; this.changed()
      this.library.refresh()
      const merged = new Map<string, Buffer>(remote)
      const paths = new Set([...remote.keys(), ...walk(this.library.root).filter(syncAllowed)])
      let metadataConflicts = 0
      for (const file of paths) {
        const target = safePath(this.library.root, file)
        const local = existsSync(target) ? readFileSync(target) : undefined
        const theirs = remote.get(file)
        // Missing files are not deletion commands. Tombstones are the only portable deletion signal.
        if (!local && theirs) { atomic(target, theirs); continue }
        if (local && !theirs) { merged.set(file, local); continue }
        if (!local || !theirs) continue
        const choice = mergeChoice(state.hashes[file], hash(local), hash(theirs))
        if (choice === 'local' || choice === 'same') merged.set(file, local)
        else if (choice === 'remote') atomic(target, theirs)
        else if (file.endsWith('.md')) {
          if (equivalentMarkdown(local.toString(), theirs.toString())) { merged.set(file, local); continue }
          const completionMerged = mergeCompletionTimeOnly(local.toString(), theirs.toString())
          if (completionMerged !== undefined) {
            const content = Buffer.from(completionMerged)
            merged.set(file, content)
            if (!content.equals(local)) atomic(target, content)
            continue
          }
          const current = [...this.library.notes.values()].find(n => n.path === file)
          if (!current) throw new Error('无法关联冲突正文，已保留文件并停止')
          const parsed = decode(theirs.toString())
          const incoming: Note = { ...current, body: parsed.body, title: String(parsed.metadata.title || current.title), hash: hash(theirs), updatedAt: String(parsed.metadata.updatedAt || '远端版本') }
          if (current.kind === 'topic') {
            incoming.completed = parsed.metadata.completed === true
            incoming.completedAt = incoming.completed && typeof parsed.metadata.completedAt === 'string' ? parsed.metadata.completedAt : undefined
          }
          this.library.addConflict(current, incoming, { currentRaw: local.toString(), incomingRaw: theirs.toString() })
          merged.set(file, local)
        } else if (file.startsWith('assets/')) {
          throw new Error('同名图片内容不同，停止同步以避免覆盖；请重命名其中一份')
        } else if (file !== 'manifest.json') {
          // Preserve both metadata variants without aborting the whole sync. The local variant is
          // uploaded as the shared baseline, while the remote variant remains recoverable locally.
          const recovery = path.join(this.library.root, 'local', `sync-conflict-${hash(file).slice(0,16)}.json`)
          atomic(recovery, JSON.stringify({ path: file, local: local.toString('base64'), remote: theirs.toString('base64') }))
          merged.set(file, local)
          metadataConflicts++
        }
      }
      for (const file of walk(this.library.root, 'conflicts').filter(syncAllowed)) merged.set(file, readFileSync(safePath(this.library.root, file)))
      const changes: any[] = []
      let bytes = 0
      for (const [file, content] of merged) {
        if (remote.has(file) && hash(remote.get(file)!) === hash(content)) continue
        if (content.length > 20*1024*1024) throw new Error('文件超过单文件同步限制，仍保留本地')
        bytes += content.length
        if (bytes > 100*1024*1024) throw new Error('本轮变化超过 100 MiB，尚未提交远端；需要分批同步支持')
        this.status = `上传 ${file.startsWith('assets/') ? '图片' : '内容'}…`; this.changed()
        const blob = await api('git/blobs', 'POST', { content: content.toString('base64'), encoding: 'base64' })
        cache.put(content)
        changes.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha })
      }
      if (changes.length) {
        const newTree = await api('git/trees', 'POST', { base_tree: commit.tree.sha, tree: changes })
        const newCommit = await api('git/commits', 'POST', { message: 'Sync XMemeory library', tree: newTree.sha, parents: [head.object.sha] })
        // No force: concurrent remote writes reject this update rather than overwrite data.
        await api(`git/refs/heads/${branch}`, 'PATCH', { sha: newCommit.sha, force: false })
      }
      atomic(stateFile, JSON.stringify({ hashes: mergedHashes(merged), time: new Date().toISOString() }))
      cache.prune(new Set([...merged.values()].map(gitBlobHash)))
      this.library.refresh()
      const pending = this.library.conflicts.size
      this.status = pending || metadataConflicts ? `内容已同步，${pending} 项正文冲突待处理${metadataConflicts ? `，${metadataConflicts} 项元数据差异已保留恢复记录` : ''}` : `已同步 · ${new Date().toLocaleTimeString('zh-CN')}`
      this.status += ` · 下载 ${downloaded} · 复用本地 ${reused} · 缓存命中 ${cached}`
    } catch (e) { this.status = e instanceof Error ? e.message : '同步失败'; throw e }
    finally { this.running = false; this.changed() }
  }
}
