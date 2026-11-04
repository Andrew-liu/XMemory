import React, { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Trash2, X } from 'lucide-react'
import type { IncomeCurrency, IncomeStatus, Note, Settings } from '../shared/types'
import { dateKey, validDate } from '../shared/calendar'
import {
  DEFAULT_INCOME_CATEGORIES,
  DEFAULT_USD_RATE,
  amountCents,
  collectIncomeCategories,
  formatCents,
  incomeDate,
  incomeStatusLabels,
  normalizeAmount,
  normalizeUsdRate,
  summarizeIncome,
  toCnyCents
} from '../shared/income'

export type IncomeSubView = 'ledger' | 'stats' | 'entry'
type StatusFilter = 'all' | 'pending' | IncomeStatus

const MONTHS: readonly [string, string][] = [
  ['all', '全年'],
  ['01', '1月'], ['02', '2月'], ['03', '3月'], ['04', '4月'],
  ['05', '5月'], ['06', '6月'], ['07', '7月'], ['08', '8月'],
  ['09', '9月'], ['10', '10月'], ['11', '11月'], ['12', '12月']
]

export function Income({
  notes,
  settings,
  subView,
  setSubView,
  refresh,
  error
}: {
  notes: Note[]
  settings: Settings
  subView: IncomeSubView
  setSubView: (view: IncomeSubView) => void
  refresh: () => Promise<unknown>
  error: (message: string) => void
}) {
  const today = dateKey()
  const [selectedYear, setSelectedYear] = useState(() => today.slice(0, 4))
  const [selectedMonth, setSelectedMonth] = useState<string>(() => today.slice(5, 7))
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [busyId, setBusyId] = useState('')
  const [optimisticStatus, setOptimisticStatus] = useState<Record<string, IncomeStatus>>({})

  // 竖版「记一笔」独立页面表单状态
  const [entryDate, setEntryDate] = useState(today)
  const [entryCategory, setEntryCategory] = useState<string>('厂家商单')
  const [entryTitle, setEntryTitle] = useState('')
  const [entryCurrency, setEntryCurrency] = useState<IncomeCurrency>('CNY')
  const [entryAmount, setEntryAmount] = useState('')
  const [entryStatus, setEntryStatus] = useState<IncomeStatus>('confirmed')
  const [entrySource, setEntrySource] = useState('')
  const [entryBody, setEntryBody] = useState('')
  const [savingEntry, setSavingEntry] = useState(false)

  // 右侧详情面板编辑状态
  const [detailTitle, setDetailTitle] = useState('')
  const [detailDate, setDetailDate] = useState('')
  const [detailCategory, setDetailCategory] = useState('')
  const [detailCurrency, setDetailCurrency] = useState<IncomeCurrency>('CNY')
  const [detailAmount, setDetailAmount] = useState('')
  const [detailSource, setDetailSource] = useState('')
  const [detailBody, setDetailBody] = useState('')
  const [savingDetail, setSavingDetail] = useState(false)

  const usdRate = normalizeUsdRate(settings.usdToCnyRate ?? DEFAULT_USD_RATE)

  const effectiveNotes = useMemo(
    () =>
      notes.map(n =>
        n.kind === 'income' && optimisticStatus[n.id]
          ? { ...n, incomeStatus: optimisticStatus[n.id] }
          : n
      ),
    [notes, optimisticStatus]
  )

  useEffect(() => {
    setOptimisticStatus(prev => {
      if (!Object.keys(prev).length) return prev
      const next = { ...prev }
      let changed = false
      for (const [id, st] of Object.entries(next)) {
        const current = notes.find(n => n.id === id)
        if (!current || current.incomeStatus === st) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [notes])

  const allCategories = useMemo(
    () => collectIncomeCategories(effectiveNotes, settings.incomeCategories),
    [effectiveNotes, settings.incomeCategories]
  )

  const summary = useMemo(
    () =>
      summarizeIncome(effectiveNotes, {
        year: selectedYear,
        month: selectedMonth,
        usdRate,
        categories: settings.incomeCategories
      }),
    [effectiveNotes, selectedYear, selectedMonth, usdRate, settings.incomeCategories]
  )

  const filteredNotes = useMemo(() => {
    const q = searchQuery.trim().toLocaleLowerCase()
    return summary.periodNotes.filter(n => {
      const st = n.incomeStatus || 'confirmed'
      if (statusFilter === 'pending' && st === 'received') return false
      if ((statusFilter === 'confirmed' || statusFilter === 'completed' || statusFilter === 'received') && st !== statusFilter) return false
      const cat = n.incomeCategory?.trim() || '其他'
      if (categoryFilter && cat !== categoryFilter) return false
      if (q && !`${n.title} ${cat} ${n.body} ${n.source || ''}`.toLocaleLowerCase().includes(q)) return false
      return true
    })
  }, [summary.periodNotes, statusFilter, categoryFilter, searchQuery])

  const selectedNote = useMemo(
    () => (selectedId ? effectiveNotes.find(n => n.id === selectedId && n.kind === 'income' && !n.deleted) : undefined),
    [effectiveNotes, selectedId]
  )

  useEffect(() => {
    if (!selectedNote) return
    setDetailTitle(selectedNote.title)
    setDetailDate(incomeDate(selectedNote))
    setDetailCategory(selectedNote.incomeCategory || '其他')
    setDetailCurrency(selectedNote.currency === 'USD' ? 'USD' : 'CNY')
    setDetailAmount(String(selectedNote.amount ?? 0))
    setDetailSource(selectedNote.source || '')
    setDetailBody(selectedNote.body || '')
  }, [selectedNote?.id, selectedNote?.hash])

  async function ensureCustomCategorySaved(category: string) {
    const clean = category.trim()
    if (!clean || (DEFAULT_INCOME_CATEGORIES as readonly string[]).includes(clean)) return
    const existing = settings.incomeCategories || []
    if (existing.includes(clean)) return
    await window.xm.settings({ incomeCategories: [...existing, clean] })
  }

  async function switchStatus(note: Note, nextStatus: IncomeStatus, event: React.MouseEvent) {
    event.stopPropagation()
    const currentStatus = note.incomeStatus || 'confirmed'
    if (currentStatus === nextStatus || busyId === note.id) return
    setOptimisticStatus(prev => ({ ...prev, [note.id]: nextStatus }))
    setBusyId(note.id)
    try {
      const fresh = (await window.xm.snapshot()).notes.find(n => n.id === note.id)
      if (!fresh || fresh.deleted) return
      await window.xm.save(
        {
          ...fresh,
          incomeStatus: nextStatus,
          receivedAt: nextStatus === 'received' ? fresh.receivedAt || new Date().toISOString() : undefined
        },
        fresh.hash
      )
      await refresh()
    } catch (e) {
      setOptimisticStatus(prev => {
        const copy = { ...prev }
        delete copy[note.id]
        return copy
      })
      error((e as Error).message)
    } finally {
      setBusyId('')
    }
  }

  async function submitNewEntry(e: React.FormEvent) {
    e.preventDefault()
    if (savingEntry) return
    const title = entryTitle.trim()
    if (!title) {
      error('请填写事项名称')
      return
    }
    if (!validDate(entryDate)) {
      error('请填写有效的归属日期')
      return
    }
    const parsedAmount = normalizeAmount(entryAmount)
    if (parsedAmount === undefined) {
      error('请填写有效的收入金额（非负数字，最多两位小数）')
      return
    }
    const category = entryCategory.trim() || '其他'
    setSavingEntry(true)
    error('')
    try {
      await ensureCustomCategorySaved(category)
      const created = await window.xm.save({
        kind: 'income',
        title,
        body: entryBody.trim(),
        scheduledDate: entryDate,
        incomeCategory: category,
        currency: entryCurrency,
        amount: parsedAmount,
        incomeStatus: entryStatus,
        source: entrySource.trim() || undefined,
        receivedAt: entryStatus === 'received' ? new Date().toISOString() : undefined
      })
      await refresh()
      setSelectedYear(entryDate.slice(0, 4))
      setSelectedMonth(entryDate.slice(5, 7))
      setStatusFilter('all')
      setCategoryFilter('')
      setEntryTitle('')
      setEntryAmount('')
      setEntrySource('')
      setEntryBody('')
      setSelectedId(created.id)
      setSubView('ledger')
    } catch (err) {
      error((err as Error).message)
    } finally {
      setSavingEntry(false)
    }
  }

  async function saveDetailChanges(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedNote || savingDetail) return
    const title = detailTitle.trim()
    if (!title) {
      error('请填写事项名称')
      return
    }
    if (!validDate(detailDate)) {
      error('请填写有效的归属日期')
      return
    }
    const parsedAmount = normalizeAmount(detailAmount)
    if (parsedAmount === undefined) {
      error('请填写有效的收入金额')
      return
    }
    const category = detailCategory.trim() || '其他'
    setSavingDetail(true)
    error('')
    try {
      await ensureCustomCategorySaved(category)
      const fresh = (await window.xm.snapshot()).notes.find(n => n.id === selectedNote.id)
      if (!fresh || fresh.deleted) return
      await window.xm.save(
        {
          ...fresh,
          title,
          scheduledDate: detailDate,
          incomeCategory: category,
          currency: detailCurrency,
          amount: parsedAmount,
          source: detailSource.trim() || undefined,
          body: detailBody
        },
        fresh.hash
      )
      await refresh()
    } catch (err) {
      error((err as Error).message)
    } finally {
      setSavingDetail(false)
    }
  }

  async function removeSelected(id: string) {
    try {
      await window.xm.remove(id)
      if (selectedId === id) setSelectedId('')
      await refresh()
    } catch (err) {
      error((err as Error).message)
    }
  }

  const maxMonthCents = Math.max(100_00, ...summary.byMonth.map(m => m.equivCnyCents))
  const receivedRatio = summary.total.equivCnyCents > 0
    ? Math.round((summary.received.equivCnyCents / summary.total.equivCnyCents) * 100)
    : 0
  const parsedEntryAmount = normalizeAmount(entryAmount)

  return (
    <div className="income-body">
      <div className="income-main">
        {subView !== 'entry' && (
          <div className="income-period-bar">
            <div className="income-period-controls">
              <select
                aria-label="统计年份"
                className="income-year-select"
                value={summary.year}
                onChange={e => setSelectedYear(e.target.value)}
              >
                {summary.years.map(y => (
                  <option key={y} value={y}>{y} 年</option>
                ))}
              </select>
              <div className="income-month-strip" role="group" aria-label="统计月份">
                {MONTHS.map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={selectedMonth === m}
                    className={selectedMonth === m ? 'active' : ''}
                    onClick={() => setSelectedMonth(m)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="income-kpi-strip" aria-label="当前周期收入速览">
              <div className="income-kpi-item">
                <span>账面总收入</span>
                <strong aria-label="速览总收入">≈ {formatCents(summary.total.equivCnyCents, 'CNY')}</strong>
                <small>({formatCents(summary.total.cnyCents, 'CNY')} + {formatCents(summary.total.usdCents, 'USD')})</small>
              </div>
              <span className="income-kpi-divider" />
              <div className="income-kpi-item ok">
                <span>已到账</span>
                <strong aria-label="速览已到账">≈ {formatCents(summary.received.equivCnyCents, 'CNY')}</strong>
              </div>
              <span className="income-kpi-divider" />
              <div className="income-kpi-item pending">
                <span>待收款</span>
                <strong aria-label="速览待收款">≈ {formatCents(summary.pending.equivCnyCents, 'CNY')}</strong>
              </div>
            </div>
          </div>
        )}

        {/* 视图 1：台账明细（默认首屏，全宽展示列表，不含内嵌录入框） */}
        {subView === 'ledger' && (
          <section className="income-ledger-section" aria-label="台账明细视图">
            <div className="income-ledger-toolbar">
              <div className="income-status-tabs" role="group" aria-label="状态筛选">
                {([
                  ['all', '全部状态'],
                  ['pending', '待收款 (已确定+已完成)'],
                  ['confirmed', '已确定'],
                  ['completed', '已完成'],
                  ['received', '已到账']
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    data-status={id}
                    aria-pressed={statusFilter === id}
                    className={statusFilter === id ? 'active' : ''}
                    onClick={() => setStatusFilter(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="income-ledger-filters">
                <select
                  aria-label="分类筛选"
                  value={categoryFilter}
                  onChange={e => setCategoryFilter(e.target.value)}
                >
                  <option value="">全部分类</option>
                  {allCategories.map(cat => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
                <input
                  aria-label="搜索收入记录"
                  type="search"
                  placeholder="搜索事项、分类或备注…"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                />
              </div>
            </div>

            <table className="income-ledger-table" aria-label="收入明细台账">
              <thead>
                <tr>
                  <th style={{ width: '112px' }}>归属日期</th>
                  <th style={{ width: '122px' }}>收入分类</th>
                  <th>事项与备注</th>
                  <th style={{ width: '196px', textAlign: 'right' }}>金额（原币种 / 折合）</th>
                  <th style={{ width: '216px' }}>状态转换</th>
                </tr>
              </thead>
              <tbody>
                {filteredNotes.map(n => {
                  const date = incomeDate(n)
                  const category = n.incomeCategory?.trim() || '其他'
                  const currency: IncomeCurrency = n.currency === 'USD' ? 'USD' : 'CNY'
                  const origCents = amountCents(n.amount)
                  const equivCents = toCnyCents(n.amount, currency, usdRate)
                  const st: IncomeStatus = n.incomeStatus || 'confirmed'
                  return (
                    <tr
                      key={n.id}
                      data-note-id={n.id}
                      className={`income-ledger-row ${selectedId === n.id ? 'selected' : ''}`}
                      onClick={() => setSelectedId(current => (current === n.id ? '' : n.id))}
                    >
                      <td className="num">{date}</td>
                      <td><span className="income-cat-tag">{category}</span></td>
                      <td>
                        <span className="income-item-title">{n.title}</span>
                        {n.body.trim() && <span className="income-item-note">· {n.body.replace(/\s+/g, ' ').slice(0, 70)}</span>}
                      </td>
                      <td className="income-amount-cell">
                        <span className="income-amount-main">{formatCents(origCents, currency)}</span>
                        {currency === 'USD' && (
                          <span className="income-amount-sub">(≈ {formatCents(equivCents, 'CNY')})</span>
                        )}
                      </td>
                      <td onClick={e => e.stopPropagation()}>
                        <div className="income-status-pill" role="group" aria-label={`${n.title} 状态切换`}>
                          {(['confirmed', 'completed', 'received'] as const).map(targetStatus => (
                            <button
                              key={targetStatus}
                              type="button"
                              aria-pressed={st === targetStatus}
                              disabled={busyId === n.id}
                              className={st === targetStatus ? `active-${targetStatus}` : ''}
                              onClick={e => void switchStatus(n, targetStatus, e)}
                            >
                              {incomeStatusLabels[targetStatus]}
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {!filteredNotes.length && (
                  <tr>
                    <td colSpan={5} className="income-empty-cell">
                      当前周期或筛选条件下暂无收入记录，点击右上角「＋ 记一笔」添加第一笔收入。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        )}

        {/* 视图 2：统计报表（月度 / 年度统计看板） */}
        {subView === 'stats' && (
          <section className="income-stats-section" aria-label="统计报表视图">
            <div className="income-summary-grid">
              <div className="income-summary-card">
                <div className="income-summary-label">
                  <span>账面总收入（含已确定 / 已完成 / 已到账）</span>
                  <span className="badge all">{summary.total.count} 笔</span>
                </div>
                <div className="income-summary-total" aria-label="统计账面总收入">
                  ≈ {formatCents(summary.total.equivCnyCents, 'CNY')}
                </div>
                <div className="income-summary-dual">
                  人民币 {formatCents(summary.total.cnyCents, 'CNY')} · 美元 {formatCents(summary.total.usdCents, 'USD')}
                </div>
                <div className="income-summary-sub">当前所选周期内全部有效收入折合总额</div>
              </div>

              <div className="income-summary-card">
                <div className="income-summary-label">
                  <span>已到账（实际落袋）</span>
                  <span className="badge ok">{summary.received.count} 笔已结清</span>
                </div>
                <div className="income-summary-total" aria-label="统计已到账收入">
                  ≈ {formatCents(summary.received.equivCnyCents, 'CNY')}
                </div>
                <div className="income-summary-dual">
                  人民币 {formatCents(summary.received.cnyCents, 'CNY')} · 美元 {formatCents(summary.received.usdCents, 'USD')}
                </div>
                <div className="income-summary-sub">占当前周期账面总收入 {receivedRatio}%</div>
              </div>

              <div className="income-summary-card">
                <div className="income-summary-label">
                  <span>待收款（已确定 + 已完成）</span>
                  <span className="badge pending">{summary.pending.count} 笔待收</span>
                </div>
                <div className="income-summary-total" aria-label="统计待收款收入">
                  ≈ {formatCents(summary.pending.equivCnyCents, 'CNY')}
                </div>
                <div className="income-summary-dual">
                  人民币 {formatCents(summary.pending.cnyCents, 'CNY')} · 美元 {formatCents(summary.pending.usdCents, 'USD')}
                </div>
                <div className="income-summary-sub">
                  已完成待打款 ≈ {formatCents(summary.completed.equivCnyCents, 'CNY')} · 已确定待交付 ≈ {formatCents(summary.confirmed.equivCnyCents, 'CNY')}
                </div>
              </div>
            </div>

            <div className="income-insights-grid">
              <section className="income-insight-box" aria-label="收入分类构成排行">
                <h2>
                  <span>收入分类构成排行</span>
                  <small>点击分类可跳转台账明细筛选</small>
                </h2>
                <div className="income-category-list">
                  {summary.byCategory.map(item => (
                    <button
                      key={item.category}
                      type="button"
                      className="income-category-row"
                      onClick={() => {
                        setCategoryFilter(item.category)
                        setSubView('ledger')
                      }}
                    >
                      <span className="cat-name">{item.category}</span>
                      <span className="cat-bar-track">
                        <i className="cat-bar-fill" style={{ width: `${item.sharePercent}%` }} />
                      </span>
                      <span className="cat-amount">
                        ≈ {formatCents(item.equivCnyCents, 'CNY')}
                        <small>{item.sharePercent}% ({item.count}笔)</small>
                      </span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="income-insight-box" aria-label="年度各月收入趋势对比">
                <h2>
                  <span>{summary.year} 年 1–12 月收入趋势对比</span>
                  <small>翠绿：已到账 · 琥珀橙：待收款（点击月份筛选）</small>
                </h2>
                <div className="income-months-chart">
                  {summary.byMonth.map(ms => {
                    const recH = Math.round((ms.receivedEquivCnyCents / maxMonthCents) * 90)
                    const pendH = Math.round((ms.pendingEquivCnyCents / maxMonthCents) * 90)
                    const shortVal = ms.equivCnyCents > 0
                      ? `¥${ms.equivCnyCents / 100 >= 1000 ? (ms.equivCnyCents / 100000).toFixed(1) + 'k' : (ms.equivCnyCents / 100).toFixed(0)}`
                      : ''
                    return (
                      <button
                        key={ms.month}
                        type="button"
                        className={`income-m-col ${selectedMonth === ms.month ? 'selected' : ''}`}
                        onClick={() => setSelectedMonth(current => (current === ms.month ? 'all' : ms.month))}
                      >
                        <span className="m-val">{shortVal}</span>
                        <span className="m-stack">
                          {pendH > 0 && <i className="m-bar-pending" style={{ height: `${Math.max(4, pendH)}px` }} />}
                          {recH > 0 && <i className="m-bar-received" style={{ height: `${Math.max(4, recH)}px` }} />}
                        </span>
                        <span className="m-label">{ms.label}</span>
                      </button>
                    )
                  })}
                </div>
              </section>
            </div>

            <section className="income-insight-box" aria-label="各月收入明细汇总表">
              <h2>
                <span>{summary.year} 年各月收入明细汇总表</span>
                <small>点击任意月份行可查看该月台账明细</small>
              </h2>
              <table className="income-ledger-table">
                <thead>
                  <tr>
                    <th>月份</th>
                    <th>笔数</th>
                    <th style={{ textAlign: 'right' }}>人民币原值 (CNY)</th>
                    <th style={{ textAlign: 'right' }}>美元原值 (USD)</th>
                    <th style={{ textAlign: 'right' }}>已到账（折合 ¥）</th>
                    <th style={{ textAlign: 'right' }}>待收款（折合 ¥）</th>
                    <th style={{ textAlign: 'right' }}>月度总计（折合 ¥）</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byMonth
                    .filter(ms => ms.count > 0)
                    .slice()
                    .reverse()
                    .map(ms => (
                      <tr
                        key={ms.month}
                        className="income-ledger-row"
                        onClick={() => {
                          setSelectedMonth(ms.month)
                          setSubView('ledger')
                        }}
                      >
                        <td><strong>{summary.year} 年 {ms.label}</strong></td>
                        <td className="num">{ms.count} 笔</td>
                        <td className="income-amount-cell">{formatCents(ms.cnyCents, 'CNY')}</td>
                        <td className="income-amount-cell">{formatCents(ms.usdCents, 'USD')}</td>
                        <td className="income-amount-cell" style={{ color: 'var(--success)' }}>
                          ≈ {formatCents(ms.receivedEquivCnyCents, 'CNY')}
                        </td>
                        <td className="income-amount-cell" style={{ color: 'var(--warning)' }}>
                          ≈ {formatCents(ms.pendingEquivCnyCents, 'CNY')}
                        </td>
                        <td className="income-amount-cell">
                          <strong>≈ {formatCents(ms.equivCnyCents, 'CNY')}</strong>
                        </td>
                      </tr>
                    ))}
                  {!summary.byMonth.some(ms => ms.count > 0) && (
                    <tr>
                      <td colSpan={7} className="income-empty-cell">{summary.year} 年暂无收入记录</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>
          </section>
        )}

        {/* 视图 3：全幅竖版独立「记一笔」页面（直接占满工作区，无贴纸外框） */}
        {subView === 'entry' && (
          <section className="income-entry-page" aria-label="记一笔收入">
            <div className="income-entry-header">
              <div>
                <span className="eyebrow">新增台账记录</span>
                <h2>记一笔收入</h2>
              </div>
              <button type="button" className="secondary" onClick={() => setSubView('ledger')}>
                ← 返回台账明细
              </button>
            </div>

            <form className="income-vertical-form" onSubmit={e => void submitNewEntry(e)}>
              <div className="income-v-field">
                <label htmlFor="income-entry-date">
                  归属日期 <span className="hint">按此日期归入对应月份与年度统计</span>
                </label>
                <input
                  id="income-entry-date"
                  aria-label="归属日期"
                  type="date"
                  value={entryDate}
                  onChange={e => setEntryDate(e.target.value)}
                  required
                />
              </div>

              <div className="income-v-field">
                <label htmlFor="income-entry-category">
                  收入分类 <span className="hint">点击下方常用分类，或直接输入新分类名称</span>
                </label>
                <div className="income-cat-pills" role="group" aria-label="常用收入分类">
                  {allCategories.map(cat => (
                    <button
                      key={cat}
                      type="button"
                      aria-pressed={entryCategory.trim() === cat}
                      className={entryCategory.trim() === cat ? 'active' : ''}
                      onClick={() => setEntryCategory(cat)}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
                <input
                  id="income-entry-category"
                  aria-label="收入分类"
                  list="income-category-datalist"
                  value={entryCategory}
                  onChange={e => setEntryCategory(e.target.value)}
                  placeholder="选择或输入自定义分类（如：X工资、厂家商单、tutti商单、VPS分成、VPN分成）"
                  required
                />
                <datalist id="income-category-datalist">
                  {allCategories.map(cat => (
                    <option key={cat} value={cat} />
                  ))}
                </datalist>
              </div>

              <div className="income-v-field">
                <label htmlFor="income-entry-title">事项名称 / 合作内容</label>
                <input
                  id="income-entry-title"
                  aria-label="事项名称"
                  type="text"
                  value={entryTitle}
                  onChange={e => setEntryTitle(e.target.value)}
                  placeholder="例如：11月上半月 X 创作者分成 / 某品牌新品首发推文"
                  required
                />
              </div>

              <div className="income-v-field">
                <label htmlFor="income-entry-amount">币种与金额</label>
                <div className="income-amount-row">
                  <select
                    aria-label="币种"
                    value={entryCurrency}
                    onChange={e => setEntryCurrency(e.target.value as IncomeCurrency)}
                  >
                    <option value="CNY">CNY ¥（人民币）</option>
                    <option value="USD">USD $（美元）</option>
                  </select>
                  <input
                    id="income-entry-amount"
                    aria-label="金额"
                    type="number"
                    step="0.01"
                    min="0"
                    value={entryAmount}
                    onChange={e => setEntryAmount(e.target.value)}
                    placeholder="输入金额（如 3500 或 420.50）"
                    required
                  />
                </div>
                <div className="income-equiv-preview">
                  {entryCurrency === 'CNY'
                    ? parsedEntryAmount !== undefined && parsedEntryAmount > 0
                      ? `入账金额：${formatCents(amountCents(parsedEntryAmount), 'CNY')}（人民币）`
                      : '人民币直接入账'
                    : parsedEntryAmount !== undefined && parsedEntryAmount > 0
                      ? `按当前参考汇率 (1 USD = ${usdRate} CNY) 折合人民币 ≈ ${formatCents(toCnyCents(parsedEntryAmount, 'USD', usdRate), 'CNY')}`
                      : `美元入账，统计时按参考汇率 (1 USD = ${usdRate} CNY) 折算汇总`}
                </div>
              </div>

              <div className="income-v-field">
                <label>当前状态</label>
                <div className="income-entry-status-picker" role="group" aria-label="初始状态选择">
                  {([
                    ['confirmed', '已确定（待交付）'],
                    ['completed', '已完成（待打款）'],
                    ['received', '已到账（已结清）']
                  ] as const).map(([st, label]) => (
                    <button
                      key={st}
                      type="button"
                      aria-pressed={entryStatus === st}
                      className={entryStatus === st ? `active-${st}` : ''}
                      onClick={() => setEntryStatus(st)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="income-v-field">
                <label htmlFor="income-entry-source">
                  关联链接 <span className="hint">可选，填写合作推文或结算单链接</span>
                </label>
                <input
                  id="income-entry-source"
                  aria-label="关联链接"
                  type="url"
                  value={entrySource}
                  onChange={e => setEntrySource(e.target.value)}
                  placeholder="https://x.com/..."
                />
              </div>

              <div className="income-v-field">
                <label htmlFor="income-entry-body">
                  备注与交付说明 <span className="hint">可选，保存为 Markdown 正文</span>
                </label>
                <textarea
                  id="income-entry-body"
                  aria-label="备注与交付说明"
                  rows={5}
                  value={entryBody}
                  onChange={e => setEntryBody(e.target.value)}
                  placeholder="记录排期要求、对接人、打款方式或结算说明…"
                />
              </div>

              <div className="income-entry-actions">
                <button type="button" className="secondary" onClick={() => setSubView('ledger')}>
                  取消
                </button>
                <button type="submit" className="primary" disabled={savingEntry}>
                  保存并记入台账
                </button>
              </div>
            </form>
          </section>
        )}
      </div>

      {/* 右侧详情面板：默认收起，仅在台账明细中点击某行时展开 */}
      {subView === 'ledger' && selectedNote && (
        <aside className="income-detail-pane" aria-label="台账详情">
          <div className="income-detail-header">
            <span className="eyebrow">台账详情 · Markdown</span>
            <button
              type="button"
              className="secondary"
              aria-label="收起详情"
              onClick={() => setSelectedId('')}
            >
              <X size={14} /> 收起
            </button>
          </div>
          <h3>{selectedNote.title}</h3>
          <form className="income-detail-form" onSubmit={e => void saveDetailChanges(e)}>
            <label>
              事项名称
              <input
                aria-label="详情事项名称"
                type="text"
                value={detailTitle}
                onChange={e => setDetailTitle(e.target.value)}
              />
            </label>
            <label>
              归属日期
              <input
                aria-label="详情归属日期"
                type="date"
                value={detailDate}
                onChange={e => setDetailDate(e.target.value)}
              />
            </label>
            <label>
              收入分类
              <input
                aria-label="详情收入分类"
                list="income-category-datalist"
                value={detailCategory}
                onChange={e => setDetailCategory(e.target.value)}
              />
            </label>
            <div className="income-detail-amount-grid">
              <label>
                币种
                <select
                  aria-label="详情币种"
                  value={detailCurrency}
                  onChange={e => setDetailCurrency(e.target.value as IncomeCurrency)}
                >
                  <option value="CNY">CNY ¥</option>
                  <option value="USD">USD $</option>
                </select>
              </label>
              <label>
                金额
                <input
                  aria-label="详情金额"
                  type="number"
                  step="0.01"
                  min="0"
                  value={detailAmount}
                  onChange={e => setDetailAmount(e.target.value)}
                />
              </label>
            </div>
            <label>
              关联链接
              <input
                aria-label="详情关联链接"
                type="url"
                placeholder="https://x.com/..."
                value={detailSource}
                onChange={e => setDetailSource(e.target.value)}
              />
            </label>
            {selectedNote.source && (
              <div>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => void window.xm.external(selectedNote.source!).catch(err => error(err.message))}
                >
                  打开关联链接 <ExternalLink size={12} />
                </button>
              </div>
            )}
            <label>
              备注与交付说明
              <textarea
                aria-label="详情备注说明"
                rows={4}
                value={detailBody}
                onChange={e => setDetailBody(e.target.value)}
                placeholder="记录商单要求、联系人、打款方式等…"
              />
            </label>
            <div className="income-detail-meta">
              <div>
                当前状态：<strong>{incomeStatusLabels[selectedNote.incomeStatus || 'confirmed']}</strong>
              </div>
              {selectedNote.receivedAt && (
                <div>到账时间：{new Date(selectedNote.receivedAt).toLocaleString('zh-CN')}</div>
              )}
              <div>存储位置：<code>{selectedNote.path}</code></div>
            </div>
            <div className="income-detail-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => void removeSelected(selectedNote.id)}
              >
                <Trash2 size={14} /> 移入回收站
              </button>
              <button type="submit" className="primary" disabled={savingDetail}>
                保存修改
              </button>
            </div>
          </form>
        </aside>
      )}
    </div>
  )
}
