import { describe, expect, it } from 'vitest'
import { AutoCollector, XLoginRequired, afterQuietHours, backoffInterval, blockedUntil, runLimit, type AutoCollectDeps } from '../src/main/auto-collect'
import type { BookmarkGuardInfo, BookmarkRunResult } from '../src/shared/types'

const MIN = 60_000
const baseSummary = (extra: Partial<BookmarkGuardInfo> = {}): BookmarkGuardInfo => ({ newToday: 0, articlesToday: 0, dailyLimit: 60, articleLimit: 15, historyComplete: false, ...extra })
const result = (extra: Partial<BookmarkRunResult> = {}): BookmarkRunResult => ({ checked: 10, created: 3, skipped: 7, failed: 0, articlesQueued: 0, stopReason: 'known-streak', ...extra })

function clock(options: { random?: number; start?: string; backfill?: () => boolean; summary?: () => BookmarkGuardInfo; run?: (limit: number) => Promise<BookmarkRunResult> } = {}) {
  let now = Date.parse(options.start || '2026-10-23T09:00:00')
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let nextId = 1
  const calls = { runs: [] as number[], finishes: 0, changes: 0 }
  const deps: AutoCollectDeps = {
    now: () => now,
    random: () => options.random ?? 0.5,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: now + ms, fn, id }); return id },
    clearTimer: id => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1) },
    summary: options.summary || (() => baseSummary()),
    backfill: options.backfill || (() => false),
    run: async limit => { calls.runs.push(limit); return options.run ? options.run(limit) : result() },
    finish: async () => { calls.finishes++ },
    change: () => { calls.changes++ }
  }
  const advance = async (ms: number) => {
    const target = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const due = timers[0]
      if (!due || due.at > target) break
      timers.shift()
      now = due.at
      due.fn()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    }
    now = target
  }
  return { deps, calls, advance, timers, get now() { return now }, set now(value: number) { now = value } }
}

describe('AutoCollector 调度（T-01）', () => {
  it('开启后 3～8 分钟内首轮，之后间隔 2.5～3.5 小时', async () => {
    for (const random of [0, 0.999]) {
      const c = clock({ random })
      const auto = new AutoCollector(c.deps)
      auto.setEnabled(true)
      const first = Date.parse(auto.state.nextRunAt!) - c.now
      expect(first).toBeGreaterThanOrEqual(3 * MIN)
      expect(first).toBeLessThanOrEqual(8 * MIN)
      await c.advance(first)
      expect(c.calls.runs).toHaveLength(1)
      const gap = Date.parse(auto.state.nextRunAt!) - c.now
      expect(gap).toBeGreaterThanOrEqual(150 * MIN)
      expect(gap).toBeLessThanOrEqual(210 * MIN)
      await c.advance(gap)
      expect(c.calls.runs).toHaveLength(2)
      auto.dispose()
    }
  })

  it('关闭后不再触发，也不保留下次时间', async () => {
    const c = clock()
    const auto = new AutoCollector(c.deps)
    auto.setEnabled(true)
    auto.setEnabled(false)
    expect(auto.state.nextRunAt).toBeUndefined()
    await c.advance(5 * 60 * MIN)
    expect(c.calls.runs).toHaveLength(0)
  })

  it('本轮进行中关闭，结束后不再排下一轮', async () => {
    let release!: () => void
    const c = clock({ run: () => new Promise(resolve => { release = () => resolve(result({ stopReason: 'paused' })) }) })
    const auto = new AutoCollector(c.deps)
    auto.setEnabled(true)
    await c.advance(8 * MIN)
    expect(auto.state.active).toBe(true)
    auto.setEnabled(false)
    release()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(auto.state.active).toBe(false)
    expect(auto.state.nextRunAt).toBeUndefined()
    expect(c.timers).toHaveLength(0)
    expect(c.calls.finishes).toBe(1)
  })

  it('唤醒：距上次不足 1 小时保持原计划，超过 1 小时重新等 3～8 分钟，不补跑', async () => {
    const c = clock()
    const auto = new AutoCollector(c.deps)
    auto.setEnabled(true)
    await c.advance(8 * MIN)
    expect(c.calls.runs).toHaveLength(1)
    const planned = auto.state.nextRunAt
    c.now += 20 * MIN
    auto.resume()
    expect(auto.state.nextRunAt).toBe(planned)
    // Sleep for 5 hours: no catch-up runs, only one round 3–8 minutes after resume.
    c.timers.length = 0
    c.now += 5 * 60 * MIN
    auto.resume()
    const wait = Date.parse(auto.state.nextRunAt!) - c.now
    expect(wait).toBeGreaterThanOrEqual(3 * MIN)
    expect(wait).toBeLessThanOrEqual(8 * MIN)
    await c.advance(wait)
    expect(c.calls.runs).toHaveLength(2)
    auto.dispose()
  })

  it('未开启时唤醒不排程', () => {
    const c = clock()
    const auto = new AutoCollector(c.deps)
    auto.resume()
    expect(auto.state.nextRunAt).toBeUndefined()
    expect(c.timers).toHaveLength(0)
  })
})

describe('AutoCollector 跳过条件（T-02）', () => {
  it('429 冷却期内不启动采集', async () => {
    const c = clock({ summary: () => baseSummary({ breaker: { reason: 'rate-limit', at: '2026-10-23T08:50:00', until: '2026-10-23T10:50:00' } }) })
    const auto = new AutoCollector(c.deps)
    auto.setEnabled(true)
    await c.advance(8 * MIN)
    expect(c.calls.runs).toHaveLength(0)
    expect(c.calls.finishes).toBe(0)
    expect(auto.state.skip?.reason).toBe('cooldown')
    expect(auto.state.skip?.until).toBe(new Date('2026-10-23T10:50:00').toISOString())
    expect(auto.state.nextRunAt).toBeDefined()
    auto.dispose()
  })

  it('无到期时间的熔断按 2 小时冷却，过后恢复', () => {
    const at = '2026-10-23T08:00:00'
    const summary = baseSummary({ breaker: { reason: 'loop', at } })
    expect(blockedUntil(summary, Date.parse('2026-10-23T09:00:00'))).toBe(Date.parse(at) + 120 * MIN)
    expect(blockedUntil(summary, Date.parse('2026-10-23T10:01:00'))).toBeUndefined()
  })

  it('今日额度已满不启动采集', async () => {
    const c = clock({ summary: () => baseSummary({ newToday: 60 }) })
    const auto = new AutoCollector(c.deps)
    auto.setEnabled(true)
    await c.advance(8 * MIN)
    expect(c.calls.runs).toHaveLength(0)
    expect(auto.state.skip?.reason).toBe('quota')
    auto.dispose()
  })

  it('未登录时记录跳过原因并关闭 Chrome，下一轮照常排程', async () => {
    const c = clock({ run: async () => { throw new XLoginRequired() } })
    const auto = new AutoCollector(c.deps)
    auto.setEnabled(true)
    await c.advance(8 * MIN)
    expect(auto.state.skip?.reason).toBe('login')
    expect(c.calls.finishes).toBe(1)
    expect(auto.state.nextRunAt).toBeDefined()
    auto.dispose()
  })

  it('本轮触发熔断后记录冷却到期时间', async () => {
    let breaker: BookmarkGuardInfo['breaker']
    const c = clock({ summary: () => baseSummary({ breaker }), run: async () => { breaker = { reason: 'rate-limit', at: new Date(c.now).toISOString(), until: new Date(c.now + 120 * MIN).toISOString() }; return result({ stopReason: 'breaker:rate-limit' }) } })
    const auto = new AutoCollector(c.deps)
    auto.setEnabled(true)
    await c.advance(8 * MIN)
    expect(auto.state.skip?.reason).toBe('cooldown')
    expect(auto.state.skip?.message).toBe('rate-limit')
    auto.dispose()
  })
})

describe('AutoCollector 每轮上限（T-03）', () => {
  it('回溯历史 30 条，只采新书签 20 条，按开关切换', async () => {
    expect(runLimit(true)).toBe(30)
    expect(runLimit(false)).toBe(20)
    let backfill = true
    const c = clock({ backfill: () => backfill })
    const auto = new AutoCollector(c.deps)
    auto.setEnabled(true)
    expect(auto.state.backfill).toBe(true)
    await c.advance(8 * MIN)
    backfill = false
    await c.advance(210 * MIN)
    expect(c.calls.runs).toEqual([30, 20])
    expect(auto.state.backfill).toBe(false)
    expect(auto.state.lastRun?.created).toBe(3)
    auto.dispose()
  })
})

describe('AutoCollector 夜间与空闲退避（v0.7.2）', () => {
  it('落在 1:00–8:00 的时间顺延到 8:00 之后，其余不变', () => {
    expect(afterQuietHours(Date.parse('2026-10-23T00:59:00'), 0)).toBe(Date.parse('2026-10-23T00:59:00'))
    expect(afterQuietHours(Date.parse('2026-10-23T01:00:00'), 10 * MIN)).toBe(Date.parse('2026-10-23T08:10:00'))
    expect(afterQuietHours(Date.parse('2026-10-23T07:59:00'), 0)).toBe(Date.parse('2026-10-23T08:00:00'))
    expect(afterQuietHours(Date.parse('2026-10-23T08:00:00'), 0)).toBe(Date.parse('2026-10-23T08:00:00'))
  })
  it('夜里开启或排到夜里的一轮在 8:00–8:30 之间执行', async () => {
    const c = clock({ start: '2026-10-23T23:30:00', random: 0.5 })
    const auto = new AutoCollector(c.deps)
    auto.setEnabled(true)
    await c.advance(10 * MIN)
    expect(c.calls.runs).toHaveLength(1)
    const next = new Date(auto.state.nextRunAt!)
    expect(next.getHours()).toBe(8)
    expect(next.getMinutes()).toBeLessThanOrEqual(30)
    auto.dispose()
  })
  it('退避间隔：3 轮无新增后翻倍，最长 12 小时', () => {
    const base = 180 * MIN
    expect([0, 1, 2, 3, 4, 5, 9].map(n => backoffInterval(base, n) / MIN)).toEqual([180, 180, 180, 360, 720, 720, 720])
  })
  it('连续无新增拉长间隔，有新增后恢复 3 小时', async () => {
    let created = 0
    const c = clock({ start: '2026-10-23T09:00:00', run: async () => result({ created, stopReason: 'known-streak' }) })
    const auto = new AutoCollector(c.deps)
    const gaps: number[] = []
    auto.setEnabled(true)
    await c.advance(8 * MIN)
    for (let i = 0; i < 4; i++) {
      const gap = Date.parse(auto.state.nextRunAt!) - c.now
      gaps.push(gap)
      if (i === 3) created = 2
      await c.advance(gap)
    }
    gaps.push(Date.parse(auto.state.nextRunAt!) - c.now)
    // Gaps may be stretched by the night window, so compare against the plain backoff as a lower bound.
    expect(gaps[0]).toBeLessThan(211 * MIN)
    expect(gaps[1]).toBeLessThan(211 * MIN)
    expect(gaps[2]).toBeGreaterThanOrEqual(300 * MIN)
    expect(gaps[3]).toBeGreaterThanOrEqual(600 * MIN)
    expect(gaps[4]).toBeLessThanOrEqual(211 * MIN + 7 * 60 * MIN)
    expect(c.calls.runs).toHaveLength(5)
    auto.dispose()
  })
  it('熔断结束的轮次不计入空闲退避', async () => {
    const c = clock({ run: async () => result({ created: 0, stopReason: 'breaker:loop' }) })
    const auto = new AutoCollector(c.deps)
    auto.setEnabled(true)
    await c.advance(8 * MIN)
    for (let i = 0; i < 4; i++) await c.advance(Date.parse(auto.state.nextRunAt!) - c.now)
    expect(Date.parse(auto.state.nextRunAt!) - c.now).toBeLessThan(12 * 60 * MIN)
    auto.dispose()
  })
})
