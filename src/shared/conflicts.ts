import type { Conflict, Note } from './types'

export const normalizeLines = (text: string) => text.replace(/\r\n/g, '\n')
export function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableValue((value as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(value) ?? '未设置'
}
export function conflictFields(c: Conflict) {
  const fields = (note: Note) => Object.fromEntries(Object.entries(note).filter(([key]) => !['body', 'hash', 'path', 'updatedAt', 'id'].includes(key)))
  const a = c.currentMetadata ?? fields(c.current), b = c.incomingMetadata ?? fields(c.incoming)
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter(key => stableValue(a[key]) !== stableValue(b[key])).map(key => ({ key, current: stableValue(a[key]), incoming: stableValue(b[key]) }))
}
