import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Search, Lightbulb, Layers, Feather, Settings2, Plus, PanelLeft, ArrowUpRight, RefreshCw, Trash2, FolderOpen, Sun, Moon, Monitor, X, GitBranch, AlertCircle, Copy, Play, Square, Check, ChevronDown } from 'lucide-react'
import twitter from 'twitter-text'
import type { AgentMode, Note, Snapshot, Kind, SearchHit, Conflict } from '../shared/types'
import { NoteEditor, type EditorHandle } from './Editor'
import { ProviderSettings, type ProviderSettingsHandle } from './ProviderSettings'

import './style.css'
import { Topics } from './Topics'
import { topicTemplate } from '../shared/topics'
import { Calendar } from './Calendar'
import { MemoryToolbar, memoryMatches, type MediaFilter } from './Memory'
import { dateKey, noteDate } from '../shared/calendar'
import { splitDifference, splitMatches } from './highlight'
import { conflictFields, normalizeLines } from '../shared/conflicts'

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
  const [hits, setHits] = useState<SearchHit[]>([])
  const [error, setError] = useState('')
  const [compose, setCompose] = useState(false)
  const [instruction, setInstruction] = useState('用自然、简洁的中文表达这个想法，保留我的观点。')
  const [mode, setMode] = useState<'short'|'thread'>('short')
  const [agentMode, setAgentMode] = useState<AgentMode>('web')
  const [materials, setMaterials] = useState<string[]>([])
  const [output, setOutput] = useState('')

  const [runStatus, setRunStatus] = useState('')
  const [running, setRunning] = useState(false)
  const generating = useRef(false)
  const [connecting, setConnecting] = useState(false)
  const providerSettings = useRef<ProviderSettingsHandle>(null)
  const [switchingModel, setSwitchingModel] = useState(false)
  const [githubKey, setGithubKey] = useState('')

  const [memoryQuery, setMemoryQuery] = useState('')
  const [memoryAuthor, setMemoryAuthor] = useState('')
  const [memoryMedia, setMemoryMedia] = useState<MediaFilter>('all')
  const [memoryView, setMemoryView] = useState<'list'|'card'>('list')
  const editor = useRef<EditorHandle>(null)
  useEffect(() => window.xm.onBeforeClose(async recover => { if (recover) await editor.current?.recover(); else { await providerSettings.current?.flush(); await editor.current?.flush() } }), [])
  const searchInput = useRef<HTMLInputElement>(null)
  const refresh = () => window.xm.snapshot().then(setState).catch(e => setError(e.message))
  const act = (promise: Promise<unknown>) => promise.then(() => refresh()).catch(e => setError(e.message))
  useEffect(() => { void refresh(); return window.xm.onChange(() => { void refresh() }) }, [])
  useEffect(() => window.xm.onRun(e => { if (e.type === 'text') setOutput(s => s + e.text); else if (e.type === 'status') setRunStatus(e.text); else { generating.current = false; setRunning(false); setRunStatus(e.type === 'done' ? '已保存为候选稿' : e.text); void refresh() } }), [])
  useEffect(() => {
    const theme = state?.settings.theme || 'system'
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => document.documentElement.dataset.theme = theme === 'system' ? mq.matches ? 'dark' : 'light' : theme
    apply(); mq.addEventListener('change', apply); return () => mq.removeEventListener('change', apply)
  }, [state?.settings.theme])
  useEffect(() => { const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); void go('search').then(() => searchInput.current?.focus()) } }; addEventListener('keydown', key); return () => removeEventListener('keydown', key) }, [])
  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => { void window.xm.search({ query, kind: (filter || undefined) as Kind|undefined, author: author || undefined, tag: tag || undefined, from: dateFrom || undefined, to: dateTo || undefined, sort }).then(v => { if (alive) setHits(v) }).catch(e => setError(e.message)) }, 150)
    return () => { alive = false; clearTimeout(timer) }
  }, [query, filter, dateFrom, dateTo, author, tag, sort, state?.notes])
  async function go(next: Page) { try { if (generating.current) throw new Error('正在创作，请等待完成或先停止'); await providerSettings.current?.flush(); await editor.current?.flush(); setPage(next); setSelected(''); setSearchLocation(undefined); setCompose(false); setOutput(''); setRunStatus('') } catch(e) { setError((e as Error).message) } }
  async function open(id: string, locate = false) { try { if (generating.current) throw new Error('正在创作，请等待完成或先停止'); await editor.current?.flush(); setSelected(id); setSearchLocation(locate ? { query, request: Date.now() } : undefined); setCompose(false); setOutput(''); setRunStatus('') } catch(e) { setError((e as Error).message) } }
  async function create() { try { if (generating.current) throw new Error('正在创作，请等待完成或先停止'); await providerSettings.current?.flush(); await editor.current?.flush(); const today = dateKey(); const n = await window.xm.save({ kind: 'inspiration', title: '未命名灵感', body: '', scheduledDate: today }); await refresh(); setCalendarDate(today); setPage('inspiration'); setSearchLocation(undefined); setSelected(n.id) } catch(e) { setError((e as Error).message) } }
  async function complete(id = selected) { if (topicOperation.current) return; topicOperation.current = true; setTopicBusy(true); try { await editor.current?.flush(); const fresh = (await window.xm.snapshot()).notes.find(n=>n.id===id); if (fresh && !fresh.deleted) { await window.xm.save({ ...fresh, completed: !fresh.completed }, fresh.hash); await refresh() } } catch(e) { setError((e as Error).message) } finally { topicOperation.current = false; setTopicBusy(false) } }

  async function createTopic(title: string): Promise<boolean> {
    if (!title.trim() || topicOperation.current) return false
    topicOperation.current = true; setTopicBusy(true)
    try {
      if (generating.current) throw new Error('正在创作，请等待完成或先停止')
      await editor.current?.flush()
      const created = await window.xm.save({ kind: 'topic', title: title.trim(), body: topicTemplate })
      await refresh(); setPage('topic'); setSearchLocation(undefined); setSelected(created.id); setCompose(false); setRunStatus('')
      return true
    } catch (e) { setError((e as Error).message); return false }
    finally { topicOperation.current = false; setTopicBusy(false) }
  }

  const note = state?.notes.find(n => n.id === selected)
  const notes = state?.notes.filter(n => page === 'trash' ? n.deleted : !n.deleted && n.kind === page).filter(n => page !== 'memory' || memoryMatches(n, memoryQuery, memoryAuthor, memoryMedia)).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)) || []
  const writingProvider = state?.settings.providers.find(p => p.id === state.settings.activeProvider)
  async function startCreation() {
    if (switchingModel || generating.current || !note || note.kind !== 'inspiration' || note.deleted) return
    generating.current = true
    setRunning(true)
    try {
      await editor.current?.flush()
      await refresh()
      setCompose(true)
      if (!writingProvider?.hasKey) throw new Error(`请先在设置中保存 ${writingProvider?.name || '当前服务'} 模型配置和 API Key`)
      setError(''); setOutput(''); setRunStatus('正在根据当前灵感创作…')
      await window.xm.generate(note.id, instruction, materials, mode, agentMode)
    } catch (e) { generating.current = false; setRunning(false); setError((e as Error).message) }
  }
  async function connectRepository(action: 'save' | 'check' | 'sync') {
    if (!state || connecting) return
    setConnecting(true); setError('')
    try {
      await window.xm.settings({ repo: state.settings.repo, branch: state.settings.branch }, githubKey.trim() ? { githubKey: githubKey.trim() } : undefined)
      setGithubKey('')
      if (action === 'check') await window.xm.checkSync()
      if (action === 'sync') await window.xm.sync()
      await refresh()
    } catch (e) { setError((e as Error).message) }
    finally { setConnecting(false) }
  }

  if (!state) return <div className="boot"><span className="brand-mark">X</span><p>{error || '正在打开本地资料库…'}</p></div>
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">X<span>m</span></span><strong>XMemeory</strong></div>
      <button className="sidebar-search" onClick={() => void go('search')}><Search size={16}/><span>搜索所有内容</span><kbd>⌘ K</kbd></button>
      <div className="nav-label">工作区</div>
      <nav>{([['inspiration',Lightbulb],['memory',Layers],['topic',Feather]] as const).map(([id, Icon]) => <button key={id} className={page === id ? 'selected' : ''} onClick={() => void go(id)}><Icon size={18}/><span>{titles[id]}</span><small>{state.notes.filter(n => n.kind === id && !n.deleted).length}</small></button>)}</nav>
      <div className="sidebar-note"><span className="tiny-line"/><p>捕捉一闪而过的想法，<br/>让值得留下的内容<br/>成为下一次创作的起点。</p></div>
      <div className="sidebar-bottom">
        {state.conflicts.length > 0 && <button onClick={() => void go('conflicts')}><GitBranch size={17}/><span>待处理冲突</span><small>{state.conflicts.length}</small></button>}
        <button onClick={() => void go('trash')}><Trash2 size={16}/><span>回收站</span></button>
        <button className={page === 'settings' ? 'selected' : ''} onClick={() => void go('settings')}><Settings2 size={17}/><span>设置</span></button>
        <div className="local-status"><i/><span>本地优先 · 私人工作区</span></div>
      </div>
    </aside>
    <main className="workspace">
      <header className="workspace-header"><PanelLeft size={17}/><span>{titles[page]}</span><div className="spacer"/><span className="quiet">让想法有迹可循</span><button className="primary compact" onClick={() => page === 'topic' ? void createTopic('未命名选题') : void create()} disabled={topicBusy}><Plus size={16}/>{page === 'topic' ? '新选题' : '新灵感'}</button></header>
      {error && <div className="error-banner"><AlertCircle size={16}/><span>{error}</span><button onClick={() => setError('')}><X size={15}/></button></div>}
      {state.status && <div className="error-banner">{state.status}</div>}
      {page === 'settings' ? <div className="settings-page">
        <div className="section-heading"><span className="eyebrow">偏好与连接</span><h1>你的工作区，按你的方式。</h1><p>内容保存在本机，连接由你控制。</p></div>
        <section className="settings-section"><h2>外观</h2><div className="theme-options">{([['system',Monitor,'跟随系统'],['light',Sun,'浅色'],['dark',Moon,'深色']] as const).map(([id, Icon, label]) => <button key={id} className={state.settings.theme === id ? 'chosen' : ''} onClick={() => void act(window.xm.settings({ theme: id }))}><Icon size={22}/>{label}</button>)}</div><label className="check-label"><input type="checkbox" checked={state.settings.closeToTray} onChange={e => void act(window.xm.settings({ closeToTray: e.target.checked }))}/>关闭窗口后驻留托盘</label></section>
        <section className="settings-section"><h2>资料库</h2><p className="path-text">{state.library}</p><div className="button-row"><button onClick={() => void act(window.xm.openLibrary())}><FolderOpen size={16}/>打开文件夹</button><button onClick={() => void act(window.xm.selectLibrary())}>选择资料库</button></div><p>Markdown 正文与图片保存在资料库中，支持外部编辑后重新读取。</p></section>
        <ProviderSettings ref={providerSettings} settings={state.settings} refresh={refresh} error={setError}/>
        <section className="settings-section"><h2>X 定向采集测试</h2><p aria-label="Cookie 导入状态">{state.cookieStatus}</p><p aria-label="X 登录状态">{state.xStatus}</p><div className="button-row"><button className="primary" onClick={() => void act(window.xm.loginX())}>在 Chrome 登录 X</button><button onClick={() => void act(window.xm.connectX())}>检查登录</button><button onClick={() => void act(window.xm.showX())}>显示 Chrome</button><button onClick={() => void act(window.xm.disconnectX())}>关闭 CDP Chrome</button></div><p>使用独立的正式版 Chrome Profile，通过本机 CDP 保存登录态。首次登录和安全验证需在 Chrome 中手动完成，应用不会读取日常 Chrome Cookie。</p><p>当前安全测试版只允许保存两条固定内容，不读取书签列表、不批量滚动，也不启用自动定时采集。</p></section>
        <section className="settings-section"><h2>GitHub 私有数据同步</h2><p>{state.syncStatus}</p><p aria-label="Token 保存状态">{state.settings.hasGithubKey ? `本机已保存：${state.settings.githubTokenType === 'fine-grained' ? '细粒度 Token' : state.settings.githubTokenType === 'classic' ? '经典 Token' : '格式待检查'} · ${state.settings.githubTokenSavedAt ? new Date(state.settings.githubTokenSavedAt).toLocaleString('zh-CN') : '此前保存，时间未记录'}。保存不代表认证成功，请点击检查连接。` : '尚未保存 GitHub Token'}</p><div className="form-grid"><label>私有仓库<input placeholder="owner/repo 或 GitHub 完整 URL" value={state.settings.repo || ''} onChange={e => setState({ ...state, settings: { ...state.settings, repo: e.target.value } })}/></label><label>分支<input value={state.settings.branch} onChange={e => setState({ ...state, settings: { ...state.settings, branch: e.target.value } })}/></label><label className="full">访问 Token<input type="password" autoComplete="off" value={githubKey} placeholder={state.settings.hasGithubKey ? '已保存；留空不变' : '仅授权这个数据仓库'} onChange={e => setGithubKey(e.target.value)}/></label></div><div className="button-row"><button disabled={connecting} onClick={() => void connectRepository('save')}>保存连接</button><button disabled={connecting} onClick={() => void connectRepository('check')}>检查连接</button><button disabled={connecting} onClick={() => void connectRepository('sync')}><RefreshCw size={15}/>立即同步</button></div><p>细粒度 Token：Resource owner 选择仓库所有者，Repository access 选中此仓库，Contents 设置 Read and write。检查连接只读取仓库与分支，不上传内容。</p></section>
      </div> : page === 'conflicts' ? <div className="conflicts-page"><h1>保留每一个版本</h1><p>先比较，再决定。未选中的版本仍有恢复记录。</p>{state.conflicts.map(c => <section className="conflict-card" key={c.id}><h2>{c.title}</h2><ConflictDetails conflict={c}/><div className="button-row"><button onClick={() => void act(window.xm.resolve(c.id,'current'))}>采用 A</button><button onClick={() => void act(window.xm.resolve(c.id,'incoming'))}>采用 B</button><button className="primary" onClick={() => void act(window.xm.resolve(c.id,'both'))}>两份都保留</button></div><details><summary>手动合并</summary><textarea id={`merge-${c.id}`} defaultValue={c.current.body}/><button onClick={() => void act(window.xm.resolve(c.id,'merge',(document.getElementById(`merge-${c.id}`) as HTMLTextAreaElement).value))}>保存合并内容</button></details></section>)}{!state.conflicts.length && <div className="empty"><Check size={38}/><h2>没有待处理的冲突</h2></div>}</div> : page === 'inspiration' && !selected ? <Calendar notes={state.notes} anchor={calendarDate} setAnchor={setCalendarDate} mode={calendarMode} setMode={setCalendarMode} open={id=>void open(id)} refresh={refresh} error={setError}/> : <div className="content-layout">
        <section className={`item-list ${page === 'search' ? 'search-list' : ''}`}>
          <div className="list-heading"><div><span className="eyebrow">{page === 'search' ? '全部已保存内容' : page === 'memory' ? '从收藏到积累' : page === 'topic' ? '给长文一个起点' : '随时记录'}</span><h1>{titles[page]}<small>{page === 'search' ? hits.length : notes.length}</small></h1></div>{page === 'inspiration' && <button title="新建灵感" onClick={() => void create()}><Plus size={21}/></button>}</div>
          {page === 'search' && <div className="search-controls"><div className="search-field"><Search size={17}/><input ref={searchInput} autoFocus placeholder="搜索灵感、记忆、选题和候选稿…" value={query} onChange={e => setQuery(e.target.value)}/></div><div className="filter-row"><select aria-label="内容类型" value={filter} onChange={e => setFilter(e.target.value)}><option value="">全部类型</option><option value="inspiration">灵感</option><option value="memory">记忆</option><option value="draft">候选稿</option><option value="topic">选题</option></select><select value={sort} onChange={e => setSort(e.target.value as typeof sort)}><option value="relevance">相关度</option><option value="date">最近修改</option></select></div><details><summary>更多筛选</summary><input placeholder="作者" value={author} onChange={e=>setAuthor(e.target.value)}/><input placeholder="标签" value={tag} onChange={e=>setTag(e.target.value)}/><input aria-label="起始日期" type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}/><input aria-label="结束日期" type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)}/></details></div>}
          {page === 'memory' && <MemoryToolbar status={state.xStatus} archive={state.archive} query={memoryQuery} setQuery={setMemoryQuery} author={memoryAuthor} setAuthor={setMemoryAuthor} media={memoryMedia} setMedia={setMemoryMedia} view={memoryView} setView={setMemoryView} collect={() => void act(window.xm.collectTestPosts())} pause={() => void act(window.xm.pauseScan())}/>}
          {page === 'topic' ? <Topics notes={notes} selected={selected} busy={topicBusy} create={createTopic} open={id => void open(id)} complete={id => void complete(id)}/> : <div className={`list-scroll ${page==='memory' && memoryView==='card' ? 'card-grid' : ''}`}>{(page === 'search' ? hits : notes).map(n => <button key={n.id} className={`note-card ${selected === n.id ? 'selected' : ''} ${page==='memory' && memoryView==='card' ? 'memory-tile' : ''}`} onClick={() => void open(n.id, page === 'search')}><div className="card-top"><span>{n.author ? `@${n.author}` : titles[n.kind]}</span><time title={page==='memory'?'发布时间':'最近修改'}>{new Date(page === 'memory' ? n.publishedAt || n.createdAt : n.updatedAt).toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'})}</time></div><h3 style={{textDecoration:n.completed?'line-through':undefined}}>{page === 'search' ? <HighlightedText text={n.title} query={query}/> : n.title}{n.completed && (n.kind === 'topic' ? ' · 已写完' : ' · 已使用')}</h3><p>{page === 'search' ? <HighlightedText text={(n as SearchHit).snippet} query={query}/> : n.body.replace(/[#*\[\]]/g,'').slice(0,140) || '写下第一个念头…'}</p><div className="card-bottom">{n.partial ? <span>正文不完整</span> : n.tags.length ? n.tags.map(t=><span key={t}>#{t}</span>) : /!\[[^\]]*]\([^)]+\)/.test(n.body) ? <span>含图片</span> : <span>Markdown</span>}{n.kind === 'draft' && <Feather size={12}/>}</div></button>)}{!(page === 'search' ? hits : notes).length && <div className="list-empty">{page === 'search' ? '没有找到匹配内容，试试其他关键词或清除筛选。' : page === 'memory' ? '尚未保存测试内容。点击“采集”，应用会自动检查登录状态。' : '这里还没有内容。'}</div>}</div>}
          <footer className="list-footer"><span>保存在你的设备上</span><FolderOpen size={13}/></footer>
        </section>
        <div className="editor-column">{note ? <><div className="note-actions">{page === 'inspiration' && <button onClick={()=>void go('inspiration')}>← 返回日历</button>}{page === 'memory' && <button onClick={()=>void go('memory')}>← 返回记忆</button>}{note.kind === 'topic' && !note.deleted && <button disabled={topicBusy} onClick={()=>void complete()}>{note.completed ? '☑ 已写完 · 撤销' : '□ 标记已写完'}</button>}{note.kind === 'inspiration' && <button onClick={()=>void complete()}>{note.completed ? '☑ 已使用 · 撤销' : '□ 标记已使用'}</button>}{note.source && <button onClick={() => void window.xm.external(note.source!).catch(e=>setError(e.message))}>打开原文</button>}{note.source && <button onClick={() => void navigator.clipboard.writeText(note.source!).then(()=>setRunStatus('已复制原文链接')).catch(e=>setError(e.message))}>复制链接</button>}{runStatus && <span className="quiet" aria-live="polite">{runStatus}</span>}{note.kind === 'inspiration' && !note.deleted && <button disabled={running} onClick={() => void startCreation()}><Feather size={15}/>{running ? '创作中…' : '创作'}</button>}{note.kind === 'draft' && note.parentId && state.notes.some(n => n.id === note.parentId && !n.deleted) && <button onClick={() => void open(note.parentId!)}>返回原灵感</button>}<button onClick={() => { void editor.current?.flush().then(()=>{ setMaterials(v => v.includes(note.id) ? v : [...v,note.id]); setRunStatus('已加入创作素材；点击素材标签可移除。选择仅在本次会话保留；从灵感中点击创作使用。'); if (note.kind === 'inspiration' && !note.deleted) setCompose(true) }).catch(e=>setError(e.message)) }}>{materials.includes(note.id) ? '已加入创作素材' : '加入创作素材'} · {materials.length}</button>{note.deleted ? <button onClick={() => void act(window.xm.remove(note.id,true))}>恢复</button> : <button title="移到回收站" onClick={() => { void editor.current?.flush().then(() => window.xm.remove(note.id)).then(() => { setSelected(''); void refresh() }).catch(e=>setError(e.message)) }}><Trash2 size={15}/></button>}</div><NoteEditor searchLocation={searchLocation} key={note.id} ref={editor} note={note} notes={state.notes} open={id => void open(id)} error={setError} saved={() => { void refresh() }}/></> : <div className="welcome"><div className="welcome-symbol"><Feather size={42} strokeWidth={1.2}/></div><span className="eyebrow">留给下一次创作</span><h1>{page === 'topic' ? '从一个选题，\n写成一篇长文。' : page === 'memory' ? '先验证两条，\n再逐步扩展。'  : page === 'search' ? '记得一点，\n也能找回全部。' : '把一闪而过，\n变成值得留下。'}</h1><p>{page === 'topic' ? '在左侧记下标题，打开后编写大纲与长文。写完勾选，未完成的选题始终留在前面。' : page === 'memory' ? '点击「采集」后会自动检查登录状态；未登录时先打开 Chrome，登录完成后自动继续。当前只保存指定的一条长文和一条短推。' : page === 'search' ? '搜索全部已保存的灵感、记忆、选题与候选稿。无需联网。' : '从左侧打开一篇内容，或记录一个新灵感。\n支持粘贴图片、Markdown、表格与双链。'}</p><button className="primary" onClick={() => page === 'memory' ? void act(window.xm.collectTestPosts()) : page === 'topic' ? void createTopic('未命名选题') : void create()}>{page === 'memory' ? '采集' : page === 'topic' ? '写下一个选题' : '写下一个灵感'}<ArrowUpRight size={16}/></button><div className="welcome-foot"><span>{page === 'topic' ? '大纲与长文' : '私人资料库'}</span><span>本地保存</span><span>随时续写</span></div></div>}</div>
      </div>}
      {compose && note?.kind === 'inspiration' && !note.deleted && <aside className="compose-panel"><header><Feather size={18}/><h2>创作</h2><button aria-label="关闭创作面板" onClick={() => setCompose(false)}><X size={18}/></button></header><label>创作模型<select aria-label="创作模型" disabled={running || switchingModel} value={state.settings.activeProvider} onChange={e => { setSwitchingModel(true); void window.xm.settings({ activeProvider: e.target.value }).then(refresh).catch(e => setError(e.message)).finally(() => setSwitchingModel(false)) }}>{!writingProvider && <option value={state.settings.activeProvider}>请选择有效服务</option>}{state.settings.providers.map(p => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}</select></label><span className="eyebrow">当前灵感</span><h3>{note.title}</h3><div className="segmented"><button className={mode==='short'?'active':''} onClick={()=>setMode('short')}>短推</button><button className={mode==='thread'?'active':''} onClick={()=>setMode('thread')}>串文</button></div><div className="segmented agent-mode"><button className={agentMode==='web'?'active':''} onClick={()=>setAgentMode('web')}>智能联网</button><button className={agentMode==='local'?'active':''} onClick={()=>setAgentMode('local')}>仅本地</button></div><label>这次想怎么写？<textarea value={instruction} onChange={e=>setInstruction(e.target.value)}/></label><p className="muted">{writingProvider?.name || '未选择服务'} · {writingProvider?.model}<br/>{agentMode==='web' ? '按需搜索公开网页并读取原文；不可用时继续使用本地素材。' : '只检索本地记忆；发送命中片段和当前灵感。'}</p>{materials.length>0 && <div className="material-list">{materials.map(id=><button key={id} onClick={()=>setMaterials(v=>v.filter(x=>x!==id))}>{state.notes.find(n=>n.id===id)?.title}<X size={12}/></button>)}</div>}<div className="button-row"><button className="primary" disabled={running || switchingModel || !writingProvider?.hasKey} onClick={() => void startCreation()}><Play size={14}/>生成候选稿</button>{running && <button onClick={()=>void window.xm.cancel()}><Square size={13}/>停止</button>}</div>{!writingProvider?.hasKey && <p>请先在设置中保存当前服务的模型配置和 API Key。</p>}<p className="run-status">{runStatus}</p><details className="inspiration-drafts"><summary>历史候选稿 · {state.notes.filter(n => n.kind === 'draft' && !n.deleted && n.parentId === note.id).length}</summary>{state.notes.filter(n => n.kind === 'draft' && !n.deleted && n.parentId === note.id).map(draft => <button key={draft.id} disabled={running} onClick={() => void open(draft.id)}>{draft.title} · {draft.generationProvider ? `${draft.generationProvider.name} / ${draft.generationProvider.model}` : '模型未记录'}</button>)}</details><div className="generated">{output.split(/\n---\n/).filter(Boolean).map((text,i)=><div className="tweet" key={i}><header><span>{mode==='thread'?`第 ${i+1} 条`:'候选推文'}</span><small className={twitter.parseTweet(text.trim()).weightedLength>280?'over':''}>{twitter.parseTweet(text.trim()).weightedLength} / 280</small></header><p>{text}</p><button onClick={()=>void navigator.clipboard.writeText(text.trim())}><Copy size={13}/>复制</button></div>)}</div>{output && <button onClick={()=>void navigator.clipboard.writeText(output)}><Copy size={14}/>复制全部</button>}</aside>}

    </main>
  </div>
}
createRoot(document.getElementById('root')!).render(<App/> )
