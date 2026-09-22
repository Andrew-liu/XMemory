import React, { useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { Note } from '../shared/types'
import { sortTopics } from '../shared/topics'

export function Topics({ notes, selected, busy, create, open, complete }: {
  notes: Note[]; selected: string; busy: boolean
  create: (title: string) => Promise<boolean>
  open: (id: string) => void
  complete: (id: string) => void
}) {
  const [title, setTitle] = useState('')
  const submitting = useRef(false)
  const sorted = sortTopics(notes)
  return <>
    <form className="topic-create" onSubmit={async e => {
      e.preventDefault()
      if (!title.trim() || submitting.current || busy) return
      submitting.current = true
      try { if (await create(title.trim())) setTitle('') } finally { submitting.current = false }
    }}>
      <input aria-label="新选题标题" placeholder="记下一个长文选题…" maxLength={400} value={title} onChange={e => setTitle(e.target.value)} disabled={busy}/>
      <button aria-label="添加选题" title="添加选题" disabled={busy || !title.trim()}><Plus size={17}/></button>
    </form>
    <div className="list-scroll topic-list">
      {[false, true].map(completed => {
        const group = sorted.filter(n => !!n.completed === completed)
        return <section key={String(completed)} aria-label={completed ? '已写完的选题' : '未完成的选题'}>
          <h2>{completed ? '已写完' : '待写'}<small>{group.length}</small></h2>
          {group.map(n => <div key={n.id} className={`topic-row ${completed ? 'completed' : ''} ${selected === n.id ? 'selected' : ''}`}>
            <input type="checkbox" checked={completed} disabled={busy} aria-label={`标记 ${n.title} 已写完`} onChange={() => complete(n.id)}/>
            <button onClick={() => open(n.id)} title={n.title}>{n.title}</button>
          </div>)}
          {!group.length && <p className="topic-empty">{completed ? '写完后勾选，选题会收在这里。' : '记下标题，留待慢慢展开。'}</p>}
        </section>
      })}
    </div>
  </>
}
