import { useState } from 'react'
import { ChevronLeft, ChevronRight, GripVertical, Plus } from 'lucide-react'
import type { Note } from '../shared/types'
import { dateKey, daysFor, noteDate } from '../shared/calendar'

export function compareTodoOrder(a: Note, b: Note) {
  const completion = Number(!!a.completed) - Number(!!b.completed)
  const aOrder = a.sortOrder ?? Number.MAX_SAFE_INTEGER
  const bOrder = b.sortOrder ?? Number.MAX_SAFE_INTEGER
  return completion || aOrder - bOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
}

export function planTodoMove(notes: Note[], draggedId: string, targetDate: string, targetId?: string) {
  const moving = notes.find(note => note.id === draggedId && !note.deleted && note.kind === 'inspiration')
  if (!moving) return []
  const sourceDate = noteDate(moving)
  const source = notes.filter(note => note.id !== draggedId && !note.deleted && note.kind === 'inspiration' && noteDate(note) === sourceDate).sort(compareTodoOrder)
  const target = (sourceDate === targetDate ? source : notes.filter(note => note.id !== draggedId && !note.deleted && note.kind === 'inspiration' && noteDate(note) === targetDate).sort(compareTodoOrder))
  const insertion = targetId ? target.findIndex(note => note.id === targetId) : target.length
  if (targetId && insertion < 0) return []
  const destination = [...target]
  destination.splice(insertion, 0, { ...moving, scheduledDate: targetDate })
  const groups = sourceDate === targetDate ? [destination] : [source, destination]
  return groups.flatMap(group => group.map((note, sortOrder) => ({ ...note, sortOrder }))).filter(note => {
    const original = notes.find(item => item.id === note.id)!
    return note.scheduledDate !== original.scheduledDate || note.sortOrder !== original.sortOrder
  })
}

export function Calendar({ notes, anchor, setAnchor, mode, setMode, open, refresh, error }: { notes: Note[]; anchor: string; setAnchor: (date: string) => void; mode: 'week'|'month'; setMode: (mode: 'week'|'month') => void; open: (id: string) => void; refresh: () => Promise<unknown>; error: (message: string) => void }) {
  const [inputs, setInputs] = useState<Record<string,string>>({})
  const [busy, setBusy] = useState<string[]>([])
  const [dragged, setDragged] = useState('')
  const [dragOver, setDragOver] = useState('')
  const [dragDate, setDragDate] = useState('')
  const days = daysFor(anchor, mode), today = dateKey()
  async function create(date: string) {
    const title = inputs[date]?.trim()
    if (!title || busy.includes(date)) return
    setBusy(v => [...v,date])
    try {
      const entries = notes.filter(n => !n.deleted && n.kind === 'inspiration' && noteDate(n) === date)
      const sortOrder = entries.length > 0 && entries.every(note => note.sortOrder !== undefined)
        ? entries.reduce((max, note) => Math.max(max, note.sortOrder!), -1) + 1
        : undefined
      await window.xm.save({ kind: 'inspiration', title, body: '', scheduledDate: date, sortOrder })
      setInputs(v => ({ ...v, [date]: '' })); await refresh()
    } catch(e) { error((e as Error).message) } finally { setBusy(v => v.filter(x => x !== date)) }
  }
  async function toggle(note: Note) {
    if (busy.includes(note.id)) return
    setBusy(v => [...v,note.id])
    try { await window.xm.save({ ...note, completed: !note.completed }, note.hash); await refresh() }
    catch(e) { error((e as Error).message) } finally { setBusy(v => v.filter(x => x !== note.id)) }
  }
  async function move(targetDate: string, targetId?: string) {
    if (!dragged || dragged === targetId) return
    const updates = planTodoMove(notes, dragged, targetDate, targetId)
    if (!updates.length) { setDragged(''); setDragOver(''); setDragDate(''); return }
    setBusy(v => [...new Set([...v, ...updates.map(note => note.id)])])
    try {
      for (const note of updates) await window.xm.save(note, note.hash)
      await refresh()
    } catch(e) { await refresh(); error((e as Error).message) }
    finally { setBusy(v => v.filter(id => !updates.some(note => note.id === id))); setDragged(''); setDragOver(''); setDragDate('') }
  }
  function shift(direction: number) {
    const date = new Date(anchor + 'T12:00:00')
    if (mode === 'week') date.setDate(date.getDate() + direction * 7)
    else { date.setDate(1); date.setMonth(date.getMonth()+direction) }
    setAnchor(dateKey(date))
  }
  return <section className="calendar-page" aria-label="灵感日历">
    <header className="calendar-heading"><div><span className="eyebrow">每天，留下一点想法</span><h1>{mode === 'week' ? '这一周的灵感' : '这个月的灵感'}</h1><p>{mode === 'week' ? `${days[0]} — ${days[6]}` : anchor.slice(0,7)} · 拖动把手可排序或移动到其他日期</p></div><div className="calendar-navigation"><div className="segmented"><button aria-pressed={mode==='week'} onClick={()=>setMode('week')}>周</button><button aria-pressed={mode==='month'} onClick={()=>setMode('month')}>月</button></div><button aria-label="上一页" onClick={()=>shift(-1)}><ChevronLeft size={17}/></button><button onClick={()=>setAnchor(today)}>{mode==='week'?'本周':'本月'}</button><button aria-label="下一页" onClick={()=>shift(1)}><ChevronRight size={17}/></button><input aria-label="选择月份" type="month" value={anchor.slice(0,7)} onChange={e=>{ if (/^\d{4}-\d{2}$/.test(e.target.value)) { setAnchor(e.target.value+'-01'); setMode('month') } }}/></div></header>
    <div className={`calendar-grid ${mode}`}>{days.map((date,index) => {
      const entries = notes.filter(n => !n.deleted && n.kind === 'inspiration' && noteDate(n) === date).sort(compareTodoOrder)
      return <section key={date} aria-label={date} className={`calendar-day ${date===today?'today':''} ${date===anchor?'chosen-day':''} ${dragDate===date?'drag-target':''} ${mode==='month' && date.slice(0,7)!==anchor.slice(0,7)?'outside':''}`} onDragOver={e=>{if(dragged){e.preventDefault();setDragDate(date);setDragOver('')}}} onDrop={e=>{e.preventDefault();void move(date)}}>
        <button className="day-heading" onClick={()=>setAnchor(date)}><span>{['周一','周二','周三','周四','周五','周六','周日'][index%7]}</span><strong>{Number(date.slice(-2))}</strong><small>{entries.length || ''}</small></button>
        <div className="day-entries">{entries.map(note=><div key={note.id} data-note-id={note.id} className={`calendar-entry ${note.completed?'completed':''} ${dragged===note.id?'dragging':''} ${dragOver===note.id?'drag-over':''}`} onDragOver={e=>{if(dragged){e.preventDefault();e.stopPropagation();setDragDate(date);setDragOver(note.id)}}} onDrop={e=>{e.preventDefault();e.stopPropagation();void move(date,note.id)}}><button className="drag-handle" aria-label={`拖动 ${note.title} 调整顺序或日期`} title="拖动调整顺序或日期" draggable={!busy.includes(note.id)} onDragStart={e=>{setDragged(note.id);setDragDate(date);e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',note.id)}} onDragEnd={()=>{setDragged('');setDragOver('');setDragDate('')}}><GripVertical size={14}/></button><input type="checkbox" aria-label={`标记 ${note.title} 已使用`} checked={!!note.completed} disabled={busy.includes(note.id)} onChange={()=>void toggle(note)}/><button onClick={()=>{setAnchor(date);open(note.id)}} title={note.title}>{note.title}</button></div>)}</div>
        <form className="quick-create" onSubmit={e=>{e.preventDefault();void create(date)}}><Plus size={13}/><input aria-label={`${date} 新灵感标题`} placeholder="记一个想法…" value={inputs[date] || ''} maxLength={400} disabled={busy.includes(date)} onChange={e=>setInputs(v=>({...v,[date]:e.target.value}))} onKeyDown={e=>{if(e.key==='Enter' && e.nativeEvent.isComposing)e.preventDefault()}}/></form>
      </section>
    })}</div>
    <footer className="calendar-footer">输入标题后按 Enter 创建 · 点击标题展开正文 · 拖动把手可调整顺序或移动日期</footer>
  </section>
}
