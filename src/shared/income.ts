import type { IncomeCurrency, IncomeStatus, Note } from './types'
import { dateKey, validDate } from './calendar'

export const INCOME_STATUSES = ['confirmed', 'completed', 'received'] as const satisfies readonly IncomeStatus[]
export const INCOME_CURRENCIES = ['CNY', 'USD'] as const satisfies readonly IncomeCurrency[]
export const DEFAULT_INCOME_CATEGORIES = ['X工资', '厂家商单', 'tutti商单', 'VPS分成', 'VPN分成'] as const
export const DEFAULT_USD_RATE = 7.2

export const incomeStatusLabels: Record<IncomeStatus, string> = {
  confirmed: '已确定',
  completed: '已完成',
  received: '已到账'
}

export function isIncomeStatus(value: unknown): value is IncomeStatus {
  return typeof value === 'string' && (INCOME_STATUSES as readonly string[]).includes(value)
}

export function isIncomeCurrency(value: unknown): value is IncomeCurrency {
  return typeof value === 'string' && (INCOME_CURRENCIES as readonly string[]).includes(value)
}

export function normalizeAmount(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(num) || num < 0 || num > 100_000_000) return undefined
  return Math.round(num * 100) / 100
}

export function normalizeUsdRate(value: unknown): number {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(num) || num <= 0 || num > 1000) return DEFAULT_USD_RATE
  return Math.round(num * 10000) / 10000
}

export function incomeDate(note: Pick<Note, 'scheduledDate' | 'createdAt'>): string {
  if (validDate(note.scheduledDate)) return note.scheduledDate
  const createdDay = typeof note.createdAt === 'string' ? note.createdAt.slice(0, 10) : ''
  if (validDate(createdDay)) return createdDay
  return dateKey()
}

export function amountCents(amount: number | undefined): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return 0
  return Math.round(amount * 100)
}

export function toCnyCents(amount: number | undefined, currency: IncomeCurrency | string | undefined, usdRate = DEFAULT_USD_RATE): number {
  const cents = amountCents(amount)
  const rate = normalizeUsdRate(usdRate)
  return currency === 'USD' ? Math.round(cents * rate) : cents
}

export function formatCents(cents: number, currency: IncomeCurrency = 'CNY'): string {
  const safe = Number.isFinite(cents) ? Math.round(cents) : 0
  const sign = safe < 0 ? '-' : ''
  const abs = Math.abs(safe)
  const fixed = (abs / 100).toFixed(2)
  const [whole, fraction] = fixed.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const symbol = currency === 'USD' ? '$' : '¥'
  return `${sign}${symbol} ${grouped}.${fraction}`
}

export function collectIncomeCategories(notes: Note[], customCategories?: string[]): string[] {
  const result: string[] = []
  const push = (raw: string | undefined) => {
    const clean = raw?.trim()
    if (clean && !result.includes(clean)) result.push(clean)
  }
  for (const preset of DEFAULT_INCOME_CATEGORIES) push(preset)
  if (Array.isArray(customCategories)) {
    for (const item of customCategories) if (typeof item === 'string') push(item)
  }
  for (const note of notes) {
    if (note.kind === 'income' && !note.deleted) push(note.incomeCategory)
  }
  return result
}

export interface IncomeBucketSummary {
  count: number
  cnyCents: number
  usdCents: number
  equivCnyCents: number
}

export interface IncomeCategorySummary extends IncomeBucketSummary {
  category: string
  receivedEquivCnyCents: number
  pendingEquivCnyCents: number
  sharePercent: number
}

export interface IncomeMonthSummary extends IncomeBucketSummary {
  month: string
  label: string
  receivedEquivCnyCents: number
  pendingEquivCnyCents: number
}

export interface IncomeSummary {
  year: string
  month: string
  usdRate: number
  years: string[]
  periodNotes: Note[]
  total: IncomeBucketSummary
  received: IncomeBucketSummary
  pending: IncomeBucketSummary
  completed: IncomeBucketSummary
  confirmed: IncomeBucketSummary
  byCategory: IncomeCategorySummary[]
  byMonth: IncomeMonthSummary[]
}

function summarizeBucket(items: Note[], usdRate: number): IncomeBucketSummary {
  let cnyCents = 0
  let usdCents = 0
  let equivCnyCents = 0
  for (const item of items) {
    const cents = amountCents(item.amount)
    if (item.currency === 'USD') usdCents += cents
    else cnyCents += cents
    equivCnyCents += toCnyCents(item.amount, item.currency, usdRate)
  }
  return { count: items.length, cnyCents, usdCents, equivCnyCents }
}

export function summarizeIncome(
  notes: Note[],
  options?: { year?: string; month?: string; usdRate?: number; categories?: string[] }
): IncomeSummary {
  const currentYear = dateKey().slice(0, 4)
  const usdRate = normalizeUsdRate(options?.usdRate)
  const incomeNotes = notes.filter(n => n.kind === 'income' && !n.deleted)

  const yearSet = new Set<string>([currentYear])
  for (const note of incomeNotes) {
    const y = incomeDate(note).slice(0, 4)
    if (/^\d{4}$/.test(y)) yearSet.add(y)
  }
  if (options?.year && /^\d{4}$/.test(options.year)) yearSet.add(options.year)
  const years = [...yearSet].sort((a, b) => b.localeCompare(a))
  const year = options?.year && /^\d{4}$/.test(options.year) ? options.year : years[0] || currentYear
  const month = options?.month && /^(?:all|0[1-9]|1[0-2])$/.test(options.month) ? options.month : 'all'

  const yearNotes = incomeNotes.filter(n => incomeDate(n).startsWith(`${year}-`))
  const periodNotes = (month === 'all' ? yearNotes : yearNotes.filter(n => incomeDate(n).slice(5, 7) === month))
    .slice()
    .sort((a, b) => incomeDate(b).localeCompare(incomeDate(a)) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))

  const receivedNotes = periodNotes.filter(n => n.incomeStatus === 'received')
  const completedNotes = periodNotes.filter(n => n.incomeStatus === 'completed')
  const confirmedNotes = periodNotes.filter(n => (n.incomeStatus || 'confirmed') === 'confirmed')
  const pendingNotes = [...completedNotes, ...confirmedNotes]

  const total = summarizeBucket(periodNotes, usdRate)
  const received = summarizeBucket(receivedNotes, usdRate)
  const pending = summarizeBucket(pendingNotes, usdRate)
  const completed = summarizeBucket(completedNotes, usdRate)
  const confirmed = summarizeBucket(confirmedNotes, usdRate)

  const knownCategories = collectIncomeCategories(incomeNotes, options?.categories)
  for (const n of periodNotes) {
    const cat = n.incomeCategory?.trim() || '其他'
    if (!knownCategories.includes(cat)) knownCategories.push(cat)
  }

  const byCategory: IncomeCategorySummary[] = knownCategories
    .map(category => {
      const catItems = periodNotes.filter(n => (n.incomeCategory?.trim() || '其他') === category)
      const bucket = summarizeBucket(catItems, usdRate)
      const receivedEquivCnyCents = summarizeBucket(catItems.filter(n => n.incomeStatus === 'received'), usdRate).equivCnyCents
      const pendingEquivCnyCents = bucket.equivCnyCents - receivedEquivCnyCents
      const sharePercent = total.equivCnyCents > 0 ? Math.round((bucket.equivCnyCents / total.equivCnyCents) * 100) : 0
      return {
        category,
        ...bucket,
        receivedEquivCnyCents,
        pendingEquivCnyCents,
        sharePercent
      }
    })
    .filter(item => item.count > 0 || (DEFAULT_INCOME_CATEGORIES as readonly string[]).includes(item.category))
    .sort((a, b) => b.equivCnyCents - a.equivCnyCents || b.count - a.count)

  const byMonth: IncomeMonthSummary[] = Array.from({ length: 12 }, (_, idx) => {
    const m = String(idx + 1).padStart(2, '0')
    const mItems = yearNotes.filter(n => incomeDate(n).slice(5, 7) === m)
    const bucket = summarizeBucket(mItems, usdRate)
    const receivedEquivCnyCents = summarizeBucket(mItems.filter(n => n.incomeStatus === 'received'), usdRate).equivCnyCents
    const pendingEquivCnyCents = bucket.equivCnyCents - receivedEquivCnyCents
    return {
      month: m,
      label: `${idx + 1}月`,
      ...bucket,
      receivedEquivCnyCents,
      pendingEquivCnyCents
    }
  })

  return {
    year,
    month,
    usdRate,
    years,
    periodNotes,
    total,
    received,
    pending,
    completed,
    confirmed,
    byCategory,
    byMonth
  }
}
