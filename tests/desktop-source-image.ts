import { _electron as electron, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve('../../trash/xmemeory-dev/source-image')
mkdirSync(root, { recursive: true })
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), XMEMEORY_TEST_DATA: mkdtempSync(path.join(root, 'profile-')) }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.getByRole('button', { name: '新灵感', exact: true }).click()
  await page.getByRole('button', { name: '切换 Markdown 源码' }).click()
  const source = page.getByRole('textbox', { name: 'Markdown 源码' })
  await source.fill('刚写入的正文不能丢失\n\n插图位置\n\n末尾保留')
  await source.evaluate((input: HTMLTextAreaElement) => { const pos = input.value.indexOf('插图位置'); input.focus(); input.setSelectionRange(pos, pos + 4) })
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') })
  await expect.poll(async () => (await page.evaluate(() => window.xm.snapshot())).notes[0]?.body).toContain('![synthetic.png]')
  const note = (await page.evaluate(() => window.xm.snapshot())).notes[0]
  expect(note.body).toContain('刚写入的正文不能丢失')
  expect(note.body).toContain('末尾保留')
  expect(note.body).not.toContain('插图位置')
  await page.locator('input[type=file]').setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') })
  await expect.poll(async () => (await page.evaluate(() => window.xm.snapshot())).notes[0]?.body).toContain('![second.png]')
  const repeated = (await page.evaluate(() => window.xm.snapshot())).notes[0].body
  expect(repeated).toContain('![synthetic.png]')
  expect(repeated).toContain('刚写入的正文不能丢失')
  expect(repeated).toContain('末尾保留')
  console.log('PASS: source image insertion preserves latest text and replaces selection')
} finally { await app.close() }
