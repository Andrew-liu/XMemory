import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Library } from '../src/main/library'
import { syncAllowed } from '../src/main/sync'
import {
  DEFAULT_INCOME_CATEGORIES,
  amountCents,
  collectIncomeCategories,
  formatCents,
  incomeDate,
  normalizeAmount,
  normalizeUsdRate,
  summarizeIncome,
  toCnyCents
} from '../src/shared/income'
import type { Note } from '../src/shared/types'

const temporary = path.resolve(process.cwd(), '../../trash/xmemeory-dev/income-unit')
mkdirSync(temporary, { recursive: true })

function sampleIncome(overrides: Partial<Note> & { id: string; title: string }): Note {
  return {
    kind: 'income',
    body: '',
    hash: 'h',
    path: `incomes/2026/${overrides.id}.md`,
    tags: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    scheduledDate: '2026-11-01',
    amount: 100,
    currency: 'CNY',
    incomeCategory: '厂家商单',
    incomeStatus: 'confirmed',
    ...overrides
  }
}

describe('生财（v0.8.0）金额精度、双币种折算与月度/年度统计', () => {
  it('金额校验与整数分累加无浮点尾差，双币种按汇率准确折合人民币', () => {
    expect(normalizeAmount('19.99')).toBe(19.99)
    expect(normalizeAmount(100.556)).toBe(100.56)
    expect(normalizeAmount(-1)).toBeUndefined()
    expect(normalizeAmount('abc')).toBeUndefined()
    expect(normalizeUsdRate('7.25')).toBe(7.25)
    expect(normalizeUsdRate(0)).toBe(7.2)

    const notes: Note[] = [
      sampleIncome({ id: 'a', title: '甲', amount: 19.99, currency: 'CNY', incomeStatus: 'received' }),
      sampleIncome({ id: 'b', title: '乙', amount: 0.01, currency: 'CNY', incomeStatus: 'received' }),
      sampleIncome({ id: 'c', title: '丙', amount: 100, currency: 'USD', incomeStatus: 'completed' })
    ]
    const sum = summarizeIncome(notes, { year: '2026', month: '11', usdRate: 7.25 })
    expect(sum.total.cnyCents).toBe(2000)
    expect(sum.total.usdCents).toBe(10000)
    expect(sum.total.equivCnyCents).toBe(2000 + 72500)
    expect(formatCents(sum.total.equivCnyCents, 'CNY')).toBe('¥ 745.00')
    expect(formatCents(sum.total.usdCents, 'USD')).toBe('$ 100.00')
    expect(amountCents(0.1) + amountCents(0.2)).toBe(30)
    expect(toCnyCents(10, 'USD', 7.2)).toBe(7200)
  })

  it('按归属日期聚合月度与年度统计，区分已确定、已完成与已到账，忽略已删除记录', () => {
    const notes: Note[] = [
      sampleIncome({ id: 'nov-1', title: '11月X工资', scheduledDate: '2026-11-02', incomeCategory: 'X工资', currency: 'USD', amount: 400, incomeStatus: 'received' }),
      sampleIncome({ id: 'nov-2', title: '11月厂家商单', scheduledDate: '2026-11-03', incomeCategory: '厂家商单', currency: 'CNY', amount: 3000, incomeStatus: 'completed' }),
      sampleIncome({ id: 'nov-3', title: '11月tutti商单', scheduledDate: '2026-11-04', incomeCategory: 'tutti商单', currency: 'USD', amount: 200, incomeStatus: 'confirmed' }),
      sampleIncome({ id: 'oct-1', title: '10月VPS分成', scheduledDate: '2026-10-15', incomeCategory: 'VPS分成', currency: 'CNY', amount: 1500, incomeStatus: 'received' }),
      sampleIncome({ id: 'del-1', title: '已删记录', scheduledDate: '2026-11-04', incomeCategory: 'VPN分成', currency: 'CNY', amount: 9999, incomeStatus: 'received', deleted: true }),
      sampleIncome({ id: '2025-1', title: '去年收入', scheduledDate: '2025-12-20', incomeCategory: 'X工资', currency: 'USD', amount: 500, incomeStatus: 'received' })
    ]

    // 11月单月统计（汇率 7.0）
    const nov = summarizeIncome(notes, { year: '2026', month: '11', usdRate: 7.0 })
    expect(nov.total.count).toBe(3)
    expect(nov.received.equivCnyCents).toBe(280000) // $400 * 7
    expect(nov.completed.equivCnyCents).toBe(300000) // ¥3000
    expect(nov.confirmed.equivCnyCents).toBe(140000) // $200 * 7
    expect(nov.pending.equivCnyCents).toBe(440000) // completed + confirmed
    expect(nov.total.equivCnyCents).toBe(720000)

    // 2026全年统计
    const year2026 = summarizeIncome(notes, { year: '2026', month: 'all', usdRate: 7.0 })
    expect(year2026.total.count).toBe(4)
    expect(year2026.total.equivCnyCents).toBe(720000 + 150000)
    expect(year2026.byMonth.find(m => m.month === '11')?.equivCnyCents).toBe(720000)
    expect(year2026.byMonth.find(m => m.month === '10')?.equivCnyCents).toBe(150000)
    expect(year2026.years).toEqual(['2026', '2025'])
  })

  it('支持内置五类与自定义分类汇总，按折合总额降序排列', () => {
    const notes: Note[] = [
      sampleIncome({ id: '1', title: '自定义商单', incomeCategory: '专栏订阅', amount: 5000, currency: 'CNY' }),
      sampleIncome({ id: '2', title: 'VPN佣金', incomeCategory: 'VPN分成', amount: 1200, currency: 'CNY' })
    ]
    const cats = collectIncomeCategories(notes, ['技术咨询'])
    expect(cats).toEqual([...DEFAULT_INCOME_CATEGORIES, '技术咨询', '专栏订阅'])

    const sum = summarizeIncome(notes, { year: '2026', month: '11', categories: ['技术咨询'] })
    expect(sum.byCategory[0].category).toBe('专栏订阅')
    expect(sum.byCategory[0].equivCnyCents).toBe(500000)
    expect(sum.byCategory[1].category).toBe('VPN分成')
    expect(incomeDate({ scheduledDate: undefined, createdAt: '2026-08-19T12:00:00.000Z' })).toBe('2026-08-19')
  })

  it('Library 保存与重载收入记录、自动记录到账时间、兼容外部编辑并允许 GitHub 同步', () => {
    const dir = mkdtempSync(path.join(temporary, 'lib-'))
    const lib = new Library(dir)
    try {
      const saved = lib.save({
        kind: 'income',
        title: '11月tutti推广',
        body: '备注说明',
        scheduledDate: '2026-11-04',
        incomeCategory: 'tutti商单',
        currency: 'USD',
        amount: 280.5,
        incomeStatus: 'confirmed',
        source: 'https://x.com/example/status/1'
      })
      expect(saved.path).toBe('incomes/2026/2026-11-04 tutti商单 - 11月tutti推广.md')
      expect(syncAllowed(saved.path)).toBe(true)
      expect(saved.amount).toBe(280.5)
      expect(saved.currency).toBe('USD')
      expect(saved.incomeCategory).toBe('tutti商单')
      expect(saved.incomeStatus).toBe('confirmed')
      expect(saved.receivedAt).toBeUndefined()

      // 转换状态为已到账时自动生成 receivedAt
      const received = lib.save({ ...saved, incomeStatus: 'received' }, saved.hash)
      expect(received.incomeStatus).toBe('received')
      expect(typeof received.receivedAt).toBe('string')

      // 从已到账切回已完成时清除 receivedAt
      const backToCompleted = lib.save({ ...received, incomeStatus: 'completed' }, received.hash)
      expect(backToCompleted.incomeStatus).toBe('completed')
      expect(backToCompleted.receivedAt).toBeUndefined()

      // 外部编辑异常金额容错
      const target = path.join(dir, backToCompleted.path)
      writeFileSync(target, readFileSync(target, 'utf8').replace('amount: 280.5', 'amount: invalid'))
      lib.refresh()
      expect(lib.get(saved.id).amount).toBe(0)
      expect(lib.errors.some(e => e.includes('金额无效'))).toBe(true)
    } finally {
      void lib.close()
    }
  })
})
