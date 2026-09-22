import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, lstatSync, realpathSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseDocument, stringify } from 'yaml'
import chokidar, { type FSWatcher } from 'chokidar'
import type { Conflict, Kind, Note, SearchHit, SearchQuery } from '../shared/types'
import { validDate } from '../shared/calendar'
import { normalizeLines, stableValue } from '../shared/conflicts'
import { referencedImages } from './export-images'

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export function atomic(file: string, value: string | Buffer) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, value, { mode: 0o600 })
  renameSync(tmp, file)
}
export function safePath(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.includes('\0')) throw new Error('路径必须在资料库内')
  const target = path.resolve(root, relative)
  const rel = path.relative(path.resolve(root), target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('路径越过资料库')
  let parent = target
  while (!existsSync(parent)) parent = path.dirname(parent)
  const actual = path.relative(realpathSync(root), realpathSync(parent))
  if (actual.startsWith('..') || path.isAbsolute(actual)) throw new Error('不允许外部符号链接')
  return target
}
export function walk(root: string, base = ''): string[] {
  if (!existsSync(path.join(root, base))) return []
  return readdirSync(path.join(root, base), { withFileTypes: true }).flatMap(item => {
    if (item.isSymbolicLink() || item.name.startsWith('.') || item.name.endsWith('.tmp')) return []
    const rel = path.posix.join(base.replaceAll('\\', '/'), item.name)
    return item.isDirectory() ? walk(root, rel) : [rel]
  })
}
export function decode(raw: string) {
  const match = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  const doc = parseDocument(match?.[1] || '', { schema: 'core', uniqueKeys: true })
  if (doc.errors.length) throw new Error('Front Matter 格式错误，请在外部修正后重新加载')
  const metadata = doc.toJS({ maxAliasCount: 0 }) || {}
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Front Matter 必须为字段集合')
  return { metadata, body: match ? raw.slice(match[0].length) : raw }
}
function corruptDatabase(error: unknown) {
  return /malformed|not a database|database disk image is malformed|file is encrypted/i.test(error instanceof Error ? error.message : '')
}
export function equivalentMarkdown(a: string, b: string) {
  const left = decode(a), right = decode(b)
  return normalizeLines(left.body) === normalizeLines(right.body) && stableValue(left.metadata) === stableValue(right.metadata)
}
export function mergeCompletionTimeOnly(a: string, b: string) {
  const left = decode(a), right = decode(b)
  if (normalizeLines(left.body) !== normalizeLines(right.body)) return undefined
  const leftMetadata = { ...left.metadata }, rightMetadata = { ...right.metadata }
  const leftTime = leftMetadata.completedAt, rightTime = rightMetadata.completedAt
  delete leftMetadata.completedAt; delete rightMetadata.completedAt
  if (leftMetadata.completed !== true || rightMetadata.completed !== true || stableValue(leftMetadata) !== stableValue(rightMetadata)) return undefined
  if (typeof leftTime !== 'string' || typeof rightTime !== 'string') return undefined
  const leftMillis = Date.parse(leftTime), rightMillis = Date.parse(rightTime)
  if (Number.isNaN(leftMillis) || Number.isNaN(rightMillis)) return undefined
  return leftMillis <= rightMillis ? a : b
}
function openIndex(root: string) {
  const file = path.join(root, 'local/index.sqlite')
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(file)
    const rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>
    if (rows.some(row => !Object.values(row).includes('ok'))) throw new Error('database disk image is malformed')
    return { db, recovered: false }
  } catch (error) {
    try { db?.close() } catch { /* Continue with corruption recovery. */ }
    if (!corruptDatabase(error) || !existsSync(file)) throw error
    const suffix = `.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      if (existsSync(candidate)) renameSync(candidate, `${candidate}${suffix}`)
    }
    return { db: new DatabaseSync(file), recovered: true }
  }
}
const folders: Record<Kind, string> = { inspiration: 'inspirations', memory: 'memories', draft: 'drafts', topic: 'topics' }
export class Library {
  notes = new Map<string, Note>()
  conflicts = new Map<string, Conflict>()
  errors: string[] = []
  db: DatabaseSync
  watcher?: FSWatcher
  private timer?: ReturnType<typeof setTimeout>
  private indexTimer?: ReturnType<typeof setTimeout>
  private indexRetries = 0
  private closed = false
  private indexRecovered = false
  constructor(public root: string, private changed: () => void = () => {}) {
    for (const folder of [...Object.values(folders), 'assets', 'metadata', 'tombstones', 'conflicts', 'local']) mkdirSync(path.join(root, folder), { recursive: true })
    if (!existsSync(path.join(root, 'manifest.json'))) atomic(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, application: 'XMemeory' }))
    const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'))
    if (manifest.schemaVersion !== 1) throw new Error('资料库版本不兼容，已停止写入')
    const index = openIndex(root)
    this.db = index.db
    this.indexRecovered = index.recovered
    this.db.exec('PRAGMA busy_timeout=100;')
    this.recover()
    this.refresh()
  }
  private recover() {
    const file = path.join(this.root, 'local/pending.json')
    if (!existsSync(file)) return
    const pending = JSON.parse(readFileSync(file, 'utf8'))
    if (pending && typeof pending.path === 'string' && typeof pending.raw === 'string') {
      const target = safePath(this.root, pending.path)
      const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
      if (hash(current) === pending.before || hash(current) === hash(pending.raw)) atomic(target, pending.raw)
      else atomic(path.join(this.root, 'local', `recovery-${randomUUID()}.md`), pending.raw)
    }
    atomic(file, 'null')
  }
  start() {
    this.watcher = chokidar.watch(Object.values(folders).map(f => path.join(this.root, f)), { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 350, pollInterval: 100 }, ignored: p => p.endsWith('.tmp') })
    this.watcher.on('all', () => { clearTimeout(this.timer); this.timer = setTimeout(() => {
      if (this.closed) return
      try { this.refresh() } catch { this.errors.push('文件刷新失败，请检查资料库访问权限；已有内容仍保留') }
      this.changed()
    }, 150) })
    this.watcher.on('error', () => { this.errors.push('文件监听失败，请检查资料库访问权限'); this.changed() })
  }
  async close() { if (this.closed) return; this.closed = true; clearTimeout(this.timer); clearTimeout(this.indexTimer); await this.watcher?.close(); this.db.close() }
  refresh() {
    if (this.closed) return
    this.errors = this.indexRecovered ? ['本地索引损坏，已保留损坏副本并从 Markdown 自动重建。'] : []
    this.indexRecovered = false
    const previous = this.notes
    const next = new Map<string, Note>()
    for (const [kind, folder] of Object.entries(folders)) {
      for (const file of walk(this.root, folder).filter(f => f.endsWith('.md'))) {
        try {
          const target = safePath(this.root, file)
          if (lstatSync(target).size > 8 * 1024 * 1024) { this.errors.push(`${file} 超出正文大小限制`); continue }
          const raw = readFileSync(target, 'utf8')
          const { metadata: meta, body } = decode(raw)
          const id = typeof meta.xmemeory_id === 'string' ? meta.xmemeory_id : `external-${hash(file).slice(0, 24)}`
          if (!/^[\w-]{1,100}$/.test(id)) throw new Error('条目 ID 无效')
          if (next.has(id)) { this.errors.push(`${file} 与其他文件 ID 重复`); continue }
          const stat = lstatSync(target)
          const auxFile = path.join(this.root, 'metadata', `${id}.json`)
          const aux = existsSync(auxFile) ? JSON.parse(readFileSync(auxFile, 'utf8')) : {}
          const tombstone = path.join(this.root, 'tombstones', `${id}.json`)
          const deleted = existsSync(tombstone) && JSON.parse(readFileSync(tombstone, 'utf8')).deleted !== false
          const old = previous.get(id)
          const note: Note = { ...aux, id, kind: kind as Kind, title: String(meta.title || body.match(/^# (.+)$/m)?.[1] || path.basename(file, '.md')), tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [], body, hash: hash(raw), path: file, createdAt: String(meta.createdAt || stat.birthtime.toISOString()), updatedAt: stat.mtime.toISOString(), deleted }
          if (typeof meta.author === 'string') note.author = meta.author
          if (typeof meta.source === 'string') note.source = meta.source
          if (typeof meta.publishedAt === 'string' && !Number.isNaN(Date.parse(meta.publishedAt))) note.publishedAt = new Date(meta.publishedAt).toISOString()
          if (Number.isInteger(meta.sortOrder) && meta.sortOrder >= 0) note.sortOrder = meta.sortOrder
          if (meta.partial === true) note.partial = true
          note.scheduledDate = validDate(meta.scheduledDate) ? meta.scheduledDate : undefined
          note.completed = meta.completed === true
          note.completedAt = note.completed && typeof meta.completedAt === 'string' ? meta.completedAt : undefined
          if (meta.scheduledDate !== undefined && !validDate(meta.scheduledDate)) this.errors.push(`${file} 的日期无效，已按创建日期显示`)
          if (old && old.hash !== note.hash && kind === 'memory' && aux.savedHash !== note.hash) note.userEdited = true
          if (note.userEdited && !aux.userEdited) atomic(auxFile, JSON.stringify({ ...aux, userEdited: true }))
          next.set(id, note)
        } catch (e) { this.errors.push(`${file}: ${e instanceof Error ? e.message : '无法读取'}`) }
      }
    }
    // Missing externally deleted files stay recoverable. Do not infer deletion during a rename.
    for (const old of previous.values()) if (!next.has(old.id)) {
      const file = path.join(this.root, 'local', `missing-${old.id}.json`)
      if (!existsSync(file)) atomic(file, JSON.stringify(old))
      this.errors.push(`文件缺失：${old.title}，可在 local/missing 记录中恢复`)
    }
    this.notes = next
    this.conflicts.clear()
    const pendingByNote = new Map<string, Conflict[]>()
    for (const file of walk(this.root, 'conflicts').filter(f => f.endsWith('.json'))) {
      try {
        const c: Conflict = JSON.parse(readFileSync(safePath(this.root, file), 'utf8'))
        if (c.id && c.current && c.incoming) {
          const current = next.get(c.noteId)
          const completionMerged = typeof c.currentRaw === 'string' && typeof c.incomingRaw === 'string' ? mergeCompletionTimeOnly(c.currentRaw, c.incomingRaw) : undefined
          const same = c.current.hash === c.incoming.hash || (typeof c.currentRaw === 'string' && typeof c.incomingRaw === 'string' && equivalentMarkdown(c.currentRaw, c.incomingRaw)) || completionMerged !== undefined
          if (same && current?.hash === c.current.hash) {
            this.archiveConflict(c, completionMerged !== undefined ? 'completion-time' : 'equivalent')
            if (completionMerged !== undefined && completionMerged !== c.currentRaw) {
              atomic(safePath(this.root, current.path), completionMerged)
              current.hash = hash(completionMerged)
              current.completedAt = String(decode(completionMerged).metadata.completedAt)
            }
          } else pendingByNote.set(c.noteId, [...pendingByNote.get(c.noteId) || [], c])
        }
      } catch { this.errors.push('有无法读取的冲突记录') }
    }
    for (const conflicts of pendingByNote.values()) {
      conflicts.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      const latest = conflicts[0]
      for (const old of conflicts.slice(1)) this.archiveConflict(old, 'superseded')
      const current = next.get(latest.noteId)
      if (!current || current.hash === latest.current.hash) this.conflicts.set(latest.id, latest)
      else {
        this.archiveConflict(latest, 'superseded')
        const currentRaw = readFileSync(safePath(this.root, current.path), 'utf8')
        const rebased = this.makeConflict(current, latest.incoming, latest.incomingRaw ? { currentRaw, incomingRaw: latest.incomingRaw } : undefined)
        atomic(path.join(this.root, 'conflicts', `${rebased.id}.json`), JSON.stringify(rebased))
        this.conflicts.set(rebased.id, rebased)
      }
    }
    this.indexRetries = 0
    this.updateIndex()
  }
  private updateIndex() {
    if (this.closed) return
    clearTimeout(this.indexTimer)
    let began = false
    try {
      this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, text TEXT); CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED, text, tokenize="trigram");')
      this.db.exec('BEGIN IMMEDIATE')
      began = true
      this.db.exec('DELETE FROM search; DELETE FROM documents;')
      const stmt = this.db.prepare('INSERT INTO search(id,text) VALUES (?,?)')
      for (const n of this.notes.values()) stmt.run(n.id, [n.title, n.body, n.tags.join(' '), n.author, n.source, n.instruction].join('\n'))
      this.db.exec('COMMIT')
      this.errors = this.errors.filter(message => !message.startsWith('本地索引：'))
    } catch (e) {
      if (began) { try { this.db.exec('ROLLBACK') } catch { /* Keep the original failure. */ } }
      const busy = /locked|busy/i.test(e instanceof Error ? e.message : '')
      this.errors = this.errors.filter(message => !message.startsWith('本地索引：'))
      this.errors.push(busy ? '本地索引：被其他进程占用，请退出旧版或重复窗口。Markdown 已保留，当前仍可编辑和搜索。' : '本地索引：更新失败。Markdown 已保留，当前仍可编辑和搜索。')
      if (busy && this.indexRetries < 3) {
        const delay = 500 * 2 ** this.indexRetries++
        this.indexTimer = setTimeout(() => { this.updateIndex(); this.changed() }, delay)
      }
    }
  }
  get(id: string) { const note = this.notes.get(id); if (!note) throw new Error('找不到条目，请刷新'); return note }
  save(input: Partial<Note> & { kind: Kind; title: string; body: string }, expected?: string): Note {
    if (input.scheduledDate !== undefined && !validDate(input.scheduledDate)) throw new Error('无效日历日期')
    if (!(input.kind in folders) || input.body.length > 4_000_000 || input.title.length > 400) throw new Error('正文或标题超出限制')
    const id = input.id || randomUUID()
    if (!/^[\w-]{1,100}$/.test(id)) throw new Error('无效 ID')
    const old = this.notes.get(id)
    const nested = input.kind === 'memory' && id.match(/^x-(\d+)-(\d+)$/)
    const relative = old?.path || (nested ? `memories/${nested[1]}/${nested[2]}.md` : `${folders[input.kind]}/${id}.md`)
    const target = safePath(this.root, relative)
    const before = existsSync(target) ? readFileSync(target, 'utf8') : ''
    if (old && expected !== hash(before)) {
      this.refresh()
      const current = this.notes.get(id) || old
      this.addConflict(current, { ...old, ...input, id, path: relative, hash: hash(input.body), updatedAt: new Date().toISOString() } as Note)
      throw new Error('检测到外部修改，已保留双方。请在“冲突”中处理。')
    }
    const meta = before ? decode(before).metadata : {}
    const now = new Date().toISOString()
    const completed = input.completed ?? old?.completed ?? false
    const author = input.author ?? old?.author ?? meta.author
    const source = input.source ?? old?.source ?? meta.source
    const publishedAt = input.publishedAt ?? old?.publishedAt ?? meta.publishedAt
    const sortOrder = input.sortOrder ?? old?.sortOrder ?? meta.sortOrder
    const partial = input.partial ?? old?.partial ?? meta.partial
    const raw = `---\n${stringify({ ...meta, xmemeory_id: id, type: input.kind, title: input.title, tags: input.tags || old?.tags || [], createdAt: old?.createdAt || now, scheduledDate: input.scheduledDate ?? old?.scheduledDate, sortOrder, completed, completedAt: completed ? old?.completedAt || now : undefined, author, source, publishedAt, partial: partial || undefined })}---\n${input.body}`
    const eol = before.includes('\r\n') ? '\r\n' : '\n'
    const persisted = (before.startsWith('\uFEFF') ? '\uFEFF' : '') + raw.replace(/\r?\n/g, eol)
    atomic(path.join(this.root, 'local/pending.json'), JSON.stringify({ path: relative, before: hash(before), raw: persisted }))
    if (before) atomic(path.join(this.root, 'local', `previous-${id}.md`), before)
    atomic(target, persisted)
    const defined = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
    const { body: _body, hash: _hash, path: _path, ...aux } = { ...old, ...defined, id, author, source, partial }
    atomic(path.join(this.root, 'metadata', `${id}.json`), JSON.stringify({ ...aux, savedHash: hash(persisted) }))
    atomic(path.join(this.root, 'local/pending.json'), 'null')
    this.refresh(); this.changed()
    return this.get(id)
  }
  private makeConflict(current: Note, incoming: Note, originals?: { currentRaw: string; incomingRaw: string }): Conflict {
    const id = hash([current.id, current.hash, incoming.hash].sort().join(':')).slice(0, 32)
    return { id, noteId: current.id, title: current.title, current, incoming, createdAt: new Date().toISOString(), ...originals,
      ...(originals ? { currentMetadata: decode(originals.currentRaw).metadata, incomingMetadata: decode(originals.incomingRaw).metadata } : {}) }
  }
  private archiveConflict(c: Conflict, reason: string) {
    atomic(path.join(this.root, 'local', `conflict-${c.id}-${randomUUID()}.json`), JSON.stringify(c))
    atomic(path.join(this.root, 'conflicts', `${c.id}.json`), JSON.stringify({ id: c.id, noteId: c.noteId, resolved: true, reason, createdAt: new Date().toISOString() }))
    this.conflicts.delete(c.id)
  }
  addConflict(current: Note, incoming: Note, originals?: { currentRaw: string; incomingRaw: string }) {
    for (const old of [...this.conflicts.values()]) if (old.noteId === current.id) this.archiveConflict(old, 'superseded')
    const conflict = this.makeConflict(current, incoming, originals)
    atomic(path.join(this.root, 'conflicts', `${conflict.id}.json`), JSON.stringify(conflict))
    this.conflicts.set(conflict.id, conflict); this.changed()
  }
  resolve(id: string, action: 'current' | 'incoming' | 'both' | 'merge', body?: string) {
    const before = this.conflicts.get(id)
    if (!before) throw new Error('冲突已改变，请刷新')
    this.refresh()
    const c = this.conflicts.get(id)
    if (!c) { this.changed(); throw new Error('原文已有变化，比较内容已刷新，请重新确认') }
    const current = this.get(c.noteId)
    if (c.incomingRaw && (action === 'incoming' || action === 'both')) {
      const parsed = decode(c.incomingRaw)
      const id = action === 'both' ? randomUUID() : current.id
      const target = action === 'both' ? `${folders[current.kind]}/${id}.md` : current.path
      const title = String(parsed.metadata.title || c.incoming.title) + (action === 'both' ? ' · 保留副本' : '')
      atomic(path.join(this.root, 'local', `previous-${current.id}.md`), readFileSync(safePath(this.root, current.path)))
      const raw = `---\n${stringify({ ...parsed.metadata, xmemeory_id: id, type: current.kind, title })}---\n${parsed.body}`
      atomic(safePath(this.root, target), raw)
      const auxiliary = Object.fromEntries(Object.entries(c.incoming).filter(([key]) => !['body', 'hash', 'path', 'author', 'source', 'publishedAt', 'sortOrder', 'partial'].includes(key)))
      atomic(path.join(this.root, 'metadata', `${id}.json`), JSON.stringify({ ...auxiliary, id, kind: current.kind, title, savedHash: hash(raw) }))
    }
    else if (action === 'both') this.save({ ...c.incoming, id: undefined, title: `${c.incoming.title} · 保留副本` })
    else if (action === 'incoming' || action === 'merge') this.save({ ...current,
      ...(current.kind === 'topic' && action === 'incoming' ? { title: c.incoming.title, completed: c.incoming.completed } : {}),
      body: action === 'merge' ? body ?? current.body : c.incoming.body }, current.hash)
    for (const active of [...this.conflicts.values()]) if (active.noteId === c.noteId) this.archiveConflict(active, 'resolved')
    this.refresh(); this.changed()
  }
  remove(id: string, restore = false) {
    const n = this.get(id)
    const file = path.join(this.root, 'tombstones', `${id}.json`)
    atomic(file, JSON.stringify({ id, deleted: !restore, time: new Date().toISOString() }))
    n.deleted = !restore
    this.changed()
  }
  search(q: SearchQuery): SearchHit[] {
    const terms = [...(q.query || '').normalize('NFKC').toLocaleLowerCase().matchAll(/"([^"]+)"|(\S+)/g)].map(m => m[1] || m[2])
    const hits: SearchHit[] = []
    for (const n of this.notes.values()) {
      if (!!n.deleted !== !!q.deleted || (q.kind && n.kind !== q.kind) || (q.tag && !n.tags.includes(q.tag)) || (q.author && !n.author?.includes(q.author)) || (q.from && n.updatedAt.slice(0, 10) < q.from) || (q.to && n.updatedAt.slice(0, 10) > q.to)) continue
      const text = [n.title, n.body, n.tags.join(' '), n.author, n.source, n.instruction].join('\n').normalize('NFKC').toLocaleLowerCase()
      if (!terms.every(t => text.includes(t))) continue
      const score = terms.reduce((s, t) => s + (n.title.toLocaleLowerCase().includes(t) ? 4 : 1), 0)
      const pos = terms.length ? Math.max(0, n.body.toLocaleLowerCase().indexOf(terms[0])) : 0
      hits.push({ ...n, score, snippet: n.body.slice(Math.max(0, pos - 45), pos + 160) })
    }
    return hits.sort((a, b) => (q.sort !== 'date' ? b.score - a.score : 0) || b.updatedAt.localeCompare(a.updatedAt))
  }
  addImage(bytes: Buffer, name: string) {
    if (bytes.length > 20 * 1024 * 1024) throw new Error('图片超过 20 MiB，请缩小后导入')
    const ext = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png' : bytes[0] === 255 && bytes[1] === 216 ? 'jpg' : bytes.subarray(0, 6).toString().startsWith('GIF8') ? 'gif' : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'webp' : ''
    if (!ext) throw new Error(`${name}: 仅支持 PNG、JPEG、GIF、WebP 图片`)
    const relative = `assets/${hash(bytes)}.${ext}`
    if (!existsSync(path.join(this.root, relative))) atomic(path.join(this.root, relative), bytes)
    return relative
  }
  export(id: string, destination: string) {
    const note = this.get(id)
    const target = path.join(destination, `XMemeory-${id}-${Date.now()}`)
    const original = safePath(this.root, note.path)
    const files = new Set([note.path])
    for (const reference of referencedImages(decode(readFileSync(original, 'utf8')).body)) {
      let relative: string
      try { relative = decodeURIComponent(reference) } catch { throw new Error('图片路径编码无效，未导出') }
      if (!/\.(png|jpe?g|gif|webp)$/i.test(relative)) continue
      relative = relative.startsWith('assets/') ? relative : path.join(path.dirname(note.path), relative)
      const image = safePath(this.root, relative)
      if (!existsSync(image) || !lstatSync(image).isFile()) throw new Error(`引用图片缺失：${reference}`)
      files.add(path.relative(this.root, image))
    }
    mkdirSync(target, { recursive: true })
    for (const file of files) {
      const out = safePath(target, file)
      mkdirSync(path.dirname(out), { recursive: true })
      copyFileSync(safePath(this.root, file), out)
    }
    return target
  }
}
