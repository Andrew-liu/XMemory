import { _electron as electron, expect, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { deflateSync, crc32 } from 'node:zlib'
import { createHash } from 'node:crypto'
import path from 'node:path'

// Performance baseline for the three reported stalls: memory search, inspiration editing, reading an image-heavy memory.
// Synthetic data only. Results are printed as JSON; thresholds are enforced only with XMEMEORY_PERF_ASSERT=1.
const MEMORIES = Number(process.env.XMEMEORY_PERF_MEMORIES || 2000)
const IMAGES = 30
const temporary = path.resolve(process.cwd(), '../../trash/xmemeory-dev/perf')
mkdirSync(temporary, { recursive: true })
const userData = mkdtempSync(path.join(temporary, 'profile-'))
const root = path.join(userData, 'library')

function png(width: number, height: number, seed: number) {
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]) }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height); let x = seed * 2654435761 >>> 0
  for (let i = 0; i < raw.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0; raw[i] = i % (width * 3 + 1) === 0 ? 0 : x & 255 }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))])
}
const words = ['模型', '推理', '产品', '增长', '写作', '开源', '工程', '用户', '数据', '设计', '记忆', '灵感', '平台', '市场', '团队']
const paragraph = (n: number, i: number) => Array.from({ length: 60 }, (_, k) => words[(n * 7 + i * 3 + k) % words.length]).join('') + '。'
mkdirSync(path.join(root, 'assets'), { recursive: true })
const imageRefs: string[] = []
for (let i = 0; i < IMAGES; i++) {
  const bytes = png(800, 600, i + 1); const name = `${createHash('sha256').update(bytes).digest('hex')}.png`
  writeFileSync(path.join(root, 'assets', name), bytes); imageRefs.push(`![图${i}](../../assets/${name})`)
}
for (let n = 0; n < MEMORIES; n++) {
  const account = 100 + (n % 40), id = 1_000_000 + n
  const published = new Date(Date.UTC(2025, 0, 1) + n * 3_600_000).toISOString()
  const heavy = n === 7
  const body = heavy
    ? Array.from({ length: IMAGES }, (_, i) => `${paragraph(n, i)}\n\n${imageRefs[i]}`).join('\n\n') + '\n\n重图长文专用词'
    : Array.from({ length: 12 }, (_, i) => paragraph(n, i)).join('\n\n') + `\n\n[原文](https://x.com/u${account}/status/${id})`
  const title = heavy ? '重图长文记忆' : `合成记忆 ${n}`
  const folder = path.join(root, 'memories', String(account)); mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, `${id}.md`),
    `---\nxmemeory_id: x-${account}-${id}\ntitle: ${title}\ncreatedAt: ${published}\nauthor: user${account}\nsource: https://x.com/u${account}/status/${id}\npublishedAt: ${published}\n---\n${body}\n`)
}

const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), XMEMEORY_TEST_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ ...(process.env.XMEMEORY_TEST_EXE ? { executablePath: process.env.XMEMEORY_TEST_EXE, args: [] } : { args: ['.'] }), env })

async function instrument(page: Page) {
  // Passed as a string: tsx would otherwise inject a __name helper that does not exist in the page.
  await page.evaluate(`(() => {
    const w = window
    w.__perf = { long: [], keys: [], gaps: [] }
    new PerformanceObserver(list => { for (const e of list.getEntries()) w.__perf.long.push(Math.round(e.duration)) }).observe({ type: 'longtask', buffered: false })
    // Input latency: beforeinput (fires for typed and IME-inserted text) until the frame after the DOM update is painted.
    addEventListener('beforeinput', () => { const t = performance.now(); requestAnimationFrame(() => setTimeout(() => w.__perf.keys.push(Math.round(performance.now() - t)), 0)) }, true)
    // Frame gaps over 50ms: the window could not paint or react during that time.
    let last = performance.now()
    const frame = now => { if (now - last > 50) w.__perf.gaps.push(Math.round(now - last)); last = now; requestAnimationFrame(frame) }
    requestAnimationFrame(frame)
  })()`)
}
async function collect(page: Page) {
  return page.evaluate(() => { const w = window as unknown as { __perf: { long: number[]; keys: number[]; gaps: number[] } }; const r = w.__perf; w.__perf = { long: [], keys: [], gaps: [] }; return r })
}
const summary = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return { n: s.length, max: s.at(-1) || 0, p50: s[Math.floor(s.length / 2)] || 0, total: s.reduce((a, b) => a + b, 0) } }

const results: Record<string, unknown> = { memories: MEMORIES, images: IMAGES }
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(60000)
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  const started = Date.now()
  await expect(page.getByRole('button', { name: '新灵感', exact: true })).toBeVisible()
  results.startupMs = Date.now() - started
  await instrument(page)

  // Scenario A: memory search.
  await page.locator('.sidebar nav').getByRole('button', { name: '记忆' }).click()
  await expect(page.locator('.note-card').first()).toBeVisible()
  await collect(page)
  const search = page.getByLabel('搜索记忆')
  await search.click()
  const typed = Date.now()
  await page.keyboard.type('产品增长 用户数据', { delay: 60 })
  await expect(page.locator('.note-card').first()).toBeVisible()
  results.searchTypeMs = Date.now() - typed
  await page.waitForTimeout(800)
  const a = await collect(page)
  results.search = { keys: summary(a.keys), longTasks: summary(a.long), frameGaps: summary(a.gaps) }

  // Scenario B: open the image-heavy memory and try to save an unrelated note while images load.
  await search.fill('重图长文专用词')
  await expect(page.locator('.note-card')).toHaveCount(1)
  await page.waitForTimeout(500); await collect(page)
  const opened = Date.now()
  await page.locator('.note-card').first().click()
  await expect(page.locator('.tiptap')).toBeVisible()
  results.openMemoryMs = Date.now() - opened
  const saveLatency = await page.evaluate(async () => { const t = performance.now(); await window.xm.save({ kind: 'inspiration', title: '读图时保存', body: 'x' }, undefined, { quiet: true }); return Math.round(performance.now() - t) })
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('.tiptap img')].filter(img => img.complete && img.naturalWidth > 0).length), { timeout: 60000 }).toBe(IMAGES)
  results.imagesLoadedMs = Date.now() - opened
  const b = await collect(page)
  results.read = { saveDuringLoadMs: saveLatency, longTasks: summary(b.long), frameGaps: summary(b.gaps) }
  // The asset protocol must refuse paths outside the library and non-image files.
  const refused = await page.evaluate(`Promise.all(['../../../../../../etc/hosts.png', 'assets/../../outside.png', '../../manifest.json'].map(p => new Promise(resolve => {
    const img = new Image(); img.onload = () => resolve('loaded'); img.onerror = () => resolve('refused')
    img.src = 'xm-asset://library/?p=' + encodeURIComponent(p) + '&from=' + encodeURIComponent('memories/100/1.md')
  })))`)
  expect(refused).toEqual(['refused', 'refused', 'refused'])

  // Scenario C: edit an inspiration in bursts so autosave (550ms idle) fires repeatedly.
  await page.getByRole('button', { name: '← 返回记忆' }).click()
  await search.fill('')
  await page.locator('.sidebar nav').getByRole('button', { name: '灵感' }).click()
  await page.getByRole('button', { name: '新灵感', exact: true }).click()
  await page.locator('.tiptap').click()
  await page.waitForTimeout(500); await collect(page)
  for (let round = 0; round < 6; round++) { await page.keyboard.type('今天想到一个写作选题', { delay: 80 }); await page.waitForTimeout(900) }
  await expect(page.getByText('已保存到本地', { exact: true })).toBeVisible()
  const c = await collect(page)
  results.edit = { keys: summary(c.keys), longTasks: summary(c.long), frameGaps: summary(c.gaps) }
  results.pageErrors = errors
  console.log(JSON.stringify(results, null, 2))
  if (process.env.XMEMEORY_PERF_ASSERT === '1') {
    const fail: string[] = []
    const s = results.search as { keys: { max: number }; longTasks: { max: number } }
    const e = results.edit as { keys: { max: number }; longTasks: { max: number } }
    const r = results.read as { saveDuringLoadMs: number }
    if (s.keys.max > 100) fail.push(`搜索按键最大延迟 ${s.keys.max}ms > 100ms`)
    if (s.longTasks.max > 200) fail.push(`搜索期间长任务 ${s.longTasks.max}ms > 200ms`)
    if (e.keys.max > 100) fail.push(`编辑按键最大延迟 ${e.keys.max}ms > 100ms`)
    if (e.longTasks.max > 200) fail.push(`编辑期间长任务 ${e.longTasks.max}ms > 200ms`)
    if (r.saveDuringLoadMs > 300) fail.push(`读图期间保存耗时 ${r.saveDuringLoadMs}ms > 300ms`)
    if ((results.openMemoryMs as number) > 1500) fail.push(`打开重图记忆 ${results.openMemoryMs}ms > 1500ms`)
    if (errors.length) fail.push(`页面错误：${errors.join('; ')}`)
    if (fail.length) throw new Error(fail.join('\n'))
    console.log('PASS: 搜索、编辑、读图性能达标')
  }
} finally { await app.close() }
