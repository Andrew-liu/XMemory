import { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Library, atomic, decode, hash, safePath, walk, equivalentMarkdown, mergeCompletionTimeOnly } from './library'
import { githubJson } from './github-request'
import { SyncCache, gitBlobHash } from './sync-cache'
import { ATTACHMENTS, LEGACY_ASSETS, PRIVATE, SCHEMA_VERSION, TRASH, logicalPath, privatePath } from './layout'
import { migrateFiles, syncAllowedV1 } from './migrate'
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

/** Files synced by layout v2. Trashed notes sync under the path they had before deletion (see GithubSync.physical). */
export function syncAllowed(file: string) {
  return file === 'manifest.json' || /^(inspirations|memories|drafts|topics)\/[\w\u0080-\uFFFF .()/+-]+\.md$/.test(file) || /^\.xmemeory\/(metadata|tombstones|conflicts)\/[\w-]+\.json$/.test(file) || /^\.xmemeory\/metadata\/[\w-]+\.capture\.json$/.test(file) || /^attachments\/[\w .()-]+\.(png|jpg|jpeg|webp|gif)$/i.test(file)
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
/** Let queued input and IPC run between batches of synchronous file work on the main process. */
export const yieldToEvents = () => new Promise<void>(resolve => setImmediate(resolve))
export class GithubSync {
  running = false
  status = '尚未连接数据仓库'
  private hashCache = new Map<string, { mtimeMs: number; size: number; digest: string }>()
  constructor(private library: Library, private changed: () => void, private request: typeof fetch = (input, init) => fetch(input, init), private editorDirty: () => boolean = () => false) {}
  /** Logical sync path -> library-relative file on disk: a trashed note lives under .xmemeory/trash with the same relative path. */
  private physical(file: string) {
    const root = this.library.root
    return !existsSync(path.join(root, file)) && existsSync(path.join(root, TRASH, file)) ? `${TRASH}/${file}` : file
  }
  /** Logical paths of every local file that syncs. */
  private localFiles() {
    const root = this.library.root
    const files = [...walk(root), ...['metadata', 'tombstones', 'conflicts'].flatMap(folder => walk(root, `${PRIVATE}/${folder}`)), ...walk(root, TRASH).map(logicalPath)]
    return [...new Set(files)].filter(syncAllowed)
  }
  /** Content hash, reused while the file's mtime and size are unchanged. */
  localHash(file: string) {
    const stat = lstatSync(file)
    const cached = this.hashCache.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.digest
    const digest = hash(readFileSync(file))
    this.hashCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, digest })
    return digest
  }
  check(repo: string, branch: string, token: string) { return this.run(repo, branch, token, true) }
  async run(repo: string, branch: string, token: string, checkOnly = false) {
    if (this.running) throw new Error('正在检查或同步，请等待当前操作结束')
    repo = normalizeRepository(repo)
    branch = branch.trim()
    if (!/^[\w./-]+$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.startsWith('-') || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) throw new Error('请填写有效分支名，例如 main 或 master')
    token = normalizeGithubToken(token)
    this.running = true
    const stateFile = privatePath(this.library.root, 'local', `sync-${hash(repo+branch).slice(0,16)}.json`)
    let authenticatedAs = ''
    const updateStatus = (message: string) => { this.status = message; this.changed() }
    const api = async (endpoint: string, method = 'GET', body?: unknown, tolerated?: number): Promise<any> => {
      const stage = !endpoint ? '读取仓库' : endpoint.startsWith('git/ref/heads/') ? `读取分支 ${branch}` : method !== 'GET' ? (endpoint.startsWith('git/refs/') ? '更新远端分支' : '写入远端内容') : endpoint.startsWith('git/trees/') ? '读取远端目录' : endpoint.startsWith('git/blobs/') ? '读取远端文件' : '读取远端提交'
      const { response, data } = await githubJson(this.request, `https://api.github.com/repos/${repo}${endpoint ? `/${endpoint}` : ''}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error' }, stage, updateStatus)
      if (!response.ok) {
        if (response.status === tolerated) return { rejected: response.status }
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
      if (checkOnly) {
        const head = await api(`git/ref/heads/${branch}`)
        this.status = `连接检查通过${authenticatedAs ? `（@${authenticatedAs}）` : ''}：可读取私库 ${repo} 的 ${branch} 分支。未上传内容；写入仍需 Contents: Read and write 权限`
        return
      }
      // legacyHashes: the v1 baseline kept by the local layout upgrade, until the remote has been upgraded too.
      const state: { hashes: Record<string,string>; legacyHashes?: Record<string,string>; time?: string; lastRemoteSha?: string; lastTreeSha?: string } = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { hashes: {} }
      const cache = new SyncCache(this.library.root, hash(JSON.stringify([repo, branch])).slice(0, 24))
      for (let attempt = 1; attempt <= 3; attempt++) {
        const head = await api(`git/ref/heads/${branch}`)
        const remoteChanged = state.lastRemoteSha !== head.object.sha || !state.lastTreeSha || !!state.legacyHashes
        const merged = new Map<string, Buffer>()
        let baseline = state.hashes
        // Three-way merge base; differs from the upload baseline only when the remote is upgraded in this round.
        let mergeBase = state.hashes
        let legacyPaths: string[] = []
        let remoteShas = new Set<string>()
        let baseTreeSha = state.lastTreeSha || ''
        let pulled = 0, downloaded = 0, reused = 0, cached = 0, metadataConflicts = 0
        if (remoteChanged) {
          const commit = await api(`git/commits/${head.object.sha}`)
          const tree = await api(`git/trees/${commit.tree.sha}?recursive=1`)
          if (tree.truncated) throw new Error('远端目录过大，本次未读取完整，停止同步')
          let remote = new Map<string, Buffer>()
          const load = async (e: any, legacy: boolean): Promise<Buffer> => {
            if (e.mode !== '100644' || e.type !== 'blob' || e.size > 20*1024*1024) throw new Error('远端包含不支持的对象或超限文件')
            if (typeof e.sha !== 'string' || !/^[\w-]+$/.test(e.sha)) throw new Error('远端文件标识无效')
            // A v1 image is already on disk under attachments/ after the local upgrade.
            const localPath = legacy && e.path.startsWith(`${LEGACY_ASSETS}/`) ? `${ATTACHMENTS}/${e.path.slice(LEGACY_ASSETS.length + 1)}` : e.path
            const target = safePath(this.library.root, this.physical(localPath))
            const local = existsSync(target) ? readFileSync(target) : undefined
            if (local && gitBlobHash(local) === e.sha) { reused++; cache.put(local); return local }
            const saved = cache.read(e.sha)
            if (saved) { cached++; return saved }
            const blob = await api(`git/blobs/${e.sha}`)
            if (blob.encoding !== 'base64') throw new Error('远端文件编码不支持')
            const content = Buffer.from(blob.content, 'base64')
            if (content.length > 20 * 1024 * 1024) throw new Error('远端文件超出大小限制')
            if (/^[a-f0-9]{40}$/.test(e.sha) && gitBlobHash(content) !== e.sha) throw new Error('远端文件完整性校验失败，已停止同步')
            downloaded++; cache.put(content)
            return content
          }
          const manifestEntry = tree.tree.find((e: any) => e.path === 'manifest.json')
          const manifestContent = manifestEntry ? await load(manifestEntry, false) : undefined
          const remoteVersion = manifestContent ? JSON.parse(manifestContent.toString()).schemaVersion : SCHEMA_VERSION
          if (remoteVersion !== 1 && remoteVersion !== SCHEMA_VERSION) throw new Error('远端资料库版本不兼容')
          const legacyRemote = remoteVersion === 1
          const entries = tree.tree.filter((e: any) => legacyRemote ? syncAllowedV1(e.path) : syncAllowed(e.path))
          remoteShas = new Set(tree.tree.map((e: any) => e.sha))
          let scanned = 0
          for (const e of entries) {
            if (++scanned % 50 === 0) await yieldToEvents()
            remote.set(e.path, e.path === 'manifest.json' && manifestContent ? manifestContent : await load(e, legacyRemote))
          }
          if (legacyRemote) {
            // The remote still has the v1 layout: upgrade it the same way the local library was, keeping the local
            // path for notes this device already has, then push the whole v2 tree and delete the v1 paths.
            this.status = '升级远端资料库结构…'; this.changed()
            const migrated = migrateFiles(remote, new Map([...this.library.notes.values()].map(n => [n.id, logicalPath(n.path)])))
            const legacy = state.legacyHashes || state.hashes
            mergeBase = {}
            for (const [old, content] of remote) {
              const target = migrated.paths.get(old)
              if (target && legacy[old] === hash(content)) mergeBase[target] = hash(migrated.files.get(target)!)
            }
            legacyPaths = entries.map((e: any) => e.path)
            remote = migrated.files
          }
          if (this.editorDirty()) throw new Error('检测到正在编辑的未保存内容，本轮同步已延后；保存完成后可重新同步')
          this.status = '比较本地与远端内容…'; this.changed()
          this.library.refresh()
          for (const [file, content] of remote) merged.set(file, content)
          const paths = new Set([...remote.keys(), ...this.localFiles()])
          for (const file of paths) {
            const target = safePath(this.library.root, this.physical(file))
            const local = existsSync(target) ? readFileSync(target) : undefined
            const theirs = remote.get(file)
            // Missing files are not deletion commands. Tombstones are the only portable deletion signal.
            if (!local && theirs) { atomic(target, theirs); pulled++; continue }
            if (local && !theirs) { merged.set(file, local); continue }
            if (!local || !theirs) continue
            const choice = mergeChoice(mergeBase[file], hash(local), hash(theirs))
            if (choice === 'local' || choice === 'same') merged.set(file, local)
            else if (choice === 'remote') { atomic(target, theirs); pulled++ }
            else if (file.endsWith('.md')) {
              if (equivalentMarkdown(local.toString(), theirs.toString())) { merged.set(file, local); continue }
              const completionMerged = mergeCompletionTimeOnly(local.toString(), theirs.toString())
              if (completionMerged !== undefined) {
                const content = Buffer.from(completionMerged)
                merged.set(file, content)
                if (!content.equals(local)) { atomic(target, content); pulled++ }
                continue
              }
              const current = [...this.library.notes.values()].find(n => logicalPath(n.path) === file)
              if (!current) throw new Error('无法关联冲突正文，已保留文件并停止')
              const parsed = decode(theirs.toString())
              const incoming: Note = { ...current, body: parsed.body, title: String(parsed.metadata.title || current.title), hash: hash(theirs), updatedAt: String(parsed.metadata.updatedAt || '远端版本') }
              if (current.kind === 'topic') {
                incoming.completed = parsed.metadata.completed === true
                incoming.completedAt = incoming.completed && typeof parsed.metadata.completedAt === 'string' ? parsed.metadata.completedAt : undefined
              }
              this.library.addConflict(current, incoming, { currentRaw: local.toString(), incomingRaw: theirs.toString() })
              merged.set(file, local)
            } else if (file.startsWith(`${ATTACHMENTS}/`)) {
              throw new Error('同名图片内容不同，停止同步以避免覆盖；请重命名其中一份')
            } else if (file !== 'manifest.json') {
              // Preserve both metadata variants without aborting the whole sync. The local variant is
              // uploaded as the shared baseline, while the remote variant remains recoverable locally.
              const recovery = privatePath(this.library.root, 'local', `sync-conflict-${hash(file).slice(0,16)}.json`)
              atomic(recovery, JSON.stringify({ path: file, local: local.toString('base64'), remote: theirs.toString('base64') }))
              merged.set(file, local)
              metadataConflicts++
            }
          }
          for (const file of walk(this.library.root, `${PRIVATE}/conflicts`).filter(syncAllowed)) merged.set(file, readFileSync(safePath(this.library.root, file)))
          // After a remote upgrade nothing exists yet at the v2 paths, so everything counts as changed.
          baseline = legacyPaths.length ? {} : Object.fromEntries([...remote].map(([file, content]) => [file, hash(content)]))
          baseTreeSha = commit.tree.sha
        } else {
          if (this.editorDirty()) throw new Error('检测到正在编辑的未保存内容，本轮同步已延后；保存完成后可重新同步')
          // Remote unchanged: only files whose content differs from the last synced baseline need reading.
          // Hashes are cached by mtime+size so an idle library is not re-read and re-hashed every round.
          const files = this.localFiles()
          for (let i = 0; i < files.length; i++) {
            if (i % 50 === 49) await yieldToEvents()
            const target = safePath(this.library.root, this.physical(files[i]))
            if (state.hashes[files[i]] === this.localHash(target)) continue
            merged.set(files[i], readFileSync(target))
          }
        }
        const changes: any[] = []
        const uploadedHashes: Record<string, string> = {}
        let bytes = 0
        for (const [file, content] of merged) {
          if (baseline[file] === hash(content)) continue
          if (content.length > 20*1024*1024) throw new Error('文件超过单文件同步限制，仍保留本地')
          bytes += content.length
          // Same bytes already stored remotely (e.g. an image moved from assets/ to attachments/): reference, don't upload.
          const existing = gitBlobHash(content)
          if (remoteShas.has(existing)) { changes.push({ path: file, mode: '100644', type: 'blob', sha: existing }); uploadedHashes[file] = hash(content); bytes -= content.length; continue }
          if (bytes > 100*1024*1024) throw new Error('本轮变化超过 100 MiB，尚未提交远端；需要分批同步支持')
          this.status = `上传 ${file.startsWith(`${ATTACHMENTS}/`) ? '图片' : '内容'}…`; this.changed()
          const blob = await api('git/blobs', 'POST', { content: content.toString('base64'), encoding: 'base64' })
          cache.put(content)
          changes.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha })
          uploadedHashes[file] = hash(content)
        }
        // v1 paths left behind by a remote upgrade are removed from the tree.
        for (const file of legacyPaths) if (!merged.has(file)) changes.push({ path: file, mode: '100644', type: 'blob', sha: null })
        let headSha = head.object.sha, treeSha = baseTreeSha
        if (changes.length) {
          const newTree = await api('git/trees', 'POST', { base_tree: baseTreeSha, tree: changes })
          const newCommit = await api('git/commits', 'POST', { message: 'Sync XMemeory library', tree: newTree.sha, parents: [head.object.sha] })
          // No force: concurrent remote writes reject this update rather than overwrite data.
          const refUpdate = await api(`git/refs/heads/${branch}`, 'PATCH', { sha: newCommit.sha, force: false }, 422)
          if (refUpdate?.rejected === 422) {
            if (attempt === 3) throw new Error('远端持续变化，本地内容已保留，请稍后重试')
            if (remoteChanged) state.hashes = { ...state.hashes, ...baseline }
            continue
          }
          headSha = newCommit.sha; treeSha = newTree.sha
        }
        atomic(stateFile, JSON.stringify({ hashes: remoteChanged ? mergedHashes(merged) : { ...state.hashes, ...uploadedHashes }, lastRemoteSha: headSha, lastTreeSha: treeSha, time: new Date().toISOString() }))
        if (remoteChanged) cache.prune(new Set([...merged.values()].map(gitBlobHash)))
        // Nothing local was written when the remote was unchanged; the watcher already tracks local edits.
        if (remoteChanged) this.library.refresh()
        const pending = this.library.conflicts.size
        this.status = `${remoteChanged ? `已拉取 ${pulled} 项远端更新` : '远端无更新'} · 已上传 ${changes.length} 项`
        if (pending || metadataConflicts) this.status += `，${pending} 项正文冲突待处理${metadataConflicts ? `，${metadataConflicts} 项元数据差异已保留恢复记录` : ''}`
        if (remoteChanged) this.status += ` · 下载 ${downloaded} · 复用本地 ${reused} · 缓存命中 ${cached}`
        return
      }
    } catch (e) { this.status = e instanceof Error ? e.message : '同步失败'; throw e }
    finally { this.running = false; this.changed() }
  }
}
