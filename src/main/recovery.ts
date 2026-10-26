import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { atomic } from './library'

// Startup notice for unsaved bodies saved as recovery copies. The notice file only
// lists copies that still exist; stale entries are dropped so the prompt never
// points at an empty directory.
const inside = (dir: string, file: string) => {
  const relative = path.relative(path.resolve(dir), path.resolve(file))
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function read(notice: string): string[] {
  try {
    const data = JSON.parse(readFileSync(notice, 'utf8'))
    const files = Array.isArray(data?.files) ? data.files : typeof data?.file === 'string' ? [data.file] : []
    return files.filter((file: unknown): file is string => typeof file === 'string')
  } catch { return [] }
}

export function pendingRecoveries(notice: string, dir: string): string[] {
  if (!existsSync(notice)) return []
  const stored = read(notice)
  const files = [...new Set(stored)].filter(file => inside(dir, file) && existsSync(file))
  if (!files.length) rmSync(notice, { force: true })
  else if (files.length !== stored.length) atomic(notice, JSON.stringify({ files }))
  return files
}

export function addRecovery(notice: string, dir: string, file: string) {
  const files = pendingRecoveries(notice, dir).filter(existing => existing !== file)
  atomic(notice, JSON.stringify({ files: [...files, file] }))
}

export function clearRecoveries(notice: string) {
  rmSync(notice, { force: true })
}
