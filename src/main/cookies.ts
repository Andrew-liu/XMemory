import { readFileSync, lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { hash } from './library'
export interface CookieRecord { name: string; value: string; domain: string; path: string; secure: boolean; expirationDate?: number; httpOnly?: boolean }
export function parseCookies(text: string): CookieRecord[] {
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Cookie 文件超过 1 MiB')
  const raw = text.replace(/^\uFEFF/, '').trim()
  let values: CookieRecord[]
  if (raw.startsWith('[')) values = JSON.parse(raw)
  else {
    if (!raw.includes('\t')) throw new Error('请选择 Netscape 或 JSON 导出格式')
    values = raw.split(/\r?\n/).filter(l => l.trim() && (!l.startsWith('#') || l.startsWith('#HttpOnly_'))).map(line => {
      const parts = line.replace(/^#HttpOnly_/, '').split('\t')
      if (parts.length !== 7) throw new Error('Cookie 文件列数不正确')
      return { domain: parts[0], path: parts[2], secure: parts[3] === 'TRUE', expirationDate: Number(parts[4]) || undefined, name: parts[5], value: parts[6], httpOnly: line.startsWith('#HttpOnly_') }
    })
  }
  if (!Array.isArray(values)) throw new Error('Cookie JSON 应为数组')
  const now = Date.now() / 1000
  const unique = new Map<string, CookieRecord>()
  for (const v of values) {
    if (!v || !/^\.?x\.com$/.test(v.domain)) continue
    if (typeof v.name !== 'string' || typeof v.value !== 'string' || /[\r\n;]/.test(v.name + v.value) || !v.path?.startsWith('/')) throw new Error('Cookie 字段无效')
    if (v.expirationDate && v.expirationDate < now) continue
    unique.set(`${v.domain}:${v.path}:${v.name}`, v)
  }
  const selected = [...unique.values()]
  if (!selected.some(v => v.name === 'auth_token') || !selected.some(v => v.name === 'ct0')) throw new Error('缺少有效的 X 登录字段，请登录 X 后重新导出当前站点')
  return selected
}
export class CookieWatcher {
  status = '尚未选择自动接收目录，也未导入文件'
  private watcher?: FSWatcher
  private fingerprints = new Set<string>()
  private queue: Promise<void> = Promise.resolve()
  private generation = 0
  constructor(private receive: (cookies: CookieRecord[]) => Promise<void>, private changed: (message: string) => void) {}
  private report(message: string) { this.status = message; this.changed(message) }
  import(file: string) {
    const generation = this.generation
    const job = this.queue.catch(() => {}).then(async () => {
      if (generation !== this.generation) return
      try { await this.read(file) }
      catch (e) { const message = e instanceof SyntaxError ? 'Cookie JSON 格式错误，请重新导出' : e instanceof Error ? e.message : 'Cookie 文件无法读取'; this.report(`导入失败：${message}`); throw new Error(message) }
    })
    this.queue = job; return job
  }
  private async read(file: string) {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('请选择实际 Cookie 文件，不支持文件夹或符号链接')
    if (stat.size > 1024 * 1024) throw new Error('Cookie 文件过大')
    const raw = readFileSync(file, 'utf8'); const fp = hash(raw)
    if (this.fingerprints.has(fp)) { this.report('文件已导入，内容未变化；等待新导出文件'); return }
    const cookies = parseCookies(raw)
    await this.receive(cookies)
    this.fingerprints.add(fp)
    this.report(`已导入 ${path.basename(file)} · ${new Date().toLocaleTimeString('zh-CN')}；已加密保存，X 登录尚需验证`)
  }
  async watch(directory: string) {
    await this.close()
    this.report('正在监听导出目录，等待 Cookie 文件…')
    const candidate = (file: string) => /^(?:x\.com(?:_cookies)?|cookies)(?: \(\d+\))?\.(txt|json)$/i.test(path.basename(file))
    const importCandidate = (file: string) => {
      if (!candidate(file)) return
      void this.import(file).catch(() => {})
    }
    this.watcher = chokidar.watch(directory, { depth: 0, followSymlinks: false, ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 } })
    this.watcher.on('add', importCandidate).on('change', importCandidate)
    this.watcher.on('error', () => this.report('目录监听失败，请重新选择可访问的导出目录'))
    await new Promise<void>((resolve, reject) => { this.watcher!.once('ready', resolve); this.watcher!.once('error', reject) })
    const files = readdirSync(directory).filter(candidate).map(f => path.join(directory, f)).filter(f => lstatSync(f).isFile() && !lstatSync(f).isSymbolicLink()).sort((a,b) => lstatSync(b).mtimeMs - lstatSync(a).mtimeMs)
    if (files[0]) await this.import(files[0]).catch(() => {})
    else this.report('目录监听已就绪，未找到 Cookie 文件；请把 x.com_cookies.txt 或 cookies.txt 导出到此目录')
  }
  async close() { this.generation++; await this.watcher?.close(); await this.queue.catch(() => {}) }
}
