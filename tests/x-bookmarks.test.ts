import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { BookmarkScanner, RiskGuard, type ScannerDeps } from '../src/main/x-bookmarks'

const temporary = path.resolve(process.cwd(), '../../trash/xmemeory-dev/tests')
mkdirSync(temporary, { recursive: true })
const root = () => { const dir = mkdtempSync(path.join(temporary, 'guard-')); mkdirSync(path.join(dir, 'local'), { recursive: true }); return dir }
const tweet = (id: string, extra: Record<string, unknown> = {}) => ({ __typename: 'Tweet', rest_id: id, legacy: { full_text: `合成推文 ${id}`, truncated: false, entities: { urls: [] } }, core: { user_results: { result: { legacy: { screen_name: `user${id}` } } } }, ...extra })
const articleTweet = (id: string) => tweet(id, { legacy: { full_text: `长文 ${id} https://t.co/x`, truncated: false, entities: { urls: [{ url: 'https://t.co/x', expanded_url: `https://x.com/i/article/${id}` }] } } })
const entry = (result: unknown) => ({ entryId: `tweet-${(result as any)?.rest_id || 'x'}`, content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweet_results: { result } } } })
const payload = (entries: unknown[], rootExtra: Record<string, unknown> = {}) => ({ data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } }, ...rootExtra })
const feed = (...results: unknown[]) => payload(results.map(entry))
const cursorOnly = () => payload([{ entryId: 'cursor-bottom-1', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'tail' } }])

function harness(overrides: Partial<ScannerDeps> = {}) {
  const calls = { saved: [] as string[], details: [] as { id: string; url: string }[], scrolls: 0, sleeps: [] as number[], progress: [] as Array<Record<string, number>> }
  let stopped = false
  let time = new Date('2026-10-21T10:00:00')
  const deps: ScannerDeps = {
    isKnown: () => false,
    saveDirect: async (_tweet, id) => { calls.saved.push(id); return 'created' },
    collectDetail: async (id, url) => { calls.details.push({ id, url }); return 'created' },
    scroll: async () => { calls.scrolls++; return { moved: false, atEnd: true } },
    sleep: async ms => { calls.sleeps.push(ms); time = new Date(time.getTime() + ms) },
    now: () => time,
    random: () => 0.5,
    stopped: () => stopped,
    progress: p => calls.progress.push(p),
    ...overrides
  }
  return {
    deps, calls,
    setStopped: (value: boolean) => { stopped = value },
    setTime: (value: Date) => { time = value },
    getTime: () => time
  }
}
const guardAt = (state?: object) => {
  const dir = root()
  const g = new RiskGuard(dir, '42')
  if (state) { Object.assign(g.state, state); g.save() }
  return g
}

it('状态文件缺失或损坏时使用保守默认值', () => {
  const dir = root()
  const g = new RiskGuard(dir, '42')
  expect(g.state).toMatchObject({ newToday: 0, articlesToday: 0, historyComplete: false })
  writeFileSync(g.file, '这不是 JSON')
  expect(new RiskGuard(dir, '42').state).toMatchObject({ newToday: 0, articlesToday: 0, historyComplete: false })
  expect(new RiskGuard(dir, 'not-a-number').file).toContain('x-bookmarks-cdp.json')
})
it('跨日重置当日计数，当日额度用完拒绝启动', () => {
  const g = guardAt({ day: '2026-10-20', newToday: 7, articlesToday: 3 })
  g.rollover(new Date('2026-10-21T09:00:00'))
  expect(g.state).toMatchObject({ day: '2026-10-21', newToday: 0, articlesToday: 0 })
  const full = guardAt({ day: '2026-10-21', newToday: 200 })
  expect(() => full.canStart(new Date('2026-10-21T09:00:00'))).toThrow('今日书签额度已用完（200 条）')
})
it('429 冷却在到期前阻止启动，到期后清除', () => {
  const now = new Date('2026-10-21T10:00:00')
  const g = guardAt()
  g.setBreaker('rate-limit', now, new Date(now.getTime() + 2 * 60 * 60_000))
  expect(() => g.canStart(new Date(now.getTime() + 60_000))).toThrow('限流冷却中')
  g.canStart(new Date(now.getTime() + 2 * 60 * 60_000 + 1000))
  expect(g.state.breaker).toBeUndefined()
})
it('手动熔断由用户重新开始时确认清除', () => {
  const g = guardAt()
  g.setBreaker('auth', new Date('2026-10-21T10:00:00'))
  expect(JSON.parse(readFileSync(g.file, 'utf8')).breaker.reason).toBe('auth')
  g.canStart(new Date('2026-10-21T10:05:00'))
  expect(g.state.breaker).toBeUndefined()
})
it('短推直接落盘不打开详情页，达到本次上限停止', async () => {
  const g = guardAt()
  const { deps, calls } = harness()
  const scanner = new BookmarkScanner(g, deps)
  scanner.ingest(200, feed(tweet('1'), tweet('2'), tweet('3')))
  const result = await scanner.run(2)
  expect(result).toMatchObject({ checked: 2, created: 2, skipped: 0, failed: 0, articlesQueued: 0, stopReason: 'limit' })
  expect(calls.saved).toEqual(['1', '2'])
  expect(calls.details).toEqual([])
  expect(calls.scrolls).toBe(0)
  expect(g.state.newToday).toBe(2)
  expect(JSON.parse(readFileSync(g.file, 'utf8'))).toMatchObject({ lastStopReason: 'limit', newToday: 2 })
})
it('已存在条目（含回收站）跳过且不改写，历史回溯阶段不因连续已存在停止', async () => {
  const g = guardAt({ historyComplete: false })
  const known = new Set(Array.from({ length: 20 }, (_, i) => String(i + 1)).concat(['99']))
  const { deps, calls } = harness({ isKnown: id => known.has(id) })
  const scanner = new BookmarkScanner(g, deps)
  scanner.ingest(200, feed(...[...known].map(id => tweet(id)), tweet('777')))
  const result = await scanner.run(20)
  expect(result.stopReason).not.toBe('known-streak')
  expect(calls.saved).toEqual(['777'])
  expect(calls.details).toEqual([])
  expect(result.skipped).toBe(known.size)
})
it('historyComplete 后连续 20 条已存在即停止', async () => {
  const g = guardAt({ historyComplete: true })
  const ids = Array.from({ length: 30 }, (_, i) => String(i + 1))
  const { deps, calls } = harness({ isKnown: () => true })
  const scanner = new BookmarkScanner(g, deps)
  scanner.ingest(200, feed(...ids.map(id => tweet(id))))
  const result = await scanner.run(50)
  expect(result).toMatchObject({ stopReason: 'known-streak', checked: 20, skipped: 20 })
  expect(calls.saved).toEqual([])
})
it('只含游标的响应视为到底并持久化 historyComplete', async () => {
  const g = guardAt()
  const { deps } = harness()
  const scanner = new BookmarkScanner(g, deps)
  scanner.ingest(200, feed(tweet('1')))
  scanner.ingest(200, cursorOnly())
  const result = await scanner.run(20)
  expect(result).toMatchObject({ stopReason: 'bottom', created: 1 })
  expect(g.state.historyComplete).toBe(true)
  expect(JSON.parse(readFileSync(g.file, 'utf8')).historyComplete).toBe(true)
})
it('连续 8 轮滚动无新 ID 且无新响应判定到底', async () => {
  const g = guardAt()
  const { deps, calls } = harness()
  const scanner = new BookmarkScanner(g, deps)
  scanner.ingest(200, feed(tweet('1')))
  const result = await scanner.run(20)
  expect(result.stopReason).toBe('bottom')
  expect(calls.scrolls).toBe(8)
  expect(calls.sleeps.filter(ms => ms >= 1800 && ms <= 4500)).toHaveLength(8)
  expect(JSON.parse(readFileSync(g.file, 'utf8')).historyComplete).toBe(true)
})
it('仍在移动的滚动不算空转，页面未到底部不判底', async () => {
  for (const outcome of [{ moved: true, atEnd: false }, { moved: false, atEnd: false }] as const) {
    const g = guardAt()
    const { deps, calls } = harness({ scroll: async () => { calls.scrolls++; return outcome } })
    const scanner = new BookmarkScanner(g, deps)
    scanner.ingest(200, feed(tweet('1')))
    const result = await scanner.run(20)
    expect(result.stopReason).toBe('time')
    expect(calls.scrolls).toBeGreaterThan(500)
    expect(g.state.historyComplete).toBe(false)
  }
})
it('第 7 轮出现新响应时空转计数清零', async () => {
  const g = guardAt()
  const calls = { scrolls: 0, saved: [] as string[] }
  let scanner!: BookmarkScanner
  const { deps } = harness({
    scroll: async () => {
      calls.scrolls++
      if (calls.scrolls === 7) scanner.ingest(200, feed(tweet('999')))
      return { moved: false, atEnd: true }
    },
    saveDirect: async (t, id) => { calls.saved.push(id); return 'created' }
  })
  scanner = new BookmarkScanner(g, deps)
  scanner.ingest(200, feed(tweet('1')))
  const result = await scanner.run(20)
  expect(result.stopReason).toBe('bottom')
  expect(calls.scrolls).toBe(15)
  expect(calls.saved).toEqual(['1', '999'])
})
it('长文入队串行采集，第二条起随机等待 8–20 秒', async () => {
  const g = guardAt()
  const { deps, calls } = harness()
  const scanner = new BookmarkScanner(g, deps)
  scanner.ingest(200, feed(articleTweet('201'), tweet('203'), articleTweet('202')))
  const result = await scanner.run(20)
  expect(result.stopReason).toBe('bottom')
  expect(calls.details.map(d => d.id)).toEqual(['201', '202'])
  expect(calls.details[0].url).toBe('https://x.com/user201/status/201')
  expect(calls.saved).toEqual(['203'])
  expect(result.articlesQueued).toBe(2)
  expect(g.state.articlesToday).toBe(2)
  const articleSleeps = calls.sleeps.filter(ms => ms >= 8000 && ms <= 20000)
  expect(articleSleeps).toHaveLength(1)
})
it('作者未知的长文用 i/web 链接进入详情采集', async () => {
  const g = guardAt()
  const { deps, calls } = harness()
  const scanner = new BookmarkScanner(g, deps)
  scanner.ingest(200, feed(
    articleTweet('901'),
    tweet('902', { core: undefined, article: { article_results: { result: { title: '合成标题', preview_text: '预览' } } } })
  ))
  const result = await scanner.run(20)
  expect(calls.details.map(d => d.url)).toEqual(['https://x.com/user901/status/901', 'https://x.com/i/web/status/902'])
  expect(result.created).toBe(2)
})
it('连续 3 条采集失败熔断并持久化', async () => {
  const g = guardAt()
  let attempts = 0
  const { deps } = harness({ saveDirect: async () => { attempts++; throw new Error('合成写入失败') } })
  const scanner = new BookmarkScanner(g, deps)
  scanner.ingest(200, feed(tweet('1'), tweet('2'), tweet('3'), tweet('4')))
  const result = await scanner.run(20)
  expect(result).toMatchObject({ stopReason: 'breaker:failures', failed: 3 })
  expect(attempts).toBe(3)
  expect(JSON.parse(readFileSync(g.file, 'utf8')).breaker.reason).toBe('failures')
})
it('登录或验证错误立即触发 auth 熔断', async () => {
  const g = guardAt()
  const { deps } = harness({ saveDirect: async () => { throw new Error('X 要求重新登录或安全验证') } })
  const scanner = new BookmarkScanner(g, deps)
  scanner.ingest(200, feed(tweet('1'), tweet('2')))
  const result = await scanner.run(20)
  expect(result).toMatchObject({ stopReason: 'breaker:auth', failed: 1 })
  expect(g.state.breaker?.reason).toBe('auth')
})
it('401/403/429 与连续错误响应触发对应熔断', async () => {
  for (const [status, reason] of [[401, 'auth'], [403, 'auth'], [429, 'rate-limit']] as const) {
    const g = guardAt()
    const scanner = new BookmarkScanner(g, harness().deps)
    scanner.ingest(status, undefined)
    const result = await scanner.run(20)
    expect(result.stopReason).toBe(`breaker:${reason}`)
    expect(g.state.breaker?.reason).toBe(reason)
  }
  const g = guardAt()
  const scanner = new BookmarkScanner(g, harness().deps)
  scanner.ingest(500, undefined)
  scanner.ingest(200, payload([entry(tweet('1'))], { errors: [{ message: '接口错误' }] }))
  scanner.ingest(503, undefined)
  const result = await scanner.run(20)
  expect(result.stopReason).toBe('breaker:api-errors')
})
it('响应结构不符立即停止并报结构变化', async () => {
  const g = guardAt()
  const { deps, calls } = harness()
  const scanner = new BookmarkScanner(g, deps)
  scanner.ingest(200, { data: { other: {} } })
  const result = await scanner.run(20)
  expect(result.stopReason).toBe('breaker:schema')
  expect(calls.scrolls).toBe(0)
})
it('连续 3 个响应有推文但无新 ID 判定列表循环', async () => {
  const g = guardAt()
  const { deps } = harness()
  const scanner = new BookmarkScanner(g, deps)
  scanner.ingest(200, feed(tweet('501'), tweet('502')))
  for (let i = 0; i < 3; i++) scanner.ingest(200, feed(tweet('501'), tweet('502')))
  const result = await scanner.run(20)
  expect(result.stopReason).toBe('breaker:loop')
  expect(g.state.breaker?.reason).toBe('loop')
})
it('暂停在当前条目处理完后停止', async () => {
  const g = guardAt()
  const { deps, setStopped } = harness()
  const inner = { ...deps }
  inner.saveDirect = async (tweetArg, id) => { setStopped(true); return deps.saveDirect(tweetArg, id) }
  const scanner = new BookmarkScanner(g, inner)
  scanner.ingest(200, feed(tweet('1'), tweet('2'), tweet('3')))
  const result = await scanner.run(20)
  expect(result).toMatchObject({ stopReason: 'paused', created: 1 })
})
it('每新增 30 条暂停 2–4 分钟，30 分钟运行时长停止', async () => {
  const g = guardAt()
  const { deps, calls } = harness()
  const scanner = new BookmarkScanner(g, deps)
  scanner.ingest(200, feed(...Array.from({ length: 35 }, (_, i) => tweet(String(i + 1)))))
  const result = await scanner.run(50)
  expect(calls.sleeps.some(ms => ms >= 120_000 && ms <= 240_000)).toBe(true)
  expect(result.stopReason).toBe('bottom')

  const g2 = guardAt()
  const { deps: deps2, setTime } = harness()
  const timed = new BookmarkScanner(g2, { ...deps2, scroll: async () => { setTime(new Date('2026-10-21T10:31:00')); return { moved: true, atEnd: false } } })
  timed.ingest(200, feed(tweet('1')))
  const result2 = await timed.run(20)
  expect(result2).toMatchObject({ stopReason: 'time', created: 1 })
})
it('墓碑条目只计入已检查，每日长文额度触发停止', async () => {
  const g = guardAt()
  const { deps } = harness()
  const scanner = new BookmarkScanner(g, deps)
  scanner.ingest(200, payload([
    entry(tweet('1')),
    { entryId: 'tweet-tomb', content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweet_results: { result: { __typename: 'TweetTombstone' } } } } }
  ]))
  const result = await scanner.run(20)
  expect(result.checked).toBe(2)
  expect(result.created).toBe(1)
  expect(result.failed).toBe(0)

  const full = guardAt({ articlesToday: 50 })
  const { deps: deps2, calls } = harness()
  const scanner2 = new BookmarkScanner(full, deps2)
  scanner2.ingest(200, feed(articleTweet('301')))
  const result2 = await scanner2.run(20)
  expect(result2.stopReason).toBe('daily-quota')
  expect(calls.details).toEqual([])
})
