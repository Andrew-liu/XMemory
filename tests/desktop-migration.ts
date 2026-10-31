import { _electron as electron, expect } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { legacyLibrary } from './legacy-fixture'

// Launches the real app on a v0.6.0 style library: it must upgrade in place, keep every note, show the notice,
// move deleted notes into the private trash and display migrated images through xm-asset://.
const temporary = path.resolve('../../trash/xmemeory-dev/migration-desktop')
mkdirSync(temporary, { recursive: true })
const userData = mkdtempSync(path.join(temporary, 'profile-'))
const { root } = legacyLibrary()
writeFileSync(path.join(userData, 'library-path.json'), JSON.stringify(root))
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), XMEMEORY_TEST_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE
const launch = () => electron.launch({ ...(process.env.XMEMEORY_TEST_EXE ? { executablePath: process.env.XMEMEORY_TEST_EXE, args: [] } : { args: ['.'] }), env })
let app = await launch()
try {
  let page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await expect(page.locator('.sidebar')).toBeVisible()
  const snapshot = await page.evaluate(() => window.xm.snapshot())
  expect(snapshot.notes).toHaveLength(5)
  expect(snapshot.status).toContain('已升级为 Obsidian 兼容结构')
  expect(snapshot.notes.find(n => n.id === 'x-11-444')).toMatchObject({ deleted: true })
  expect(readdirSync(root).filter(f => !f.startsWith('.')).sort()).toEqual(['attachments', 'drafts', 'inspirations', 'manifest.json', 'memories', 'topics'])
  expect(existsSync(path.join(root, '.obsidian/app.json'))).toBe(true)
  expect(readdirSync(path.join(root, '.xmemeory')).some(f => f.startsWith('backup-'))).toBe(true)

  // Open the migrated memory: its image must load through the asset protocol.
  await page.locator('.sidebar nav').getByRole('button', { name: '记忆' }).click()
  await page.locator('.note-card').filter({ hasText: '正文第一段' }).click()
  await expect.poll(() => page.evaluate(() => { const img = document.querySelector<HTMLImageElement>('.tiptap img.local-image'); return img ? `${img.src.split(':')[0]}:${img.naturalWidth}` : '' })).toBe('xm-asset:1')

  // Delete from the UI: the file moves to the private trash, restore moves it back.
  const memory = snapshot.notes.find(n => n.id === 'x-11-222')!
  await page.evaluate(id => window.xm.remove(id), memory.id)
  expect(existsSync(path.join(root, memory.path))).toBe(false)
  expect(existsSync(path.join(root, '.xmemeory/trash', memory.path))).toBe(true)
  await page.evaluate(id => window.xm.remove(id, true), memory.id)
  expect(existsSync(path.join(root, memory.path))).toBe(true)

  // A second launch must not upgrade again or show the notice again.
  await app.close()
  const backups = readdirSync(path.join(root, '.xmemeory')).filter(f => f.startsWith('backup-'))
  app = await launch(); page = await app.firstWindow()
  await expect(page.locator('.sidebar')).toBeVisible()
  const again = await page.evaluate(() => window.xm.snapshot())
  expect(again.notes).toHaveLength(5)
  expect(again.status).not.toContain('已升级')
  expect(readdirSync(path.join(root, '.xmemeory')).filter(f => f.startsWith('backup-'))).toEqual(backups)
  expect(readFileSync(path.join(root, 'manifest.json'), 'utf8')).toContain('"schemaVersion":2')
  expect(errors).toEqual([])
  console.log('PASS: 旧库自动升级（备份、结构、条目、回收站、图片协议显示）、删除恢复在磁盘上移动文件、二次启动不重复升级')
} finally { await app.close() }
