import type { AutoCollectState, AutoSkipReason, BookmarkGuardInfo, BookmarkRunResult } from '../shared/types'

export const AUTO_INTERVAL_MS = 3 * 60 * 60_000
export const AUTO_JITTER_MS = 30 * 60_000
/** Local hours [start, end) with no unattended rounds; a round due then waits until shortly after `end`. */
export const QUIET_START_HOUR = 1
export const QUIET_END_HOUR = 8
const QUIET_SPREAD_MS = 30 * 60_000
/** After this many rounds in a row with nothing new, the interval doubles, up to the maximum. */
export const IDLE_ROUNDS_BACKOFF = 3
export const AUTO_INTERVAL_MAX_MS = 12 * 60 * 60_000
export const AUTO_DELAY_MIN_MS = 3 * 60_000
export const AUTO_DELAY_MAX_MS = 8 * 60_000
export const AUTO_RESUME_GAP_MS = 60 * 60_000
export const AUTO_BREAKER_COOLDOWN_MS = 2 * 60 * 60_000
export const RUN_LIMIT_BACKFILL = 30
export const RUN_LIMIT_INCREMENTAL = 20

export class XLoginRequired extends Error {
  constructor() { super('未登录 X，自动采集已跳过') }
}

export interface AutoCollectDeps {
  now: () => number
  random: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
  summary: () => BookmarkGuardInfo
  /** Whether the user asked to fill in older bookmarks (off: only the newest are checked). */
  backfill: () => boolean
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

export function runLimit(backfill: boolean) {
  return backfill ? RUN_LIMIT_BACKFILL : RUN_LIMIT_INCREMENTAL
}

/** Move a time inside the night window to just after it ends (spread by `spread` ms); other times are unchanged. */
export function afterQuietHours(at: number, spread: number) {
  const date = new Date(at)
  const hour = date.getHours()
  if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) return at
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), QUIET_END_HOUR).getTime() + spread
}

/** Interval for the next round given how many rounds in a row found nothing new. */
export function backoffInterval(base: number, idleRounds: number) {
  if (idleRounds < IDLE_ROUNDS_BACKOFF) return base
  return Math.min(base * 2 ** (idleRounds - IDLE_ROUNDS_BACKOFF + 1), AUTO_INTERVAL_MAX_MS)
}

export class AutoCollector {
  private timer: unknown
  private enabled = false
  private active = false
  private disposed = false
  private nextRunAt?: number
  private lastAttemptAt?: number
  private limit?: number
  private idleRounds = 0
  private skip?: AutoCollectState['skip']
  private lastRun?: AutoCollectState['lastRun']

  constructor(private deps: AutoCollectDeps) {}

  get state(): AutoCollectState {
    return {
      enabled: this.enabled,
      active: this.active,
      backfill: this.deps.backfill(),
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
  private interval() { return backoffInterval(AUTO_INTERVAL_MS - AUTO_JITTER_MS + Math.floor(this.deps.random() * AUTO_JITTER_MS * 2), this.idleRounds) }

  private clear() {
    if (this.timer !== undefined) this.deps.clearTimer(this.timer)
    this.timer = undefined
    this.nextRunAt = undefined
  }

  private schedule(ms: number) {
    const now = this.deps.now()
    ms = Math.max(afterQuietHours(now + ms, Math.floor(this.deps.random() * QUIET_SPREAD_MS)) - now, 0)
    this.nextRunAt = now + ms
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
      this.limit = runLimit(this.deps.backfill())
      this.skip = undefined
      this.deps.change()
      try {
        const result = await this.deps.run(this.limit)
        this.lastRun = { at: new Date(this.deps.now()).toISOString(), created: result.created, checked: result.checked, stopReason: result.stopReason }
        // Only rounds that finished normally count toward backoff; breakers and quotas have their own waits.
        if (result.created > 0) this.idleRounds = 0
        else if (['known-streak', 'check-limit', 'bottom', 'time', 'limit'].includes(result.stopReason)) this.idleRounds++
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
