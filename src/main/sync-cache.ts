import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, lstatSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { atomic, safePath } from './library'

export function gitBlobHash(bytes: Buffer) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}
const validSha = (sha: string) => /^[a-f0-9]{40}$/.test(sha)
export class SyncCache {
  constructor(private root: string, private scope: string) {}
  private file(sha: string) { return safePath(this.root, `local/sync-cache/${this.scope}/${sha}`) }
  read(sha: string): Buffer | undefined {
    if (!validSha(sha)) return
    try {
      const file = this.file(sha)
      if (!existsSync(file) || lstatSync(file).size > 20 * 1024 * 1024) return
      const bytes = readFileSync(file)
      if (gitBlobHash(bytes) === sha) return bytes
    } catch { /* A missing/unreadable cache is a miss, not a sync failure. */ }
  }
  put(bytes: Buffer) {
    const sha = gitBlobHash(bytes)
    if (this.read(sha)) return
    try { atomic(this.file(sha), bytes) } catch { /* Cache is optional. */ }
  }
  prune(keep: Set<string>) {
    try {
      const directory = safePath(this.root, `local/sync-cache/${this.scope}`)
      for (const name of readdirSync(directory)) {
        if (validSha(name) && !keep.has(name)) { const file = this.file(name); if (lstatSync(file).isFile()) unlinkSync(file) }
      }
    } catch { /* Cleanup failure must not invalidate a successful sync. */ }
  }
}
