import type { AutoCollectState, AutoSkipReason, BookmarkGuardInfo, BookmarkRunResult } from '../shared/types'

export const AUTO_INTERVAL_MS = 60 * 60_000
export const AUTO_JITTER_MS = 10 * 60_000
export const AUTO_DELAY_MIN_MS = 3 * 60_000
export const AUTO_DELAY_MAX_MS = 8 * 60_000
export const AUTO_RESUME_GAP_MS = 60 * 60_000
export const AUTO_BREAKER_COOLDOWN_MS = 2 * 60 * 60_000
export const RUN_LIMIT_BACKFILL = 100
export const RUN_LIMIT_INCREMENTAL = 50

export class XLoginRequired extends Error {
  constructor() { super('未登录 X，自动采集已跳过') }
}

export interface AutoCollectDeps {
  now: () => number
  random: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
  summary: () => BookmarkGuardInfo
  run: (limit: number) => Promise<BookmarkRunResult>
  finish: () => Promise<void>
  change: () => void
}

// Breakers without an explicit `until` (auth, schema, loop…) are retried after a fixed cooldown
// so an unattended scheduler never hammers X but also never stays stuck forever.
export function blockedUntil(summary: BookmarkGuardInfo, now: number) {
  const breaker = summary.breaker
  if (!breaker) return undefined
  const until = breaker.until ? Date.parse(breaker.until) : Date.parse(breaker.at) + AUTO_BREAKER_COOLDOWN_MS
  return Number.isFinite(until) && until > now ? until : undefined
}

export function runLimit(summary: BookmarkGuardInfo) {
  return summary.historyComplete ? RUN_LIMIT_INCREMENTAL : RUN_LIMIT_BACKFILL
}

export class AutoCollector {
  private timer: unknown
  private enabled = false
  private active = false
  private disposed = false
  private nextRunAt?: number
  private lastAttemptAt?: number
  private limit?: number
  private skip?: AutoCollectState['skip']
  private lastRun?: AutoCollectState['lastRun']

  constructor(private deps: AutoCollectDeps) {}

  get state(): AutoCollectState {
    return {
      enabled: this.enabled,
      active: this.active,
      limit: this.active ? this.limit : undefined,
      nextRunAt: this.nextRunAt !== undefined ? new Date(this.nextRunAt).toISOString() : undefined,
      skip: this.skip,
      lastRun: this.lastRun
    }
  }

  get running() { return this.active }

  /** Startup and toggling on both wait 3–8 minutes before the first round. */
  setEnabled(enabled: boolean) {
    if (this.disposed) return
    if (enabled === this.enabled) return
    this.enabled = enabled
    this.clear()
    if (enabled) {
      this.skip = undefined
      this.schedule(this.delay())
    } else this.skip = undefined
    this.deps.change()
  }

  /** System resume: only reschedule when the last attempt is over an hour old; missed rounds are not replayed. */
  resume() {
    if (!this.enabled || this.disposed || this.active) return
    const now = this.deps.now()
    const planned = this.nextRunAt
    const stale = this.lastAttemptAt === undefined || now - this.lastAttemptAt > AUTO_RESUME_GAP_MS
    const pending = planned !== undefined && planned > now
    this.clear()
    if (!stale && pending) this.schedule(planned - now)
    else this.schedule(this.delay())
    this.deps.change()
  }

  dispose() {
    this.disposed = true
    this.enabled = false
    this.clear()
  }

  private delay() { return AUTO_DELAY_MIN_MS + Math.floor(this.deps.random() * (AUTO_DELAY_MAX_MS - AUTO_DELAY_MIN_MS)) }
  private interval() { return AUTO_INTERVAL_MS - AUTO_JITTER_MS + Math.floor(this.deps.random() * AUTO_JITTER_MS * 2) }

  private clear() {
    if (this.timer !== undefined) this.deps.clearTimer(this.timer)
    this.timer = undefined
    this.nextRunAt = undefined
  }

  private schedule(ms: number) {
    this.nextRunAt = this.deps.now() + ms
    this.timer = this.deps.setTimer(() => { this.timer = undefined; void this.tick() }, ms)
  }

  private skipped(reason: AutoSkipReason, until?: number, message?: string) {
    this.skip = { reason, at: new Date(this.deps.now()).toISOString(), until: until !== undefined ? new Date(until).toISOString() : undefined, message }
  }

  private async tick() {
    this.nextRunAt = undefined
    if (!this.enabled || this.disposed) return
    if (this.active) { this.schedule(this.delay()); this.deps.change(); return }
    const now = this.deps.now()
    this.lastAttemptAt = now
    const summary = this.deps.summary()
    const until = blockedUntil(summary, now)
    if (until !== undefined) this.skipped('cooldown', until, summary.breaker?.reason)
    else if (summary.newToday >= summary.dailyLimit) this.skipped('quota')
    else {
      this.active = true
      this.limit = runLimit(summary)
      this.skip = undefined
      this.deps.change()
      try {
        const result = await this.deps.run(this.limit)
        this.lastRun = { at: new Date(this.deps.now()).toISOString(), created: result.created, checked: result.checked, stopReason: result.stopReason }
        if (result.stopReason === 'daily-quota') this.skipped('quota')
        else if (result.stopReason.startsWith('breaker:')) {
          const after = blockedUntil(this.deps.summary(), this.deps.now())
          if (after !== undefined) this.skipped('cooldown', after, result.stopReason.slice(8))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '自动采集失败'
        if (error instanceof XLoginRequired) this.skipped('login')
        else if (/冷却/.test(message)) this.skipped('cooldown', blockedUntil(this.deps.summary(), this.deps.now()))
        else if (/额度/.test(message)) this.skipped('quota')
        else if (/正在进行中/.test(message)) this.skipped('busy')
        else this.skipped('error', undefined, message)
      } finally {
        this.active = false
        this.limit = undefined
        await this.deps.finish().catch(() => {})
      }
    }
    if (this.enabled && !this.disposed && this.timer === undefined) this.schedule(this.interval())
    this.deps.change()
  }
}
