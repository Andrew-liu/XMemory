import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statfsSync } from 'node:fs'
import path from 'node:path'
import { stringify } from 'yaml'
import { atomic, decode, ensureObsidianConfig, folders, hash, safePath, walk } from './library'
import { ATTACHMENTS, LEGACY_ASSETS, PRIVATE, SCHEMA_VERSION, collisionSuffixes, memoryPath, privatePath, relativeImage, resolveImage, rewriteImageRefs } from './layout'
import { legacySourceHash, sourceHash } from './partial-retry'
import { referencedImages } from './export-images'

/** Files that v1 (schemaVersion 1) libraries synced; also the input of the v1 -> v2 migration. */
export function syncAllowedV1(file: string) {
  return file === 'manifest.json' || /^(inspirations|memories|drafts|topics)\/[\w\u0080-\uFFFF .()/+-]+\.md$/.test(file) || /^(metadata|tombstones|conflicts)\/[\w-]+\.json$/.test(file) || /^metadata\/[\w-]+\.capture\.json$/.test(file) || /^assets\/[\w .()-]+\.(png|jpg|jpeg|webp|gif)$/i.test(file)
}

const PRIVATE_FOLDERS = ['metadata', 'tombstones', 'conflicts']
const noteFolder = (file: string) => Object.values(folders).some(folder => file.startsWith(`${folder}/`)) && file.endsWith('.md')

export interface MigratedFiles {
  /** v2 path -> content. */
  files: Map<string, Buffer>
  /** v1 path -> v2 path, for every input file that has an output. */
  paths: Map<string, string>
}

/** Rewrite one note's Front Matter to Obsidian-style fields and its image links to attachments/. */
function migrateNote(raw: string, oldPath: string, newPath: string) {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : ''
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const hasFrontMatter = /^\uFEFF?---\r?\n/.test(raw)
  const { metadata, body } = decode(raw)
  const nextBody = rewriteImageRefs(body, oldPath, newPath)
  if (!hasFrontMatter) return nextBody
  const { createdAt, publishedAt, ...rest } = metadata as Record<string, unknown>
  const title = typeof rest.title === 'string' ? rest.title : ''
  const aliases = [...new Set([title, ...(Array.isArray(rest.aliases) ? rest.aliases.map(String) : [])])].filter(Boolean)
  const meta = { ...rest, aliases: aliases.length ? aliases : undefined, created: rest.created ?? createdAt, published: rest.published ?? publishedAt }
  return bom + `---\n${stringify(meta)}---\n`.replace(/\n/g, eol) + nextBody
}

/**
 * Pure v1 -> v2 transformation of a library's synced files. Deterministic for the same input, so two devices
 * migrating the same content produce the same files. `preferred` pins note IDs to paths already chosen elsewhere.
 */
export function migrateFiles(input: Map<string, Buffer>, preferred = new Map<string, string>()): MigratedFiles {
  const files = new Map<string, Buffer>(), paths = new Map<string, string>()
  const notes: { file: string; raw: string; id?: string; meta: Record<string, unknown> }[] = []
  for (const [file, content] of input) {
    if (!noteFolder(file)) continue
    const raw = content.toString('utf8')
    let meta: Record<string, unknown> = {}
    try { meta = decode(raw).metadata } catch { /* Unparseable Front Matter keeps its path and content. */ }
    notes.push({ file, raw, id: typeof meta.xmemeory_id === 'string' ? meta.xmemeory_id : undefined, meta })
  }
  // Fixed order so collision suffixes do not depend on directory listing order.
  notes.sort((a, b) => (a.id || a.file).localeCompare(b.id || b.file))
  const used = new Set<string>()
  const claim = (file: string) => { used.add(file.toLocaleLowerCase()); return file }
  for (const note of notes) if (!note.file.startsWith('memories/') || !note.id || preferred.has(note.id)) claim(note.id && preferred.get(note.id) || note.file)
  const bodies = new Map<string, { oldPath: string; newPath: string; oldBody: string; newBody: string; oldRaw: string; newRaw: string }>()
  for (const note of notes) {
    let target = note.id && preferred.get(note.id) || note.file
    if (note.file.startsWith('memories/') && note.id && !preferred.has(note.id)) {
      const info = { publishedAt: note.meta.publishedAt as string | undefined, createdAt: note.meta.createdAt as string | undefined, author: note.meta.author as string | undefined, title: note.meta.title as string | undefined }
      target = ['', ...collisionSuffixes(note.id)].map(suffix => memoryPath(info, suffix)).find(file => !used.has(file.toLocaleLowerCase())) || memoryPath(info, note.id)
      claim(target)
    }
    let next = note.raw
    try { next = migrateNote(note.raw, note.file, target) } catch { /* Keep content; the path still moves. */ }
    files.set(target, Buffer.from(next, 'utf8'))
    paths.set(note.file, target)
    if (note.id) {
      let oldBody = note.raw, newBody = next
      try { oldBody = decode(note.raw).body; newBody = decode(next).body } catch { /* Raw text stands in for the body. */ }
      bodies.set(note.id, { oldPath: note.file, newPath: target, oldBody, newBody, oldRaw: note.raw, newRaw: next })
    }
  }
  for (const [file, content] of input) {
    if (noteFolder(file)) continue
    if (file === 'manifest.json') {
      let manifest: Record<string, unknown> = {}
      try { manifest = JSON.parse(content.toString('utf8')) } catch { /* Rewritten below. */ }
      const next = Buffer.from(JSON.stringify({ ...manifest, schemaVersion: SCHEMA_VERSION, application: 'XMemeory' }))
      files.set(file, next); paths.set(file, file); continue
    }
    if (file.startsWith(`${LEGACY_ASSETS}/`)) {
      const target = `${ATTACHMENTS}/${file.slice(LEGACY_ASSETS.length + 1)}`
      files.set(target, content); paths.set(file, target); continue
    }
    const folder = file.split('/')[0]
    if (!PRIVATE_FOLDERS.includes(folder)) continue
    const target = `${PRIVATE}/${file}`
    let next = content
    try {
      const value = JSON.parse(content.toString('utf8'))
      const id = path.posix.basename(file).replace(/(\.capture)?\.json$/, '')
      const note = bodies.get(id)
      if (folder === 'metadata' && note && value && typeof value === 'object') {
        if (file.endsWith('.capture.json')) {
          // Keep the "source unchanged since capture" proof valid after image links moved to attachments/.
          const unchanged = typeof value.sourceHash === 'string' ? value.sourceHash === sourceHash(note.oldBody) : legacySourceHash(value) !== undefined && legacySourceHash(value) === sourceHash(note.oldBody)
          if (value.localImages && typeof value.localImages === 'object') {
            for (const [url, local] of Object.entries(value.localImages)) {
              if (typeof local !== 'string') continue
              const resolved = resolveImage(local, note.oldPath)
              if (resolved.startsWith(`${LEGACY_ASSETS}/`)) value.localImages[url] = relativeImage(`${ATTACHMENTS}/${resolved.slice(LEGACY_ASSETS.length + 1)}`, note.newPath)
            }
          }
          if (unchanged) value.sourceHash = sourceHash(note.newBody)
        } else if (value.savedHash === hash(note.oldRaw)) value.savedHash = hash(note.newRaw)
        next = Buffer.from(JSON.stringify(value))
      }
      if (folder === 'conflicts' && value && typeof value === 'object') {
        for (const side of ['current', 'incoming']) if (value[side] && typeof value[side].path === 'string') value[side].path = paths.get(value[side].path) || value[side].path
        next = Buffer.from(JSON.stringify(value))
      }
    } catch { /* Unreadable JSON moves unchanged. */ }
    files.set(target, next); paths.set(file, target)
  }
  return { files, paths }
}

/** Bytes needed for a copy of the library, excluding rebuildable caches and earlier backups. */
function librarySize(root: string) {
  let total = 0
  const visit = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name)
      if (item.isSymbolicLink() || skipInBackup(root, file)) continue
      if (item.isDirectory()) visit(file); else total += lstatSync(file).size
    }
  }
  visit(root)
  return total
}
function skipInBackup(root: string, file: string) {
  const rel = path.relative(root, file).replaceAll('\\', '/')
  return rel.startsWith('.') || rel === 'local/sync-cache' || rel.startsWith('local/sync-cache/') || /^local\/index\.sqlite/.test(rel)
}

/** Put a library back exactly as the backup holds it. Hidden folders (.obsidian, .git, backups) are left alone. */
export function restoreBackup(root: string, backup: string) {
  if (!existsSync(path.join(backup, 'manifest.json'))) throw new Error(`备份不完整，未自动恢复：${backup}`)
  for (const item of readdirSync(root)) if (!item.startsWith('.')) rmSync(path.join(root, item), { recursive: true, force: true })
  for (const item of existsSync(path.join(root, PRIVATE)) ? readdirSync(path.join(root, PRIVATE)) : []) {
    if (!item.startsWith('backup-')) rmSync(path.join(root, PRIVATE, item), { recursive: true, force: true })
  }
  for (const item of readdirSync(backup)) cpSync(path.join(backup, item), path.join(root, item), { recursive: true })
}

function removeEmptyDirs(dir: string) {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return
  for (const item of readdirSync(dir)) { const child = path.join(dir, item); if (lstatSync(child).isDirectory()) removeEmptyDirs(child) }
  if (!readdirSync(dir).length) rmdirSync(dir)
}

/** Same rule as Library.recover(): finish or set aside a save that a crash interrupted, before files move. */
function applyPendingSave(root: string) {
  const file = path.join(root, 'local/pending.json')
  if (!existsSync(file)) return
  const pending = JSON.parse(readFileSync(file, 'utf8'))
  if (pending && typeof pending.path === 'string' && typeof pending.raw === 'string') {
    const target = safePath(root, pending.path)
    const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
    if (hash(current) === pending.before || hash(current) === hash(pending.raw)) atomic(target, pending.raw)
    else atomic(path.join(root, 'local', `recovery-${randomUUID()}.md`), pending.raw)
  }
  atomic(file, 'null')
}

export interface MigrationResult { backup: string; notes: number }
type Fault = 'after-write' | 'verify'

/**
 * Upgrade a schemaVersion 1 library on disk to v2. Returns undefined when no upgrade is needed.
 * Order: backup -> write v2 files -> remove v1 files -> verify -> manifest v2 (commit point).
 * An interrupted run is detected by `.xmemeory/migration.json` and restarted from its backup.
 * `fault` exists only for tests to simulate a crash or a failed check.
 */
export function migrateLibrary(root: string, now = new Date(), fault?: Fault): MigrationResult | undefined {
  const manifestFile = path.join(root, 'manifest.json')
  const progressFile = privatePath(root, 'migration.json')
  if (!existsSync(manifestFile)) return
  const version = JSON.parse(readFileSync(manifestFile, 'utf8')).schemaVersion
  let backup = ''
  if (existsSync(progressFile)) {
    const progress = JSON.parse(readFileSync(progressFile, 'utf8'))
    if (version === SCHEMA_VERSION) { rmSync(progressFile, { force: true }); return }
    // A previous run was interrupted: return to the untouched v1 state and redo it from the same backup.
    restoreBackup(root, progress.backup)
    backup = progress.backup
  } else if (version === SCHEMA_VERSION) return
  if (JSON.parse(readFileSync(manifestFile, 'utf8')).schemaVersion !== 1) throw new Error('资料库版本不兼容，已停止写入')

  if (!backup) {
    const needed = librarySize(root) * 2 + 64 * 1024 * 1024
    const disk = statfsSync(root)
    if (disk.bavail * disk.bsize < needed) throw new Error(`磁盘空间不足，资料库升级需要约 ${Math.ceil(needed / 1024 / 1024)} MiB，未做任何修改`)
    backup = privatePath(root, `backup-${now.toISOString().replace(/[:.]/g, '-')}`)
    mkdirSync(backup, { recursive: true })
    for (const item of readdirSync(root)) {
      if (item.startsWith('.')) continue
      cpSync(path.join(root, item), path.join(backup, item), { recursive: true, filter: source => !skipInBackup(root, source) })
    }
  }
  atomic(progressFile, JSON.stringify({ from: 1, to: SCHEMA_VERSION, backup, startedAt: now.toISOString() }))
  try {
    applyPendingSave(root)
    const input = new Map<string, Buffer>()
    for (const file of walk(root)) {
      if (file === 'manifest.json' || noteFolder(file) || file.startsWith(`${LEGACY_ASSETS}/`) || PRIVATE_FOLDERS.includes(file.split('/')[0])) input.set(file, readFileSync(safePath(root, file)))
    }
    const { files, paths } = migrateFiles(input)
    for (const [file, content] of files) if (file !== 'manifest.json') atomic(safePath(root, file), content)
    if (fault === 'after-write') throw Object.assign(new Error('模拟中断'), { simulatedCrash: true })
    for (const file of input.keys()) if (file !== 'manifest.json' && !files.has(file)) rmSync(safePath(root, file), { force: true })
    for (const folder of [LEGACY_ASSETS, ...PRIVATE_FOLDERS, ...Object.values(folders)]) removeEmptyDirs(path.join(root, folder))
    for (const folder of Object.values(folders)) mkdirSync(path.join(root, folder), { recursive: true })
    if (existsSync(path.join(root, 'local'))) {
      if (existsSync(privatePath(root, 'local'))) throw new Error('.xmemeory/local 已存在，未覆盖')
      renameSync(path.join(root, 'local'), privatePath(root, 'local'))
    }
    // Carry each sync baseline over to the new paths, so the next sync compares real changes, not the migration.
    const localDir = privatePath(root, 'local')
    for (const name of existsSync(localDir) ? readdirSync(localDir).filter(n => /^sync-[\w-]+\.json$/.test(n)) : []) {
      const state = JSON.parse(readFileSync(path.join(localDir, name), 'utf8'))
      if (!state || typeof state.hashes !== 'object') continue
      const hashes: Record<string, string> = {}
      for (const [file, digest] of Object.entries(state.hashes as Record<string, string>)) {
        const target = paths.get(file), before = input.get(file)
        if (target && before && hash(before) === digest) hashes[target] = hash(files.get(target)!)
      }
      atomic(path.join(localDir, name), JSON.stringify({ ...state, hashes, legacyHashes: state.legacyHashes || state.hashes }))
    }
    // Verify: every v2 file written as computed, every v1 note accounted for, every image that resolved still resolves.
    if (fault === 'verify') throw new Error('模拟校验失败')
    for (const [file, content] of files) if (file !== 'manifest.json' && !readFileSync(safePath(root, file)).equals(content)) throw new Error(`升级校验失败：${file} 内容不一致`)
    const oldNotes = [...input.keys()].filter(noteFolder), newNotes = [...files.keys()].filter(noteFolder)
    if (oldNotes.length !== newNotes.length) throw new Error(`升级校验失败：笔记数量 ${oldNotes.length} → ${newNotes.length}`)
    for (const oldPath of oldNotes) {
      const newPath = paths.get(oldPath)!
      let oldBody: string, newBody: string
      try { oldBody = decode(input.get(oldPath)!.toString('utf8')).body; newBody = decode(files.get(newPath)!.toString('utf8')).body } catch { continue }
      const before = referencedImages(oldBody).map(ref => resolveImage(ref, oldPath)).filter(file => input.has(file))
      const after = new Set(referencedImages(newBody).map(ref => resolveImage(ref, newPath)))
      for (const image of before) {
        const moved = image.startsWith(`${LEGACY_ASSETS}/`) ? `${ATTACHMENTS}/${image.slice(LEGACY_ASSETS.length + 1)}` : image
        if (!after.has(moved) || !existsSync(path.join(root, moved))) throw new Error(`升级校验失败：${newPath} 的图片 ${moved} 无法找到`)
      }
    }
    ensureObsidianConfig(root)
    atomic(manifestFile, files.get('manifest.json')!)
    rmSync(progressFile, { force: true })
    return { backup, notes: newNotes.length }
  } catch (error) {
    if ((error as { simulatedCrash?: boolean }).simulatedCrash) throw error
    restoreBackup(root, backup)
    rmSync(progressFile, { force: true })
    throw new Error(`资料库升级失败，已从备份恢复原状（备份：${backup}）：${error instanceof Error ? error.message : '未知错误'}`)
  }
}
