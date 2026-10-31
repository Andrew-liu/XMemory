import { gzipSync } from 'node:zlib'

/** Minimal ustar writer for tests, shaped like GitHub's `git archive` output: a global pax header, then pax long names. */
function header(name: string, size: number, type: string) {
  const block = Buffer.alloc(512)
  block.write(name.slice(0, 99), 0, 'utf8')
  block.write('0000644\0', 100)
  block.write('0000000\0', 108); block.write('0000000\0', 116)
  block.write(size.toString(8).padStart(11, '0') + '\0', 124)
  block.write('00000000000\0', 136)
  block.write(type, 156)
  block.write('ustar\0', 257); block.write('00', 263)
  block.fill(' ', 148, 156)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return block
}
const padded = (data: Buffer) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)])
function pax(key: string, value: string) {
  const body = ` ${key}=${value}\n`
  let length = Buffer.byteLength(body) + 1
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body)
  return Buffer.from(`${length}${body}`)
}

export function tarBuffer(files: [string, Buffer][], prefix = 'owner-repo-0123abc/') {
  const blocks: Buffer[] = []
  const comment = pax('comment', '0123abc0123abc0123abc0123abc0123abc0123a')
  blocks.push(header('pax_global_header', comment.length, 'g'), padded(comment))
  blocks.push(header(prefix, 0, '5'))
  for (const [name, data] of files) {
    const full = prefix + name
    if (Buffer.byteLength(full) > 99) {
      const record = pax('path', full)
      blocks.push(header('PaxHeader/long', record.length, 'x'), padded(record))
    }
    blocks.push(header(Buffer.byteLength(full) > 99 ? 'long-name-placeholder' : full, data.length, '0'), padded(data))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}
export const tarGz = (files: [string, Buffer][]) => gzipSync(tarBuffer(files))
/** A fetch body that delivers `bytes` in small chunks, like a real network stream. */
export function chunkedBody(bytes: Buffer, size = 1000) {
  let offset = 0
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return }
    controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + size))); offset += size
  } })
}
