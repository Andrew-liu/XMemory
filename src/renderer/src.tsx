import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Search, Lightbulb, Layers, Feather, Settings2, Plus, PanelLeft, ArrowUpRight, RefreshCw, Trash2, FolderOpen, Sun, Moon, Monitor, X, GitBranch, AlertCircle, Check } from 'lucide-react'
import type { Note, Snapshot, Kind, SearchHit, Conflict } from '../shared/types'
import { NoteEditor, type EditorHandle } from './Editor'

import '@fontsource/noto-serif-sc/400.css'
import '@fontsource/noto-serif-sc/600.css'
import './style.css'
import { Topics } from './Topics'
import { topicTemplate } from '../shared/topics'
import { Calendar } from './Calendar'
import { AutoCollectBar, AUTO_CONFIRM, AUTO_TIP, MemorySearch, autoStatus, compareMemoryTime, isPartialMemory, memoryAuthorQuery, memoryHighlightQuery, memoryMatches, retryStatus } from './Memory'
import { dateKey, noteDate } from '../shared/calendar'
import { matchSnippet, splitDifference, splitMatches, stableOrder } from './highlight'
import { conflictFields, normalizeLines } from '../shared/conflicts'
import { applyCachedTheme, applyTheme, watchSystemTheme } from './themes'

type Page = Exclude<Kind, 'draft'> | 'search' | 'settings' | 'conflicts' | 'trash'
const titles: Record<Page | Kind,string> = { inspiration: '灵感', memory: '记忆', draft: '候选稿', topic: '选题', search: '搜索', settings: '设置', conflicts: '冲突', trash: '回收站' }
function HighlightedText({ text, query }: { text: string; query: string }) {
  return <>{splitMatches(text, query).map((segment, index) => segment.highlighted ? <mark key={index}>{segment.text}</mark> : <React.Fragment key={index}>{segment.text}</React.Fragment>)}</>
}
function ConflictComparison({ current, incoming }: { current: string; incoming: string }) {
  const [left, right] = splitDifference(current, incoming)
  const render = (segments: ReturnType<typeof splitMatches>) => segments.map((segment, index) => segment.highlighted ? <mark key={index}>{segment.text}</mark> : <React.Fragment key={index}>{segment.text}</React.Fragment>)
  return <div className="conflict-columns"><div><h3>版本 A · 当前文件</h3><pre>{render(left)}</pre></div><div><h3>版本 B · 待合并内容</h3><pre>{render(right)}</pre></div></div>
}
function ConflictDetails({ conflict: c }: { conflict: Conflict }) {
  const fields = conflictFields(c)
  const left = normalizeLines(c.current.body), right = normalizeLines(c.incoming.body)
  const sameBody = left === right
  const whitespaceOnly = !sameBody && left.replace(/\s/g, '') === right.replace(/\s/g, '')
  const visible = (text: string) => text.replace(/ /g, '·').replace(/\t/g, '→').replace(/\n/g, '↵\n')
  return <>
    {sameBody && <p className="conflict-explanation">正文相同。{fields.length ? '差异在下方附加字段中。' : c.currentRaw && c.incomingRaw ? '请核对完整文件信息。' : '这是旧版冲突记录，未保存完整文件信息，无法确认是否仅有格式差异；不会自动丢弃任一版本。'}</p>}
    {fields.length > 0 && <div className="conflict-fields"><h3>附加字段差异</h3><table><thead><tr><th>字段</th><th>版本 A</th><th>版本 B</th></tr></thead><tbody>{fields.map(field => <tr key={field.key}><th>{field.key}</th><td>{field.current}</td><td>{field.incoming}</td></tr>)}</tbody></table></div>}
    {whitespaceOnly && <p>正文仅空白字符不同：· 表示空格，→ 表示制表符，↵ 表示换行。Markdown 中空格可能影响排版，请确认后选择。</p>}
    <ConflictComparison current={whitespaceOnly ? visible(left) : left} incoming={whitespaceOnly ? visible(right) : right}/>
  </>
}
function App() {
  const [state, setState] = useState<Snapshot>()
  const [page, setPage] = useState<Page>('inspiration')
  const [selected, setSelected] = useState('')
  const [searchLocation, setSearchLocation] = useState<{ query: string; request: number }>()
  const [calendarDate, setCalendarDate] = useState(dateKey())
  const [calendarMode, setCalendarMode] = useState<'week'|'month'>('week')
  const [topicBusy, setTopicBusy] = useState(false)
  const topicOperation = useRef(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [author, setAuthor] = useState('')
  const [tag, setTag] = useState('')
  const [sort, setSort] = useState<'relevance'|'date'>('relevance')
  const [hits, setHits] = useState<{ key: string; items: SearchHit[] }>({ key: '', items: [] })
  const [error, setError] = useState('')
  const [runStatus, setRunStatus] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [repoOpen, setRepoOpen] = useState(false)
  const [githubKey, setGithubKey] = useState('')

  const [memoryQuery, setMemoryQuery] = useState('')
  const [recollecting, setRecollecting] = useState(false)
  const editor = useRef<EditorHandle>(null)
  useEffect(() => window.xm.onBeforeClose(async recover => { if (recover) await editor.current?.recover(); else await editor.current?.flush() }), [])
  const searchInput = useRef<HTMLInputElement>(null)
  const refresh = () => window.xm.snapshot().then(setState).catch(e => setError(e.message))
  // Editor autosaves are quiet: patch the one saved note locally instead of re-pulling the whole library.
  const savedNote = (saved: Note) => setState(current => current && ({ ...current, notes: current.notes.some(n => n.id === saved.id) ? current.notes.map(n => n.id === saved.id ? saved : n) : [...current.notes, saved] }))
  const act = (promise: Promise<unknown>) => promise.then(() => refresh()).catch(e => setError(e.message))
  useEffect(() => { void refresh(); return window.xm.onChange(() => { void refresh() }) }, [])
  useEffect(() => {
    if (!state) return
    const mode = state.settings.theme || 'system', palette = state.settings.palette
    const apply = () => { applyTheme(mode, palette) }
    apply(); return watchSystemTheme(apply)
  }, [state?.settings.theme, state?.settings.palette])
  useEffect(() => { const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); void go('search').then(() => searchInput.current?.focus()) } }; addEventListener('keydown', key); return () => removeEventListener('keydown', key) }, [])
  useEffect(() => {
    let alive = true
    const key = JSON.stringify([query, filter, dateFrom, dateTo, author, tag, sort])
    const timer = setTimeout(() => { void window.xm.search({ query, kind: (filter || undefined) as Kind|undefined, author: author || undefined, tag: tag || undefined, from: dateFrom || undefined, to: dateTo || undefined, sort }).then(v => { if (alive) setHits({ key, items: v }) }).catch(e => setError(e.message)) }, 150)
    return () => { alive = false; clearTimeout(timer) }
  }, [query, filter, dateFrom, dateTo, author, tag, sort, state?.notes])
  // Opening or autosaving a note changes its updatedAt; without this the clicked item jumps while the user is reading the list.
  const listOrder = useRef<{ key: string; ids: string[] }>({ key: '', ids: [] })
  async function go(next: Page) { try { await editor.current?.flush(); setPage(next); setSelected(''); setSearchLocation(undefined); setRunStatus('') } catch(e) { setError((e as Error).message) } }
  async function open(id: string, locateQuery?: string) { try { await editor.current?.flush(); setSelected(id); setSearchLocation(locateQuery?.trim() ? { query: locateQuery, request: Date.now() } : undefined); setRunStatus('') } catch(e) { setError((e as Error).message) } }
  async function create() { try { await editor.current?.flush(); const today = dateKey(); const n = await window.xm.save({ kind: 'inspiration', title: '未命名灵感', body: '', scheduledDate: today }); await refresh(); setCalendarDate(today); setPage('inspiration'); setSearchLocation(undefined); setSelected(n.id) } catch(e) { setError((e as Error).message) } }
  async function complete(id = selected) { if (topicOperation.current) return; topicOperation.current = true; setTopicBusy(true); try { await editor.current?.flush(); const fresh = (await window.xm.snapshot()).notes.find(n=>n.id===id); if (fresh && !fresh.deleted) { await window.xm.save({ ...fresh, completed: !fresh.completed }, fresh.hash); await refresh() } } catch(e) { setError((e as Error).message) } finally { topicOperation.current = false; setTopicBusy(false) } }

  async function createTopic(title: string): Promise<boolean> {
    if (!title.trim() || topicOperation.current) return false
    topicOperation.current = true; setTopicBusy(true)
    try {
      await editor.current?.flush()
      const created = await window.xm.save({ kind: 'topic', title: title.trim(), body: topicTemplate })
      await refresh(); setPage('topic'); setSearchLocation(undefined); setSelected(created.id); setRunStatus('')
      return true
    } catch (e) { setError((e as Error).message); return false }
    finally { topicOperation.current = false; setTopicBusy(false) }
  }

  const note = state?.notes.find(n => n.id === selected)
  const notes = state?.notes.filter(n => page === 'trash' ? n.deleted : !n.deleted && n.kind === page).filter(n => page !== 'memory' || memoryMatches(n, memoryQuery)).sort((a,b) => page === 'memory' ? compareMemoryTime(a, b) : b.updatedAt.localeCompare(a.updatedAt)) || []
  const listKey = page === 'search' ? `search|${hits.key}` : `${page}|${page === 'memory' ? memoryQuery : ''}`
  const rawList: (Note | SearchHit)[] = page === 'search' ? hits.items : notes
  const shownList = listOrder.current.key === listKey ? stableOrder(listOrder.current.ids, rawList) : rawList
  listOrder.current = { key: listKey, ids: shownList.map(n => n.id) }
  const markQuery = page === 'search' ? query : page === 'memory' ? memoryHighlightQuery(memoryQuery) : ''
  const authorMark = page === 'memory' ? memoryAuthorQuery(memoryQuery) : ''
  const memoryView = state?.settings.memoryView === 'card' ? 'card' : 'list'
  const partialCount = state?.notes.filter(n => n.kind === 'memory' && !n.deleted && isPartialMemory(n)).length || 0
  const collectingNow = !!state?.auto.active || recollecting
  function setAutoCollect(enabled: boolean) {
    if (enabled && !window.confirm(AUTO_CONFIRM)) return
    void act(window.xm.setAutoCollect(enabled))
  }
  async function recollectNote(id: string) {
    if (collectingNow) return
    setRecollecting(true); setError('')
    try {
      await editor.current?.flush()
      const saved = await window.xm.recollect(id)
      const latest = await window.xm.snapshot()
      setState(latest)
      const updated = latest.notes.find(item => item.id === id)
      setRunStatus(updated && isPartialMemory(updated)
        ? '重新采集后正文仍不完整，请检查原文或等待下次补采'
        : saved.result === 'unchanged' ? '重新采集完成：内容无变化' : '重新采集完成：已更新')
    } catch (e) { setError((e as Error).message) }
    finally { setRecollecting(false) }
  }
  async function connectRepository(action: 'save' | 'sync') {
    if (!state || connecting) return
    const fromForm = action === 'save'
    if (fromForm) setRepoOpen(true)
    setConnecting(true); setError('')
    try {
      const hasKey = !!githubKey.trim() || !!state.settings.hasGithubKey
      await window.xm.settings({ repo: state.settings.repo, branch: state.settings.branch }, githubKey.trim() ? { githubKey: githubKey.trim() } : undefined)
      setGithubKey('')
      if (fromForm && hasKey && state.settings.repo?.trim()) { await window.xm.checkSync(); setRepoOpen(false) }
      if (action === 'sync') await window.xm.sync()
      await refresh()
    } catch (e) { setError((e as Error).message); await refresh().catch(() => {}) }
    finally { setConnecting(false) }
  }

  if (!state) return <div className="boot"><span className="brand-mark" aria-hidden="true"/><p>{error || '正在打开本地资料库…'}</p></div>
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark" aria-hidden="true"/><strong>XMemeory</strong></div>
      <button className="sidebar-search" onClick={() => void go('search')}><Search size={15}/><span>搜索所有内容</span><kbd>⌘ K</kbd></button>
      <div className="nav-label">工作区</div>
      <nav>{([['inspiration',Lightbulb],['memory',Layers],['topic',Feather]] as const).map(([id, Icon]) => <button key={id} className={page === id ? 'selected' : ''} onClick={() => void go(id)}><Icon size={16} strokeWidth={1.6}/><span>{titles[id]}</span><small>{state.notes.filter(n => n.kind === id && !n.deleted).length}</small></button>)}</nav>
      <div className="sidebar-note"><p className="motto">捕捉一闪而过的想法<br/>让值得留下的内容<br/>成为下一次创作的起点</p></div>
      <div className="sidebar-bottom">
        {state.conflicts.length > 0 && <button onClick={() => void go('conflicts')}><GitBranch size={17}/><span>待处理冲突</span><small>{state.conflicts.length}</small></button>}
        <button onClick={() => void go('trash')}><Trash2 size={16}/><span>回收站</span></button>
        <button className={page === 'settings' ? 'selected' : ''} onClick={() => void go('settings')}><Settings2 size={17}/><span>设置</span></button>
        <div className="local-status"><i/><span>本地优先 · 私人工作区</span></div>
      </div>
    </aside>
    <main className="workspace">
      <header className="workspace-header"><PanelLeft size={17}/><span>{titles[page]}</span><div className="spacer"/>{page === 'memory' ? <MemorySearch query={memoryQuery} setQuery={setMemoryQuery} partialCount={partialCount}/> : <><span className="quiet">让想法有迹可循</span><button className="primary compact" onClick={() => page === 'topic' ? void createTopic('未命名选题') : void create()} disabled={topicBusy}><Plus size={16}/>{page === 'topic' ? '新选题' : '新灵感'}</button></>}</header>
      {error && <div className="error-banner" role="alert"><AlertCircle size={16}/><span>{error}</span><button aria-label="关闭提示" title="关闭提示" onClick={() => setError('')}><X size={15}/></button></div>}
      {state.status && <div className="error-banner notice">{state.status}</div>}
      {page === 'settings' ? <div className="settings-page">
        <div className="section-heading"><span className="eyebrow">偏好与连接</span><h1>你的工作区，按你的方式。</h1><p>内容保存在本机，连接由你控制。</p></div>
        <section className="settings-section"><h2>外观</h2><h3 className="settings-subtitle">明暗模式</h3><div className="theme-options">{([['system',Monitor,'跟随系统'],['light',Sun,'浅色'],['dark',Moon,'深色']] as const).map(([id, Icon, label]) => <button key={id} className={state.settings.theme === id ? 'chosen' : ''} aria-pressed={state.settings.theme === id} onClick={() => void act(window.xm.settings({ theme: id }))}><Icon size={20} strokeWidth={1.5}/>{label}</button>)}</div><h3 className="settings-subtitle">记忆视图</h3><div className="segmented view-options" role="group" aria-label="记忆视图">{([['list','列表'],['card','卡片']] as const).map(([id, label]) => <button key={id} aria-pressed={memoryView === id} onClick={() => void act(window.xm.settings({ memoryView: id }))}>{label}</button>)}</div><label className="check-label"><input type="checkbox" checked={state.settings.closeToTray} onChange={e => void act(window.xm.settings({ closeToTray: e.target.checked }))}/>关闭窗口后驻留托盘</label><label className="check-label"><input type="checkbox" checked={!!state.settings.openAtLogin} disabled={!state.settings.openAtLoginAvailable} onChange={e => void act(window.xm.setOpenAtLogin(e.target.checked))}/>开机时自动启动{!state.settings.openAtLoginAvailable && <span className="quiet">（仅安装版可用）</span>}</label></section>
        <section className="settings-section"><h2>资料库</h2><p className="path-text">{state.library}</p><div className="button-row"><button onClick={() => void act(window.xm.openLibrary())}><FolderOpen size={16}/>打开文件夹</button><button onClick={() => void act(window.xm.selectLibrary())}>选择资料库</button></div><p>Markdown 正文与图片保存在资料库中，支持外部编辑后重新读取。</p></section>
        <section className="settings-section"><h2>X 采集</h2><div className="setting-row"><span className="setting-label">X 账号</span><span className={`status-dot ${state.xLogin?.ok ? 'ok' : ''}`}/><span className="setting-status" aria-label="X 账号状态">{state.xLogin?.ok ? `已登录 · ${new Date(state.xLogin.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} 确认` : state.xLogin ? '未登录' : '尚未确认登录'}</span>{!state.xLogin?.ok && <button className="primary" onClick={() => void act(window.xm.loginX())}>登录 X</button>}<button onClick={() => void act(window.xm.connectX())}>检查登录</button></div><p className="setting-detail" aria-label="X 登录状态">{state.xStatus}{/验证/.test(state.xStatus) && <> · <button className="link-button" onClick={() => void act(window.xm.showX())}>显示 Chrome</button></>}</p><div className="setting-row"><span className="setting-label">自动采集</span><label className="switch"><input type="checkbox" role="switch" aria-label="在这台电脑上自动采集书签" checked={!!state.settings.autoCollect} onChange={e => setAutoCollect(e.target.checked)}/><i/></label><span className="setting-status">每小时采集新书签，每天最多 200 条</span></div><p className="setting-detail settings-tip">{AUTO_TIP}</p><details className="settings-advanced"><summary>高级</summary><div className="button-row"><button onClick={() => void act(window.xm.showX())}>显示 Chrome</button><button onClick={() => void act(window.xm.disconnectX())}>关闭 CDP Chrome</button></div><p>使用独立的正式版 Chrome Profile 保存 X 登录态，每轮采集结束后 Chrome 会自动关闭；首次登录和安全验证需在 Chrome 中手动完成，应用不会读取日常 Chrome 的 Cookie。自动采集设置只在本机生效，不随 GitHub 同步；不完整的记忆可在详情页右上角重新采集。</p></details></section>
        <section className="settings-section"><h2>GitHub 同步</h2>{(() => {
          const connected = !!state.settings.repo && !!state.settings.hasGithubKey
          const cancelEdit = () => { setGithubKey(''); setRepoOpen(false); void refresh() }
          const form = <div className="repo-form"><div className="form-grid"><label>私有仓库<input placeholder="owner/repo 或 GitHub 完整 URL" value={state.settings.repo || ''} onChange={e => setState({ ...state, settings: { ...state.settings, repo: e.target.value } })}/></label><label>分支<input value={state.settings.branch} onChange={e => setState({ ...state, settings: { ...state.settings, branch: e.target.value } })}/></label><label className="full">访问 Token<input type="password" autoComplete="off" value={githubKey} placeholder={state.settings.hasGithubKey ? '已保存；留空不变' : '仅授权这个数据仓库'} onChange={e => setGithubKey(e.target.value)}/></label></div><p className="setting-detail flush" aria-label="Token 保存状态">{state.settings.hasGithubKey ? `本机已保存：${state.settings.githubTokenType === 'fine-grained' ? '细粒度 Token' : state.settings.githubTokenType === 'classic' ? '经典 Token' : '格式待检查'} · ${state.settings.githubTokenSavedAt ? new Date(state.settings.githubTokenSavedAt).toLocaleString('zh-CN') : '此前保存，时间未记录'}` : '尚未保存 GitHub Token'}</p><div className="button-row"><button className="primary" disabled={connecting} onClick={() => void connectRepository('save')}>保存并检查</button>{connected && <button disabled={connecting} onClick={cancelEdit}>取消</button>}</div><details className="settings-advanced"><summary>如何创建 Token</summary><p>在 GitHub 创建细粒度 Token：Resource owner 选择仓库所有者，Repository access 只选这个数据仓库，Contents 设为 Read and write。检查连接只读取仓库与分支，不上传内容。</p></details></div>
          return connected ? <><div className="setting-row"><span className="status-dot ok"/><span className="setting-status" aria-label="同步状态">已连接 {state.settings.repo} · {state.settings.branch} · {state.syncStatus}</span><button disabled={connecting} onClick={() => void connectRepository('sync')}><RefreshCw size={15}/>立即同步</button></div><button className="disclosure" aria-expanded={repoOpen} onClick={() => repoOpen ? cancelEdit() : setRepoOpen(true)}>{repoOpen ? '收起' : '修改连接'}</button>{repoOpen && form}</> : <><p className="setting-detail flush">{state.syncStatus}</p>{form}</>
        })()}</section>
        <section className="settings-section about"><h2>关于</h2><div className="setting-row"><span className="setting-label">版本</span><span className="setting-status" aria-label="当前版本">v{state.version}</span></div><div className="setting-row"><span className="setting-label">源码</span><span className="setting-status"><button className="link-button" onClick={() => void window.xm.external('https://github.com/Andrew-liu/XMemory').catch(e => setError(e.message))}>github.com/Andrew-liu/XMemory ↗</button></span></div><p className="setting-detail">这是应用源码仓库，与上方配置的私有数据同步仓库不同。</p></section>
        </div> : page === 'conflicts' ? <div className="conflicts-page"><h1>保留每一个版本</h1><p>先比较，再决定。未选中的版本仍有恢复记录。</p>{state.conflicts.map(c => <section className="conflict-card" key={c.id}><h2>{c.title}</h2><ConflictDetails conflict={c}/><div className="button-row"><button onClick={() => void act(window.xm.resolve(c.id,'current'))}>采用 A</button><button onClick={() => void act(window.xm.resolve(c.id,'incoming'))}>采用 B</button><button className="primary" onClick={() => void act(window.xm.resolve(c.id,'both'))}>两份都保留</button></div><details><summary>手动合并</summary><textarea id={`merge-${c.id}`} defaultValue={c.current.body}/><button onClick={() => void act(window.xm.resolve(c.id,'merge',(document.getElementById(`merge-${c.id}`) as HTMLTextAreaElement).value))}>保存合并内容</button></details></section>)}{!state.conflicts.length && <div className="empty"><Check size={38}/><h2>没有待处理的冲突</h2></div>}</div> : page === 'inspiration' && !selected ? <Calendar notes={state.notes} anchor={calendarDate} setAnchor={setCalendarDate} mode={calendarMode} setMode={setCalendarMode} open={id=>void open(id)} refresh={refresh} error={setError}/> : <div className="content-layout">
        <section className={`item-list ${page === 'search' ? 'search-list' : ''}`}>
          <div className="list-heading"><div><span className="eyebrow">{page === 'search' ? '全部已保存内容' : page === 'memory' ? '从收藏到积累' : page === 'topic' ? '给长文一个起点' : '随时记录'}</span><h1>{titles[page]}<small>{page === 'search' ? hits.items.length : notes.length}</small></h1></div>{page === 'inspiration' && <button title="新建灵感" onClick={() => void create()}><Plus size={21}/></button>}</div>
          {page === 'search' && <div className="search-controls"><div className="search-field"><Search size={17}/><input ref={searchInput} autoFocus placeholder="搜索灵感、记忆、选题和候选稿…" value={query} onChange={e => setQuery(e.target.value)}/></div><div className="filter-row"><select aria-label="内容类型" value={filter} onChange={e => setFilter(e.target.value)}><option value="">全部类型</option><option value="inspiration">灵感</option><option value="memory">记忆</option><option value="draft">候选稿</option><option value="topic">选题</option></select><select value={sort} onChange={e => setSort(e.target.value as typeof sort)}><option value="relevance">相关度</option><option value="date">最近修改</option></select></div><details><summary>更多筛选</summary><input placeholder="作者" value={author} onChange={e=>setAuthor(e.target.value)}/><input placeholder="标签" value={tag} onChange={e=>setTag(e.target.value)}/><input aria-label="起始日期" type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}/><input aria-label="结束日期" type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)}/></details></div>}
          {page === 'memory' && <AutoCollectBar view={autoStatus(state.auto, state.bookmarks, state.archive, state.xStatus)} toggle={() => setAutoCollect(!state.auto.enabled)} login={() => void go('settings')}/>}
          {page === 'topic' ? <Topics notes={notes} selected={selected} busy={topicBusy} create={createTopic} open={id => void open(id)} complete={id => void complete(id)}/> : <div className={`list-scroll ${page==='memory' && memoryView==='card' ? 'card-grid' : ''}`}>{shownList.map(n => <button key={n.id} className={`note-card ${selected === n.id ? 'selected' : ''} ${page==='memory' && memoryView==='card' ? 'memory-tile' : ''}`} onClick={() => void open(n.id, markQuery)}><div className="card-top"><span>{n.author ? <>@<HighlightedText text={n.author} query={authorMark}/></> : titles[n.kind]}</span><time title={page==='memory'?'发布时间':'最近修改'}>{new Date(page === 'memory' ? n.publishedAt || n.createdAt : n.updatedAt).toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'})}</time></div><h3 style={{textDecoration:n.completed?'line-through':undefined}}><HighlightedText text={n.title} query={markQuery}/>{n.completed && (n.kind === 'topic' ? ' · 已写完' : ' · 已使用')}</h3><p>{page === 'search' ? <HighlightedText text={(n as SearchHit).snippet} query={markQuery}/> : markQuery ? <HighlightedText text={matchSnippet(n.body.replace(/[#*\[\]]/g,''), markQuery)} query={markQuery}/> : n.body.replace(/[#*\[\]]/g,'').slice(0,140) || '写下第一个念头…'}</p><div className="card-bottom">{n.partial ? <span>正文不完整</span> : n.tags.length ? n.tags.map(t=><span key={t}>#{t}</span>) : /!\[[^\]]*]\([^)]+\)/.test(n.body) ? <span>含图片</span> : <span>Markdown</span>}{n.kind === 'draft' && <Feather size={12}/>}</div></button>)}{!shownList.length && <div className="list-empty">{page === 'search' ? '没有找到匹配内容，试试其他关键词或清除筛选。' : page === 'memory' ? memoryQuery ? '没有匹配的记忆，试试其他关键词或清空搜索。' : state.auto.enabled ? '还没有记忆。自动采集会每小时把 X 书签保存到这里。' : '还没有记忆。开启自动采集后，X 书签会每小时保存到这里。' : '这里还没有内容。'}</div>}</div>}
          {page === 'memory' && note && isPartialMemory(note) && <p className="setting-detail" aria-label="不完整记忆补采状态">{retryStatus(state.partialRetries[note.id])}</p>}
          <footer className="list-footer"><span>保存在你的设备上</span><FolderOpen size={13}/></footer>
        </section>
        <div className="editor-column">{note ? <><div className="note-actions">{page === 'inspiration' && <button onClick={()=>void go('inspiration')}>← 返回日历</button>}{page === 'memory' && <button onClick={()=>void go('memory')}>← 返回记忆</button>}{note.kind === 'topic' && !note.deleted && <button disabled={topicBusy} onClick={()=>void complete()}>{note.completed ? '☑ 已写完 · 撤销' : '□ 标记已写完'}</button>}{note.kind === 'inspiration' && <button onClick={()=>void complete()}>{note.completed ? '☑ 已使用 · 撤销' : '□ 标记已使用'}</button>}{note.source && <button onClick={() => void window.xm.external(note.source!).catch(e=>setError(e.message))}>打开原文</button>}{note.source && <button onClick={() => void navigator.clipboard.writeText(note.source!).then(()=>setRunStatus('已复制原文链接')).catch(e=>setError(e.message))}>复制链接</button>}{runStatus && <span className="quiet" aria-live="polite">{runStatus}</span>}{note.kind === 'draft' && note.parentId && state.notes.some(n => n.id === note.parentId && !n.deleted) && <button onClick={() => void open(note.parentId!)}>返回原灵感</button>}{note.kind === 'memory' && !note.deleted && note.source && isPartialMemory(note) && <button disabled={collectingNow} onClick={() => void recollectNote(note.id)}><RefreshCw size={14}/>{collectingNow ? '采集中' : '重新采集'}</button>}{note.deleted ? <button onClick={() => void act(window.xm.remove(note.id,true))}>恢复</button> : <button title="移到回收站" onClick={() => { void editor.current?.flush().then(() => window.xm.remove(note.id)).then(() => { setSelected(''); void refresh() }).catch(e=>setError(e.message)) }}><Trash2 size={15}/></button>}</div><NoteEditor searchLocation={searchLocation} key={note.id} ref={editor} note={note} notes={state.notes} open={id => void open(id)} error={setError} saved={savedNote}/></> : <div className="welcome"><div className="welcome-symbol"><Feather size={42} strokeWidth={1.2}/></div><span className="eyebrow">留给下一次创作</span><h1>{page === 'topic' ? '从一个选题，\n写成一篇长文。' : page === 'memory' ? '书签自动采集，\n留下整段记忆。' : page === 'search' ? '记得一点，\n也能找回全部。' : '把一闪而过，\n变成值得留下。'}</h1><p>{page === 'topic' ? '在左侧记下标题，打开后编写大纲与长文。写完勾选，未完成的选题始终留在前面。' : page === 'memory' ? (state.auto.enabled ? '自动采集已开启，每小时增量保存一次 X 书签。右上角可按正文、链接或 @作者 搜索。' : '在设置中开启自动采集，X 书签会每小时增量保存到本机。首次使用请先在设置中用 Chrome 登录 X。') : page === 'search' ? '搜索全部已保存的灵感、记忆、选题与候选稿。无需联网。' : '从左侧打开一篇内容，或记录一个新灵感。\n支持粘贴图片、Markdown、表格与双链。'}</p>{!(page === 'memory' && state.auto.enabled) && <button className="primary" onClick={() => page === 'memory' ? void go('settings') : page === 'topic' ? void createTopic('未命名选题') : void create()}>{page === 'memory' ? '去开启自动采集' : page === 'topic' ? '写下一个选题' : '写下一个灵感'}<ArrowUpRight size={16}/></button>}<div className="welcome-foot"><span>{page === 'topic' ? '大纲与长文' : '私人资料库'}</span><span>本地保存</span><span>随时续写</span></div></div>}</div>
      </div>}

    </main>
  </div>
}
applyCachedTheme()
createRoot(document.getElementById('root')!).render(<App/> )
