import path from 'node:path'

/**
 * Library layout v2 (Obsidian compatible). The library root opens directly as an Obsidian vault:
 * notes stay in readable folders, images in `attachments/`, and everything the app needs privately
 * lives under the dot folder `.xmemeory/`, which Obsidian neither shows nor indexes.
 */
export const SCHEMA_VERSION = 2
export const PRIVATE = '.xmemeory'
export const ATTACHMENTS = 'attachments'
export const LEGACY_ASSETS = 'assets'
/** Deleted notes move here under their original relative path; the tombstone stays the sync signal. */
export const TRASH = `${PRIVATE}/trash`

/** Absolute path inside the private folder, e.g. `privatePath(root, 'local', 'index.sqlite')`. */
export const privatePath = (root: string, ...parts: string[]) => path.join(root, PRIVATE, ...parts)

/** A note's path as synced and linked: trashed files keep the path they had before deletion. */
export const logicalPath = (file: string) => file.startsWith(`${TRASH}/`) ? file.slice(TRASH.length + 1) : file
export const trashPath = (file: string) => `${TRASH}/${logicalPath(file)}`
export const isTrashed = (file: string) => file.startsWith(`${TRASH}/`)

const MAX_NAME = 120
/** Keep characters that are valid on Windows/macOS, safe in Obsidian links and accepted by sync. */
export function safeName(value: string) {
  return value.normalize('NFC').replace(/[^\w\u0080-\uFFFF .()+-]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '')
}
/** Cut by code points so a surrogate pair is never split. */
const cut = (value: string, length: number) => [...value].slice(0, length).join('').trim()

/** Date for a memory's name: publish time when valid, otherwise when it was saved. Read in UTC so every device derives the same name. */
function memoryDate(publishedAt?: string, createdAt?: string) {
  for (const value of [publishedAt, createdAt]) {
    const time = value ? Date.parse(value) : NaN
    if (!Number.isNaN(time)) return new Date(time)
  }
  return new Date()
}
/** `memories/YYYY/YYYY-MM-DD 作者 - 标题.md`; `suffix` disambiguates two memories that would get the same name. */
export function memoryPath(input: { publishedAt?: string; createdAt?: string; author?: string; title?: string }, suffix = '') {
  const date = memoryDate(input.publishedAt, input.createdAt)
  const day = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
  const author = cut(safeName(input.author || '') || 'X', 30)
  const extra = suffix ? ` (${safeName(suffix)})` : ''
  const title = cut(safeName((input.title || '').replace(/\s+/g, ' ')) || '无标题', 40)
  let name = `${day} ${author} - ${title}`
  const room = MAX_NAME - extra.length
  if ([...name].length > room) name = cut(name, room)
  return `memories/${date.getUTCFullYear()}/${name}${extra}.md`
}
/** Suffix candidates for a name collision: tweet ID first, then the full note ID. */
export function collisionSuffixes(id: string) {
  const tweet = id.match(/(\d+)$/)?.[1]
  return [...new Set([tweet, id].filter((value): value is string => !!value))]
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i
/** Resolve an image reference written in `notePath` to a library-relative path (legacy rule: `assets/` is root-relative). */
export function resolveImage(reference: string, notePath: string) {
  let target = reference
  try { target = decodeURIComponent(reference) } catch { /* Keep the raw reference. */ }
  if (target.startsWith(`${LEGACY_ASSETS}/`) || target.startsWith(`${ATTACHMENTS}/`)) return path.posix.normalize(target)
  return path.posix.normalize(path.posix.join(path.posix.dirname(logicalPath(notePath)), target))
}
/** Reference to write in `notePath` for an attachment such as `attachments/x.png`. */
export const relativeImage = (attachment: string, notePath: string) => path.posix.relative(path.posix.dirname(logicalPath(notePath)), attachment)

/**
 * Rewrite image references that point into `assets/` so they point at `attachments/` from `newPath`.
 * Markdown images become note-relative paths; `![[...]]` embeds use the vault path, which Obsidian resolves.
 * Code spans and fenced code are left untouched.
 */
export function rewriteImageRefs(body: string, oldPath: string, newPath: string) {
  const moved = (reference: string) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference) || !IMAGE.test(reference.split(/[?#]/)[0])) return undefined
    const resolved = resolveImage(reference, oldPath)
    if (!resolved.startsWith(`${LEGACY_ASSETS}/`)) return undefined
    return `${ATTACHMENTS}/${resolved.slice(LEGACY_ASSETS.length + 1)}`
  }
  return body.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, index) => index % 2 ? part : part
    .replace(/(!\[[^\]\n]*\]\()(<[^>\n]+>|[^)\s]+)((?:\s+"[^"\n]*")?\))/g, (whole, open: string, target: string, close: string) => {
      const bare = target.startsWith('<') ? target.slice(1, -1) : target
      const next = moved(bare)
      if (!next) return whole
      const relative = relativeImage(next, newPath)
      return `${open}${target.startsWith('<') || /\s/.test(relative) ? `<${relative}>` : relative}${close}`
    })
    .replace(/(!\[\[)([^\]|\n]+)((?:\|[^\]\n]*)?\]\])/g, (whole, open: string, target: string, close: string) => {
      const next = moved(target)
      return next ? `${open}${next}${close}` : whole
    })
  ).join('')
}
