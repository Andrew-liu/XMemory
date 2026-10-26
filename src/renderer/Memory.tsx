import { Pause, Play, Search } from 'lucide-react'
import type { ArchiveProgress, AutoCollectState, BookmarkGuardInfo, Note, PartialRetryInfo } from '../shared/types'
import { bookmarkStopText } from '../shared/bookmarks'

export const PARTIAL_KEYWORD = '不完整'
export const AUTO_CONFIRM = '同一个 X 账号只在一台电脑上开启。多台同时采集会让访问量翻倍，增加风控风险，同步时也更容易冲突。\n\n每小时采集一次，每天最多新增 200 条。\n\n确定在这台电脑上开启自动采集吗？'
export const AUTO_TIP = '同一个 X 账号只在一台电脑上开启，多台同时采集会增加风控风险，同步也更容易冲突。'

export function isPartialMemory(note: Note) {
  return !!note.partial || note.body.includes('正文可能不完整') || note.body.includes('附件待补抓')
}

export interface ParsedMemoryQuery { authors: string[]; terms: string[]; partial: boolean }
export function parseMemoryQuery(input: string): ParsedMemoryQuery {
  const parsed: ParsedMemoryQuery = { authors: [], terms: [], partial: false }
  for (const raw of input.normalize('NFKC').trim().split(/\s+/)) {
    if (!raw) continue
    const word = raw.toLocaleLowerCase()
    if (word === PARTIAL_KEYWORD) parsed.partial = true
    else if (word.startsWith('@')) { if (word.length > 1) parsed.authors.push(word.slice(1)) }
    else parsed.terms.push(word)
  }
  return parsed
}

export function memoryMatches(note: Note, query: string) {
  const parsed = parseMemoryQuery(query)
  if (parsed.partial && !isPartialMemory(note)) return false
  const author = (note.author || '').normalize('NFKC').toLocaleLowerCase()
  if (parsed.authors.some(name => !author.includes(name))) return false
  if (!parsed.terms.length) return true
  const haystack = `${note.title}\n${note.body}\n${note.source || ''}`.normalize('NFKC').toLocaleLowerCase()
  return parsed.terms.every(term => haystack.includes(term))
}

export function retryStatus(info?: PartialRetryInfo) {
  if (!info) return '等待自动补采'
  if (info.result === 'review') return `需要手动对照原文${info.reason ? `：${info.reason}` : ''}`
  const last = info.lastAttemptAt ? `上次补采：${new Date(info.lastAttemptAt).toLocaleString('zh-CN')}。` : ''
  if (info.attempts >= 3) return `${last}自动补采已达 3 次，请手动检查原文。${info.reason || ''}`
  const next = info.nextAt ? `下次可尝试：${new Date(info.nextAt).toLocaleString('zh-CN')}。` : '等待下一轮自动采集。'
  return `${last}${info.reason ? `${info.reason}。` : ''}${next}`
}

const clock = (iso?: string) => iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''

export interface AutoStatusView { text: string; action: 'pause' | 'enable'; progress?: number; login?: boolean; detail: string }
export function autoStatus(auto: AutoCollectState, bookmarks: BookmarkGuardInfo, archive: ArchiveProgress, xStatus: string, now = Date.now()): AutoStatusView {
  const details = [
    `今日新增 ${bookmarks.newToday}/${bookmarks.dailyLimit} · 长文 ${bookmarks.articlesToday}/${bookmarks.articleLimit}`,
    `图片已保存 ${archive.imagesDone} · 图片失败 ${archive.imagesFailed}`,
    archive.mode === 'bookmarks' ? `最近一轮：已检查 ${archive.checked || 0} · 新增 ${archive.saved || 0} · 已存在 ${archive.skipped || 0} · 失败 ${archive.failed || 0}` : '',
    bookmarks.lastStopReason ? `上次结束原因：${bookmarkStopText(bookmarks.lastStopReason)}` : '',
    auto.skip?.message ? `跳过原因：${auto.skip.reason === 'cooldown' ? bookmarkStopText(`breaker:${auto.skip.message}`) : auto.skip.message}` : '',
    `Chrome：${xStatus}`
  ].filter(Boolean)
  const detail = details.join('\n')
  if (!auto.enabled) {
    const last = auto.lastRun ? ` · 上次 ${clock(auto.lastRun.at)} 新增 ${auto.lastRun.created} 条` : bookmarks.lastRunAt ? ` · 上次 ${clock(bookmarks.lastRunAt)}` : ''
    return { text: `自动采集未开启${last}`, action: 'enable', detail }
  }
  if (auto.active) {
    if (archive.mode === 'single') return { text: '正在补采不完整记忆', action: 'pause', detail }
    const limit = auto.limit || 100
    return { text: `正在采集 · 已检查 ${archive.checked || 0} · 新增 ${archive.saved || 0} · 长文 ${bookmarks.articlesToday}/${bookmarks.articleLimit}`, action: 'pause', progress: Math.min(1, (archive.saved || 0) / limit), detail }
  }
  const skip = auto.skip
  if (skip?.reason === 'login') return { text: '未登录 X，自动采集已跳过', action: 'pause', login: true, detail }
  if (skip?.reason === 'cooldown' && skip.until && Date.parse(skip.until) > now) return { text: `X 限流冷却中，${clock(skip.until)} 后自动恢复`, action: 'pause', detail }
  if (bookmarks.newToday >= bookmarks.dailyLimit) return { text: '今日额度已满，明天继续', action: 'pause', detail }
  const next = auto.nextRunAt ? ` · 下次约 ${clock(auto.nextRunAt)}` : ''
  return { text: `自动采集中${next} · 今日 ${bookmarks.newToday}/${bookmarks.dailyLimit} · 历史${bookmarks.historyComplete ? '已回溯完' : '回溯中'}`, action: 'pause', detail }
}

export function AutoCollectBar({ view, toggle, login }: { view: AutoStatusView; toggle: () => void; login: () => void }) {
  return <div className="auto-collect" title={view.detail}>
    <div className="auto-collect-row">
      <span className="auto-collect-text" aria-label="自动采集状态">{view.text}{view.login && <> · <button className="link-button" onClick={login}>去登录</button></>}</span>
      {view.action === 'pause'
        ? <button onClick={toggle}><Pause size={14}/>暂停</button>
        : <button className="primary" onClick={toggle}><Play size={14}/>开启自动采集</button>}
    </div>
    {view.progress !== undefined && <div className="auto-collect-progress" role="progressbar" aria-label="本轮采集进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(view.progress * 100)}><i style={{ width: `${Math.round(view.progress * 100)}%` }}/></div>}
  </div>
}

export function MemorySearch({ query, setQuery, partialCount }: { query: string; setQuery: (value: string) => void; partialCount: number }) {
  return <div className="memory-search">
    {!query && partialCount > 0 && <button className="link-button" onClick={() => setQuery(PARTIAL_KEYWORD)}>{partialCount} 条不完整</button>}
    <div className="search-field"><Search size={15}/><input aria-label="搜索记忆" placeholder="搜索正文或链接，@作者 按作者搜索" value={query} onChange={e => setQuery(e.target.value)}/></div>
  </div>
}
