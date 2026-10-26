import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Note, PartialRetryInfo } from '../shared/types'
import { atomic, hash } from './library'
import { articleDomMarkdown, normalizePostUrl, replaceCapturedImages, type ArticleDomBlock } from './x-parse'

export const PARTIAL_RETRY_DAILY = 3
export const PARTIAL_RETRY_GAP_MS = 6 * 60 * 60_000
export const PARTIAL_RETRY_MAX_ATTEMPTS = 3

type Entry = { attempts: number; lastAttemptAt?: string; result?: 'incomplete' | 'error' | 'review'; reason?: string }
type RetryState = { day: string; used: number; entries: Record<string, Entry> }
type CaptureMetadata = Record<string, unknown>

const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const reasonText: Record<string, string> = {
  'content-state-missing': 'X 未提供完整长文结构',
  'article-navigation-failed': '长文页面无法打开',
  'article-not-at-bottom': '未能核验长文末尾',
  'article-content-unstable': '长文内容尚未稳定',
  'network': '网络连接失败',
  'login': 'X 登录已失效',
  'rate-limit': 'X 限流中',
  'incomplete': '重新采集后正文仍不完整',
  'capture-error': '本次采集失败',
  'review': '原文可能被编辑，需手动对照'
}

export function capturedSource(body: string) {
  const normalized = body.replace(/\r\n/g, '\n')
  const headings = [...normalized.matchAll(/^# 我的笔记[ \t]*$/gm)]
  if (headings.length !== 1 || !normalized.startsWith('# X 原文\n')) return
  const index = headings[0].index
  return { source: normalized.slice(0, index).trimEnd(), notes: normalized.slice(index) }
}

export function sourceHash(body: string) {
  const section = capturedSource(body)
  return section ? hash(section.source) : undefined
}

export function mergeCapturedSource(existing: string, incoming: string, expectedHash: string) {
  const before = capturedSource(existing), after = capturedSource(incoming)
  if (!before || !after || hash(before.source) !== expectedHash) return
  return `${after.source}\n\n${before.notes}`
}

function readCapture(root: string, id: string): CaptureMetadata | undefined {
  if (!/^[\w-]{1,100}$/.test(id)) return
  try {
    const file = path.join(root, 'metadata', `${id}.capture.json`)
    if (!existsSync(file)) return
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch { return undefined }
}

// Older captures predate sourceHash. Rebuild their generated source exactly; a mismatch is never auto-overwritten.
export function legacySourceHash(meta: CaptureMetadata): string | undefined {
  const { source, text, links, images, localImages, article, videoCover, contentStatus, partialReasons } = meta
  if (typeof source !== 'string' || typeof text !== 'string' || !Array.isArray(links) || !Array.isArray(images)) return
  if (!links.every(link => typeof link === 'string') || !images.every(image => typeof image === 'string')) return
  if (contentStatus !== 'partial' && contentStatus !== 'complete') return
  let body: string
  const articleData = article && typeof article === 'object' ? article as Record<string, unknown> : undefined
  if (Array.isArray(articleData?.blocks)) {
    const title = typeof articleData.title === 'string' ? articleData.title : ''
    const markdown = articleDomMarkdown(title, articleData.blocks as ArticleDomBlock[])
    body = ['# X 原文', markdown, contentStatus === 'partial' ? '> 正文尚未通过页面底部与稳定性核验，需要人工检查。' : '', `[原文](${source})`, '# 我的笔记', ''].filter(Boolean).join('\n\n')
  } else {
    const missing = Array.isArray(partialReasons) && partialReasons.includes('article-navigation-failed')
    body = [
      '# X 原文', text, ...links.filter(link => !text.includes(link)).map(link => `<${link}>`),
      ...(articleData?.contentState ? [] : images.map((image, index) => `![X 图片 ${index + 1}](${image})`)),
      videoCover === true ? '> 视频未下载，仅保留封面和原文链接。' : '',
      contentStatus === 'partial' ? '> 正文可能不完整，尚未取得可核验的完整结构。' : '',
      `[原文](${source})`, '# 我的笔记', ''
    ].filter(Boolean).join('\n\n')
    if (missing && !body.includes('正文可能不完整')) body = body.replace('# 我的笔记', '> 正文可能不完整，尚未取得可核验的完整结构。\n\n# 我的笔记')
  }
  const replacements = localImages && typeof localImages === 'object' && !Array.isArray(localImages)
    ? Object.fromEntries(Object.entries(localImages).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}
  return sourceHash(replaceCapturedImages(body, replacements))
}

function readState(file: string, today: string): RetryState {
  if (!existsSync(file)) return { day: today, used: 0, entries: {} }
  try {
    if (statSync(file).size > 256 * 1024) throw new Error('Oversized retry state')
    const data = JSON.parse(readFileSync(file, 'utf8')) as RetryState
    if (typeof data?.day !== 'string' || !Number.isInteger(data.used) || data.used < 0 || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) throw new Error('Invalid retry state')
    for (const [id, entry] of Object.entries(data.entries)) {
      if (!/^(?:[a-f0-9]{16}:)?x-[\w-]{1,80}-\d+$/.test(id) || !entry || typeof entry !== 'object' || !Number.isInteger(entry.attempts) || entry.attempts < 0 || entry.attempts > PARTIAL_RETRY_MAX_ATTEMPTS || (entry.lastAttemptAt !== undefined && (typeof entry.lastAttemptAt !== 'string' || !Number.isFinite(Date.parse(entry.lastAttemptAt))))) throw new Error('Invalid retry entry')
    }
    return data
  } catch {
    // Do not reset an unknown daily budget to zero and issue extra unattended requests.
    return { day: today, used: PARTIAL_RETRY_DAILY, entries: {} }
  }
}

export class PartialRetries {
  private file: string
  private state: RetryState
  private prefix: string

  constructor(private root: string, now = new Date(), deviceData?: string) {
    this.file = deviceData ? path.join(deviceData, 'partial-retries.json') : path.join(root, 'local', 'partial-retries.json')
    this.prefix = deviceData ? `${hash(path.resolve(root)).slice(0, 16)}:` : ''
    this.state = readState(this.file, dayKey(now))
  }

  private key(id: string) { return this.prefix + id }
  private persist() { atomic(this.file, JSON.stringify(this.state)) }
  private rollover(now: Date) {
    const today = dayKey(now)
    if (this.state.day !== today) { this.state.day = today; this.state.used = 0; this.persist() }
  }

  info(notes: Iterable<Note>): Record<string, PartialRetryInfo> {
    const result: Record<string, PartialRetryInfo> = {}
    for (const note of notes) {
      if (note.kind !== 'memory' || note.deleted || note.partial !== true) continue
      const stored = this.state.entries[this.key(note.id)]
      const meta = readCapture(this.root, note.id)
      const captureReason = Array.isArray(meta?.partialReasons) ? meta.partialReasons.find(value => typeof value === 'string' && value in reasonText) : undefined
      const reason = stored?.result === 'review' || stored?.result === 'error' ? stored.reason : captureReason || stored?.reason
      const attempts = Number.isInteger(stored?.attempts) ? stored.attempts : 0
      const nextAt = stored?.lastAttemptAt && attempts < PARTIAL_RETRY_MAX_ATTEMPTS && stored.result !== 'review'
        ? new Date(Date.parse(stored.lastAttemptAt) + PARTIAL_RETRY_GAP_MS).toISOString() : undefined
      result[note.id] = { attempts, lastAttemptAt: stored?.lastAttemptAt, result: stored?.result, reason: typeof reason === 'string' ? reasonText[reason] : undefined, nextAt }
    }
    return result
  }

  select(notes: Iterable<Note>, account: string, now: Date) {
    this.rollover(now)
    if (this.state.used >= PARTIAL_RETRY_DAILY) return
    for (const note of notes) {
      if (note.kind !== 'memory' || !note.partial || note.deleted || !note.source) continue
      const match = note.id.match(/^x-([\w-]+)-(\d+)$/)
      if (!match || match[1] !== account || normalizePostUrl(note.source)?.id !== match[2]) continue
      const stored = this.state.entries[this.key(note.id)]
      if (stored?.result === 'review' || (stored?.attempts || 0) >= PARTIAL_RETRY_MAX_ATTEMPTS) continue
      if (stored?.lastAttemptAt && now.getTime() - Date.parse(stored.lastAttemptAt) < PARTIAL_RETRY_GAP_MS) continue
      const meta = readCapture(this.root, note.id)
      const expected = typeof meta?.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(meta.sourceHash) ? meta.sourceHash : meta ? legacySourceHash(meta) : undefined
      if (!expected || sourceHash(note.body) !== expected) {
        this.state.entries[this.key(note.id)] = { ...stored, attempts: stored?.attempts || 0, result: 'review', reason: 'review' }
        this.persist()
        continue
      }
      return { note, expected }
    }
  }

  begin(id: string, now: Date) {
    this.rollover(now)
    const key = this.key(id)
    const entry = this.state.entries[key] || { attempts: 0 }
    this.state.used++
    this.state.entries[key] = { attempts: entry.attempts + 1, lastAttemptAt: now.toISOString() }
    this.persist()
  }

  finish(id: string, result: 'complete' | 'incomplete' | 'error' | 'review', reason?: string) {
    const key = this.key(id)
    if (result === 'complete') delete this.state.entries[key]
    else {
      const previous = this.state.entries[key] || { attempts: 0 }
      this.state.entries[key] = { ...previous, result, reason: reason && reason in reasonText ? reason : result === 'review' ? 'review' : result === 'incomplete' ? 'incomplete' : 'capture-error' }
    }
    this.persist()
  }
}
