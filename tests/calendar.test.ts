import { expect, it } from 'vitest'
import { daysFor, validDate } from '../src/shared/calendar'
import { compareTodoOrder, planTodoMove } from '../src/renderer/Calendar'
import { linkAddress } from '../src/renderer/links'
import type { Note } from '../src/shared/types'
import { Library } from '../src/main/library'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
it('周历跨年、整月闰日与日期校验', () => {
  expect(daysFor('2026-01-01','week')).toEqual(['2025-12-29','2025-12-30','2025-12-31','2026-01-01','2026-01-02','2026-01-03','2026-01-04'])
  expect(daysFor('2024-02-12','month')).toContain('2024-02-29')
  expect(daysFor('2026-02-12','month').filter(d=>d.startsWith('2026-02'))).toHaveLength(28)
  expect(validDate('2026-02-29')).toBe(false)
})
it('跨天移动同时归一化来源日和目标日顺序', () => {
  const note = (id: string, scheduledDate: string, sortOrder: number): Note => ({ id, kind: 'inspiration', title: id, body: '', hash: id, path: `${id}.md`, tags: [], createdAt: `2026-09-1${sortOrder}T00:00:00.000Z`, updatedAt: '2026-09-16T00:00:00.000Z', scheduledDate, sortOrder })
  const notes = [note('a','2026-09-15',0),note('b','2026-09-15',1),note('c','2026-09-16',0),note('d','2026-09-16',1)]
  expect(planTodoMove(notes,'a','2026-09-16','d').map(n=>[n.id,n.scheduledDate,n.sortOrder])).toEqual([
    ['b','2026-09-15',0],['a','2026-09-16',1],['d','2026-09-16',2]
  ])
  expect(planTodoMove(notes,'b','2026-09-17').find(n=>n.id==='b')).toMatchObject({ scheduledDate:'2026-09-17',sortOrder:0 })
})
it('同一天未完成灵感排在已完成灵感前面，并保留组内手动顺序', () => {
  const note = (id: string, completed: boolean, sortOrder: number): Note => ({ id, kind: 'inspiration', title: id, body: '', hash: id, path: `${id}.md`, tags: [], createdAt: `2026-09-1${sortOrder}T00:00:00.000Z`, updatedAt: '2026-09-16T00:00:00.000Z', scheduledDate: '2026-09-16', sortOrder, completed })
  const notes = [note('done-first', true, 0), note('todo-second', false, 1), note('todo-first', false, 0), note('done-second', true, 1)]
  expect(notes.sort(compareTodoOrder).map(note => note.id)).toEqual(['todo-first', 'todo-second', 'done-first', 'done-second'])
})
it('完成、日期和顺序写入 Markdown，重启和外部回读一致', async () => {
  const temp=path.resolve('../../trash/xmemeory-dev/tests');mkdirSync(temp,{recursive:true})
  const root=mkdtempSync(path.join(temp,'calendar-'));let library=new Library(root)
  try {
    let note=library.save({kind:'inspiration',title:'日历灵感',body:'',scheduledDate:'2024-02-29',sortOrder:2})
    note=library.save({...note,completed:true},note.hash)
    expect(readFileSync(path.join(root,note.path),'utf8')).toContain('completed: true')
    expect(readFileSync(path.join(root,note.path),'utf8')).toContain('sortOrder: 2')
    await library.close();library=new Library(root)
    expect(library.get(note.id).completed).toBe(true)
    expect(library.get(note.id).sortOrder).toBe(2)
    const file=path.join(root,note.path)
    writeFileSync(file,readFileSync(file,'utf8').replace('2024-02-29','2024-03-01').replace('completed: true','completed: false'))
    library.refresh();expect(library.get(note.id).scheduledDate).toBe('2024-03-01');expect(library.get(note.id).completed).toBe(false)
    expect(library.get(note.id).completedAt).toBeUndefined()
    expect(library.get(note.id).sortOrder).toBe(2)
  } finally { await library.close() }
})
it('链接地址补全与危险/不明确地址校验',()=>{
  expect(linkAddress('baidu.com')).toBe('https://baidu.com/')
  expect(linkAddress('../笔记.md')).toBe('../笔记.md')
  expect(()=>linkAddress('baidu')).toThrow()
  expect(()=>linkAddress('javascript:alert(1)')).toThrow()
})
