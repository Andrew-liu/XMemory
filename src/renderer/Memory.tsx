import { RefreshCw, Pause, List, LayoutGrid, Bookmark } from 'lucide-react'
import type { ArchiveProgress, BookmarkGuardInfo, Note } from '../shared/types'
import { bookmarkStopText } from '../shared/bookmarks'

export type MediaFilter = 'all' | 'image' | 'text' | 'partial'
export function memoryMatches(note: Note, query: string, author: string, media: MediaFilter) {
  const haystack = `${note.title}\n${note.body}\n${note.author || ''}\n${note.source || ''}`.toLocaleLowerCase()
  if (query && !haystack.includes(query.normalize('NFKC').toLocaleLowerCase())) return false
  if (author && !note.author?.toLocaleLowerCase().includes(author.toLocaleLowerCase())) return false
  const hasImage = /!\[[^\]]*]\([^)]+\)/.test(note.body)
  if (media === 'image') return hasImage
  if (media === 'text') return !hasImage
  if (media === 'partial') return !!note.partial || note.body.includes('正文可能不完整') || note.body.includes('附件待补抓') || note.body.includes('视频未下载')
  return true
}
export function MemoryToolbar({ status, archive, link, setLink, collect, limit, setLimit, collectBookmarks, bookmarks, query, setQuery, author, setAuthor, media, setMedia, view, setView, pause }: {
  status: string
  archive: ArchiveProgress
  link: string
  setLink: (value: string) => void
  collect: () => void
  limit: 20 | 50 | 100
  setLimit: (value: 20 | 50 | 100) => void
  collectBookmarks: () => void
  bookmarks: BookmarkGuardInfo
  query: string
  setQuery: (value: string) => void
  author: string
  setAuthor: (value: string) => void
  media: MediaFilter
  setMedia: (value: MediaFilter) => void
  view: 'list' | 'card'
  setView: (value: 'list' | 'card') => void
  pause: () => void
}) {
  const active = archive.phase === 'collecting' || archive.phase === 'connecting'
  const phase = archive.phase === 'collecting' ? '采集中' : archive.phase === 'connecting' ? '等待登录' : archive.phase === 'complete' ? '采集完成' : archive.phase === 'partial' ? '采集失败' : archive.phase === 'paused' ? '已暂停' : '待命'
  const cooldownUntil = bookmarks.breaker?.until && Date.parse(bookmarks.breaker.until) > Date.now() ? bookmarks.breaker.until : undefined
  const bookmarksBlocked = !!cooldownUntil || bookmarks.newToday >= bookmarks.dailyLimit
  return <div className="archive-controls">
    <p aria-label="X 登录状态">{status}</p>
    <p aria-label="采集进度">{phase}{archive.lastSuccessAt ? ` · 最近 ${new Date(archive.lastSuccessAt).toLocaleString('zh-CN')}` : ''}</p>
    {archive.mode === 'bookmarks' && <p aria-label="书签采集进度">已检查 {archive.checked || 0} · 新增 {archive.saved || 0} · 已存在 {archive.skipped || 0} · 长文队列 {archive.queued || 0} · 失败 {archive.failed || 0}</p>}
    <p aria-label="图片保存进度">图片已保存 {archive.imagesDone} · 失败 {archive.imagesFailed}{archive.imagesFailed > 0 ? ' · 失败图片保留远程链接，可重新采集重试' : ''}</p>
    <div className="button-row">
      <input aria-label="推文链接" placeholder="粘贴 X 推文或长文链接" value={link} disabled={active} onChange={e => setLink(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && link.trim() && !active) collect() }}/>
      <button className="primary" disabled={active || !link.trim()} onClick={collect}><RefreshCw size={14}/>{active ? (archive.phase === 'connecting' ? '等待登录' : '采集中') : '采集'}</button>
      <select aria-label="本次上限" value={limit} disabled={active} onChange={e => setLimit(Number(e.target.value) as 20 | 50 | 100)}>
        <option value={20}>20</option>
        <option value={50}>50</option>
        <option value={100}>100</option>
      </select>
      <button disabled={active || bookmarksBlocked} onClick={collectBookmarks}><Bookmark size={14}/>采集书签</button>
      <button disabled={!active} onClick={pause}><Pause size={14}/>暂停</button>
    </div>
    <p aria-label="书签额度">今日 {bookmarks.newToday}/{bookmarks.dailyLimit} · 长文 {bookmarks.articlesToday}/{bookmarks.articleLimit} · 历史：{bookmarks.historyComplete ? '已回溯完' : '回溯中'}
      {bookmarks.breaker ? ` · ${bookmarkStopText(`breaker:${bookmarks.breaker.reason}`)}${cooldownUntil ? `，${new Date(cooldownUntil).toLocaleString('zh-CN')} 后可再试` : ''}` : bookmarks.lastStopReason ? ` · ${bookmarkStopText(bookmarks.lastStopReason)}` : ''}</p>
    <div className="memory-filters">
      <input aria-label="筛选书签" placeholder="筛选正文、作者或链接" value={query} onChange={e => setQuery(e.target.value)}/>
      <input aria-label="筛选作者" placeholder="@作者" value={author} onChange={e => setAuthor(e.target.value)}/>
      <select aria-label="媒体类型" value={media} onChange={e => setMedia(e.target.value as MediaFilter)}>
        <option value="all">全部媒体</option>
        <option value="image">有图片/封面</option>
        <option value="text">仅正文</option>
        <option value="partial">正文不完整</option>
      </select>
      <div className="segmented compact-toggle">
        <button aria-pressed={view==='list'} aria-label="列表视图" onClick={() => setView('list')}><List size={14}/></button>
        <button aria-pressed={view==='card'} aria-label="卡片视图" onClick={() => setView('card')}><LayoutGrid size={14}/></button>
      </div>
    </div>
  </div>
}
