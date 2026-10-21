import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { atomic } from './library'
import { bookmarkEntries, captureFromPayload } from './x-parse'
import type { BookmarkGuardInfo, BookmarkRunResult } from '../shared/types'

export const DAILY_NEW = 200
export const DAILY_ARTICLES = 50
export const RUN_MS = 30 * 60_000
export const COOLDOWN_429_MS = 2 * 60 * 60_000
const KNOWN_STREAK_STOP = 20
const IDLE_ROUNDS_BOTTOM = 8
const ERROR_RESPONSES_BREAKER = 3
const CONSECUTIVE_FAILURES_BREAKER = 3
const BATCH_PAUSE_EVERY = 30

type Json = Record<string, any>
export interface GuardState {
  day: string
  newToday: number
  articlesToday: number
  historyComplete: boolean
  lastRunAt?: string
  lastStopReason?: string
  breaker?: { reason: string; at: string; until?: string }
}
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
function readGuardState(file: string): GuardState {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw && typeof raw === 'object') {
      const breaker = raw.breaker && typeof raw.breaker === 'object' && typeof raw.breaker.reason === 'string' && typeof raw.breaker.at === 'string'
        ? { reason: raw.breaker.reason, at: raw.breaker.at, until: typeof raw.breaker.until === 'string' ? raw.breaker.until : undefined }
        : undefined
      return {
        day: typeof raw.day === 'string' ? raw.day : dayKey(new Date()),
        newToday: Number.isInteger(raw.newToday) && raw.newToday >= 0 ? raw.newToday : 0,
        articlesToday: Number.isInteger(raw.articlesToday) && raw.articlesToday >= 0 ? raw.articlesToday : 0,
        historyComplete: raw.historyComplete === true,
        lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : undefined,
        lastStopReason: typeof raw.lastStopReason === 'string' ? raw.lastStopReason : undefined,
        breaker
      }
    }
  } catch { /* Missing or corrupt file falls back to defaults. */ }
  return { day: dayKey(new Date()), newToday: 0, articlesToday: 0, historyComplete: false }
}
export class RiskGuard {
  readonly file: string
  state: GuardState
  constructor(root: string, account: string) {
    this.file = path.join(root, 'local', `x-bookmarks-${/^\d+$/.test(account) ? account : 'cdp'}.json`)
    this.state = readGuardState(this.file)
  }
  static read(file: string) { return existsSync(file) ? readGuardState(file) : undefined }
  rollover(now: Date) {
    const today = dayKey(now)
    if (this.state.day !== today) {
      this.state.day = today
      this.state.newToday = 0
      this.state.articlesToday = 0
      this.save()
    }
  }
  canStart(now: Date) {
    this.rollover(now)
    const breaker = this.state.breaker
    if (breaker?.until && Date.parse(breaker.until) > now.getTime()) throw new Error(`X 限流冷却中，${new Date(breaker.until).toLocaleString('zh-CN')} 后可再试`)
    if (breaker) { this.state.breaker = undefined; this.save() }
    if (this.state.newToday >= DAILY_NEW) throw new Error(`今日书签额度已用完（${DAILY_NEW} 条），明天再试`)
  }
  setBreaker(reason: string, now: Date, until?: Date) {
    this.state.breaker = { reason, at: now.toISOString(), until: until?.toISOString() }
    this.save()
  }
  save() { atomic(this.file, JSON.stringify(this.state, null, 2)) }
}
export function bookmarkSummary(root: string): BookmarkGuardInfo {
  const dir = path.join(root, 'local')
  let state: GuardState | undefined
  let latest = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!/^x-bookmarks-[\w-]+\.json$/.test(name)) continue
      const mtime = lstatSync(path.join(dir, name)).mtimeMs
      if (mtime >= latest) { latest = mtime; state = readGuardState(path.join(dir, name)) }
    }
  } catch { /* local 目录缺失时按默认值返回 */ }
  const today = dayKey(new Date())
  const fresh = state && state.day === today ? state : state ? { ...state, newToday: 0, articlesToday: 0 } : undefined
  return {
    newToday: fresh?.newToday ?? 0,
    articlesToday: fresh?.articlesToday ?? 0,
    dailyLimit: DAILY_NEW,
    articleLimit: DAILY_ARTICLES,
    historyComplete: fresh?.historyComplete ?? false,
    lastRunAt: fresh?.lastRunAt,
    lastStopReason: fresh?.lastStopReason,
    breaker: fresh?.breaker
  }
}
export interface ScannerDeps {
  isKnown: (id: string) => boolean
  saveDirect: (tweet: Json, id: string) => Promise<'created' | 'updated' | 'unchanged'>
  collectDetail: (id: string, url: string) => Promise<'created' | 'updated' | 'unchanged'>
  scroll: () => Promise<{ moved: boolean; atEnd: boolean }>
  sleep: (ms: number) => Promise<void>
  now: () => Date
  random: () => number
  stopped: () => boolean
  progress: (p: { checked: number; created: number; skipped: number; failed: number; queued: number }) => void
}
export class BookmarkScanner {
  private queue: Json[] = []
  private seen = new Set<string>()
  private responses = 0
  private bottomSeen = false
  private idleRounds = 0
  private errorResponses = 0
  private repeatedResponses = 0
  private knownStreak = 0
  private consecutiveFailures = 0
  private pendingStop?: string
  private checked = 0
  private created = 0
  private skipped = 0
  private failed = 0
  private articlesQueued = 0
  constructor(private guard: RiskGuard, private deps: ScannerDeps) {}
  breaker(reason: string, until?: Date) {
    if (!this.pendingStop) this.pendingStop = `breaker:${reason}`
    this.guard.setBreaker(reason, this.deps.now(), until)
  }
  private errorResponse() {
    if (++this.errorResponses >= ERROR_RESPONSES_BREAKER) this.breaker('api-errors')
  }
  ingest(status: number, payload: unknown) {
    if (this.pendingStop) return
    this.responses++
    if (status === 401 || status === 403) { this.breaker('auth'); return }
    if (status === 429) { this.breaker('rate-limit', new Date(this.deps.now().getTime() + COOLDOWN_429_MS)); return }
    if (status !== 200 || payload === undefined) { this.errorResponse(); return }
    const parsed = bookmarkEntries(payload)
    if (!parsed.found) { this.breaker('schema'); return }
    if (parsed.errors.length) { this.errorResponse(); return }
    this.errorResponses = 0
    this.checked += parsed.unavailable
    let unseen = 0
    for (const tweet of parsed.tweets) {
      const id = String(tweet?.rest_id || '')
      if (!id || this.seen.has(id)) continue
      this.seen.add(id)
      this.queue.push(tweet)
      unseen++
    }
    // Cursor-only responses mean the bottom; tombstone-only responses still count as list content.
    if (!parsed.tweets.length && !parsed.unavailable) { this.bottomSeen = true; this.repeatedResponses = 0 }
    else if (parsed.tweets.length && !unseen) { if (++this.repeatedResponses >= 3) this.breaker('loop') }
    else this.repeatedResponses = 0
    this.report()
  }
  private report() {
    this.deps.progress({ checked: this.checked, created: this.created, skipped: this.skipped, failed: this.failed, queued: this.articlesQueued })
  }
  private async finish(stopReason: string): Promise<BookmarkRunResult> {
    this.guard.state.lastRunAt = this.deps.now().toISOString()
    this.guard.state.lastStopReason = stopReason
    if (stopReason === 'bottom') this.guard.state.historyComplete = true
    this.guard.save()
    this.report()
    return { checked: this.checked, created: this.created, skipped: this.skipped, failed: this.failed, articlesQueued: this.articlesQueued, stopReason }
  }
  async run(limit: number): Promise<BookmarkRunResult> {
    const startedAt = this.deps.now().getTime()
    const elapsed = () => this.deps.now().getTime() - startedAt
    let firstArticle = true
    let sincePause = 0
    const itemFailed = (error: unknown) => {
      this.failed++
      this.consecutiveFailures++
      if (error instanceof Error && /登录|验证/.test(error.message)) this.breaker('auth')
      else if (this.consecutiveFailures >= CONSECUTIVE_FAILURES_BREAKER) this.breaker('failures')
    }
    for (;;) {
      if (this.pendingStop) return this.finish(this.pendingStop)
      if (this.deps.stopped()) return this.finish('paused')
      if (elapsed() >= RUN_MS) return this.finish('time')
      const tweet = this.queue.shift()
      if (!tweet) {
        if (this.bottomSeen) return this.finish('bottom')
        if (elapsed() >= RUN_MS) return this.finish('time')
        const seenBefore = this.seen.size, responsesBefore = this.responses
        const outcome = await this.deps.scroll()
        await this.deps.sleep(1800 + this.deps.random() * 2700)
        // Only a motionless scroll at the real page end with no new data counts toward bottom;
        // scrolling through already-loaded tall cards must not.
        const noData = this.seen.size === seenBefore && this.responses === responsesBefore
        this.idleRounds = outcome.atEnd && !outcome.moved && noData ? this.idleRounds + 1 : 0
        if (this.idleRounds >= IDLE_ROUNDS_BOTTOM) return this.finish('bottom')
        continue
      }
      const id = String(tweet.rest_id)
      this.checked++
      if (this.deps.isKnown(id)) {
        this.skipped++
        this.knownStreak++
        this.report()
        if (this.guard.state.historyComplete && this.knownStreak >= KNOWN_STREAK_STOP) return this.finish('known-streak')
        continue
      }
      this.knownStreak = 0
      const captured = captureFromPayload(tweet, id)
      if (!captured) { this.skipped++; this.report(); continue }
      if (!captured.post.partial) {
        try {
          const result = await this.deps.saveDirect(tweet, id)
          if (result === 'created') { this.created++; this.guard.state.newToday++; sincePause++ }
          else this.skipped++
          this.consecutiveFailures = 0
        } catch (error) {
          if (this.deps.stopped()) return this.finish('paused')
          itemFailed(error)
          continue
        }
      } else {
        if (this.guard.state.articlesToday >= DAILY_ARTICLES) return this.finish('daily-quota')
        this.articlesQueued++
        if (!firstArticle) await this.deps.sleep(8000 + this.deps.random() * 12_000)
        firstArticle = false
        try {
          const url = captured.post.author !== 'unknown' ? captured.post.url : `https://x.com/i/web/status/${id}`
          const result = await this.deps.collectDetail(id, url)
          if (result === 'created') { this.created++; this.guard.state.newToday++; sincePause++ }
          else this.skipped++
          this.consecutiveFailures = 0
        } catch (error) {
          if (this.deps.stopped()) return this.finish('paused')
          itemFailed(error)
          this.guard.state.articlesToday++
          continue
        }
        this.guard.state.articlesToday++
      }
      this.report()
      if (this.created >= limit) return this.finish('limit')
      if (this.guard.state.newToday >= DAILY_NEW) return this.finish('daily-quota')
      if (elapsed() >= RUN_MS) return this.finish('time')
      if (sincePause >= BATCH_PAUSE_EVERY) { sincePause = 0; await this.deps.sleep(120_000 + this.deps.random() * 120_000) }
    }
  }
}
