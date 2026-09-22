import { _electron as electron, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve('../../trash/xmemeory-dev/search-location')
mkdirSync(root, { recursive: true })
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), XMEMEORY_TEST_DATA: mkdtempSync(path.join(root, 'profile-')) }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  const note = await page.evaluate(async () => window.xm.save({ kind: 'inspiration', title: '标题专有词', body: Array.from({ length: 70 }, (_, i) => `第${i}段普通正文`).join('\n\n') + '\n\n目标**定位**短语\n\n[链接](https://example.com/hidden-target)' }))
  await page.getByRole('button', { name: '搜索所有内容' }).click()
  const search = page.getByPlaceholder('搜索灵感、记忆、选题和候选稿…')
  await search.fill('定位')
  await page.locator('.note-card').filter({ hasText: '标题专有词' }).click()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('定位')
  expect(await page.evaluate(() => {
    const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect()
    return rect.top >= 0 && rect.bottom <= innerHeight
  })).toBe(true)
  await page.locator('.note-card').filter({ hasText: '标题专有词' }).click()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('定位')
  await search.fill('hidden-target')
  await page.locator('.note-card').filter({ hasText: '标题专有词' }).click()
  const source = page.getByRole('textbox', { name: 'Markdown 源码' })
  await expect(source).toBeVisible()
  expect(await source.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe('hidden-target')
  await search.fill('标题专有词')
  await page.locator('.note-card').filter({ hasText: '标题专有词' }).click()
  await expect(page.getByRole('status')).toContainText('正文无匹配')
  const after = await page.evaluate(async id => (await window.xm.snapshot()).notes.find(n => n.id === id), note.id)
  expect(after?.hash).toBe(note.hash)
  expect(after?.updatedAt).toBe(note.updatedAt)
  expect(errors).toEqual([])
  console.log('PASS: rich-text scroll and selection, repeated click, Markdown URL fallback, title-only notice, no content changes')
} finally { await app.close() }
