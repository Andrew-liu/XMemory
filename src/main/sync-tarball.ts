import { createGunzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { gitBlobHash } from './sync-cache'

const BLOCK = 512
const MAX_FILE = 20 * 1024 * 1024

/** Entry size from a ustar header: octal text, or GNU base-256 when the high bit is set. */
function entrySize(header: Buffer) {
  if (header[124] & 0x80) {
    let size = 0
    for (let i = 125; i < 136; i++) size = size * 256 + header[i]
    return size
  }
  const text = header.subarray(124, 136).toString('latin1').replace(/[\0 ]+$/g, '').trim()
  const size = text ? parseInt(text, 8) : 0
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('打包文件格式无效')
  return size
}

export interface TarballResult { entries: number; matched: number; bytes: number }

/**
 * Stream an uncompressed tar archive and hand every regular file whose Git blob SHA is in `wanted` to `put`.
 * Paths are never used: content is matched by SHA, so pax/GNU long-name records are simply skipped.
 */
export async function scanTar(chunks: AsyncIterable<Buffer | Uint8Array>, wanted: Set<string>, put: (sha: string, bytes: Buffer) => void, progress: (result: TarballResult) => void = () => {}): Promise<TarballResult> {
  const result: TarballResult = { entries: 0, matched: 0, bytes: 0 }
  const header = Buffer.alloc(BLOCK)
  let filled = 0
  let state: 'header' | 'body' | 'pad' | 'end' = 'header'
  let left = 0, pad = 0, keep = false
  let parts: Buffer[] = []
  for await (const raw of chunks) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    result.bytes += chunk.length
    let pos = 0
    while (pos < chunk.length && state !== 'end') {
      if (state === 'header') {
        const n = Math.min(BLOCK - filled, chunk.length - pos)
        chunk.copy(header, filled, pos, pos + n); filled += n; pos += n
        if (filled < BLOCK) break
        filled = 0
        if (header.every(byte => byte === 0)) { state = 'end'; break }
        const size = entrySize(header), type = header[156]
        // '0', NUL and '7' are regular files; everything else (dirs, links, pax 'x'/'g', GNU 'L') is skipped.
        keep = (type === 0x30 || type === 0 || type === 0x37) && size <= MAX_FILE
        if (type === 0x30 || type === 0 || type === 0x37) result.entries++
        left = size; pad = (BLOCK - (size % BLOCK)) % BLOCK; parts = []
        if (left === 0) { if (keep) finish(Buffer.alloc(0)); state = pad ? 'pad' : 'header' }
        else state = 'body'
      } else if (state === 'body') {
        const n = Math.min(left, chunk.length - pos)
        if (keep) parts.push(chunk.subarray(pos, pos + n))
        left -= n; pos += n
        if (left === 0) { if (keep) finish(Buffer.concat(parts)); parts = []; state = pad ? 'pad' : 'header' }
      } else {
        const n = Math.min(pad, chunk.length - pos)
        pad -= n; pos += n
        if (pad === 0) state = 'header'
      }
    }
    progress(result)
  }
  // Every complete archive ends with zero blocks; a stream that stops anywhere else was cut off.
  if (state !== 'end') throw new Error('打包文件不完整')
  return result

  function finish(bytes: Buffer) {
    const sha = gitBlobHash(bytes)
    if (!wanted.has(sha)) return
    wanted.delete(sha)
    put(sha, bytes)
    result.matched++
  }
}

/** Gunzip a web stream (a fetch body) and scan it as tar. */
export function scanTarGz(body: ReadableStream<Uint8Array>, wanted: Set<string>, put: (sha: string, bytes: Buffer) => void, progress?: (result: TarballResult) => void) {
  const gunzip = createGunzip()
  const source = Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>)
  // pipe() does not forward source errors; without this a dropped connection would hang the scan.
  source.on('error', error => gunzip.destroy(error))
  source.pipe(gunzip)
  return scanTar(gunzip, wanted, put, progress)
}
