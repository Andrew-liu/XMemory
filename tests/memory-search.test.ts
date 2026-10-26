import { describe, expect, it } from 'vitest'
import { autoStatus, isPartialMemory, memoryMatches, parseMemoryQuery } from '../src/renderer/Memory'
import type { ArchiveProgress, BookmarkGuardInfo, Note } from '../src/shared/types'

const note = (extra: Partial<Note>): Note => ({ id: 'n', kind: 'memory', title: '星舰第五次试飞', body: '# X 原文\n\n助推器被机械臂夹住', hash: 'h', path: 'memories/n.md', tags: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', author: 'ElonMusk', source: 'https://x.com/elonmusk/status/1', ...extra })

describe('记忆搜索解析（T-07）', () => {
  it('@作者 部分匹配且不区分大小写', () => {
    expect(memoryMatches(note({}), '@elon')).toBe(true)
    expect(memoryMatches(note({}), '@ELONMUSK')).toBe(true)
    expect(memoryMatches(note({}), '@sama')).toBe(false)
  })
  it('普通词搜标题、正文和链接，不搜作者', () => {
    expect(memoryMatches(note({}), '机械臂')).toBe(true)
    expect(memoryMatches(note({}), '试飞')).toBe(true)
    expect(memoryMatches(note({}), 'status/1')).toBe(true)
    expect(memoryMatches(note({ title: 't', body: 'b', source: 'https://x.com/a/status/2' }), 'elonmusk')).toBe(false)
  })
  it('作者与正文可组合，均需命中', () => {
    expect(memoryMatches(note({}), '@elonmusk 星舰')).toBe(true)
    expect(memoryMatches(note({}), '@elonmusk 火箭')).toBe(false)
    expect(memoryMatches(note({}), '@sama 星舰')).toBe(false)
  })
  it('“不完整”筛出 partial 记忆', () => {
    expect(memoryMatches(note({ partial: true }), '不完整')).toBe(true)
    expect(memoryMatches(note({}), '不完整')).toBe(false)
    expect(memoryMatches(note({ body: '> 正文可能不完整，尚未取得可核验的完整结构。' }), '不完整')).toBe(true)
    expect(memoryMatches(note({ partial: true }), '不完整 @elon')).toBe(true)
    expect(parseMemoryQuery('  @A  词  不完整 @ ')).toEqual({ authors: ['a'], terms: ['词'], partial: true })
  })
  it.each([false, undefined])('正文完整时未下载的视频不影响完整性（partial=%s）', partial => {
    const complete = note({ partial, body: '# X 原文\n\n完整正文\n\n> 视频未下载，仅保留封面和原文链接。' })
    expect(isPartialMemory(complete)).toBe(false)
    expect(memoryMatches(complete, '不完整')).toBe(false)
    expect(memoryMatches(complete, '@elon 不完整')).toBe(false)
    expect(memoryMatches(complete, '@elon 完整正文')).toBe(true)
  })
  it('视频提示不会掩盖实际不完整标记', () => {
    const body = '正文\n\n> 视频未下载，仅保留封面和原文链接。'
    for (const incomplete of [
      note({ partial: true, body }),
      note({ body: `${body}\n\n> 正文可能不完整，尚未取得可核验的完整结构。` }),
      note({ body: `${body}\n\n> 附件待补抓` })
    ]) {
      expect(isPartialMemory(incomplete)).toBe(true)
      expect(memoryMatches(incomplete, '不完整')).toBe(true)
    }
  })
  it('空搜索匹配全部', () => { expect(memoryMatches(note({}), '   ')).toBe(true) })
})

describe('自动采集状态行', () => {
  const bookmarks: BookmarkGuardInfo = { newToday: 12, articlesToday: 1, dailyLimit: 200, articleLimit: 50, historyComplete: true }
  const archive: ArchiveProgress = { phase: 'idle', found: 0, saved: 0, imagesDone: 0, imagesFailed: 0 }
  const now = Date.parse('2026-10-23T14:00:00')
  it('未开启显示开启按钮', () => {
    const view = autoStatus({ enabled: false, active: false, lastRun: { at: '2026-10-23T13:30:00', created: 3, checked: 20, stopReason: 'known-streak' } }, bookmarks, archive, '', now)
    expect(view.action).toBe('enable')
    expect(view.text).toBe('自动采集未开启 · 上次 13:30 新增 3 条')
  })
  it('等待下一轮', () => {
    const view = autoStatus({ enabled: true, active: false, nextRunAt: '2026-10-23T14:32:00' }, bookmarks, archive, '', now)
    expect(view.text).toBe('自动采集中 · 下次约 14:32 · 今日 12/200 · 历史已回溯完')
    expect(view.action).toBe('pause')
  })
  it('采集中带进度', () => {
    const view = autoStatus({ enabled: true, active: true, limit: 50 }, bookmarks, { ...archive, phase: 'collecting', checked: 35, saved: 5 }, '', now)
    expect(view.text).toBe('正在采集 · 已检查 35 · 新增 5 · 长文 1/50')
    expect(view.progress).toBeCloseTo(0.1)
  })
  it('未登录、冷却、额度满', () => {
    expect(autoStatus({ enabled: true, active: false, skip: { reason: 'login', at: '' } }, bookmarks, archive, '', now).login).toBe(true)
    expect(autoStatus({ enabled: true, active: false, skip: { reason: 'cooldown', at: '', until: '2026-10-23T16:30:00' } }, bookmarks, archive, '', now).text).toBe('X 限流冷却中，16:30 后自动恢复')
    expect(autoStatus({ enabled: true, active: false }, { ...bookmarks, newToday: 200 }, archive, '', now).text).toBe('今日额度已满，明天继续')
  })
})
