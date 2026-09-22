import type { Note } from './types'
export function dateKey(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}` }
export function validDate(value: unknown): value is string { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const d = new Date(value + 'T12:00:00'); return !Number.isNaN(d.getTime()) && dateKey(d) === value }
export function noteDate(note: Note) { return validDate(note.scheduledDate) ? note.scheduledDate : dateKey(new Date(note.createdAt)) }
export function daysFor(anchor: string, mode: 'week'|'month') {
  const start = new Date(anchor + 'T12:00:00')
  if (mode === 'month') start.setDate(1)
  start.setDate(start.getDate() - (start.getDay()+6)%7)
  const count = mode === 'week' ? 7 : Math.ceil(((new Date(anchor.slice(0,7)+'-01T12:00:00').getDay()+6)%7 + new Date(start.getFullYear(), Number(anchor.slice(5,7)), 0).getDate())/7)*7
  return Array.from({ length: count }, (_, i) => { const d = new Date(start); d.setDate(d.getDate()+i); return dateKey(d) })
}
