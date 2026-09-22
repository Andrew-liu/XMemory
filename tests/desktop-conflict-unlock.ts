import { _electron as electron, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const temporary = path.resolve(process.cwd(), '../../trash/xmemeory-dev/conflict-unlock')
mkdirSync(temporary, { recursive: true })
const userData = mkdtempSync(path.join(temporary, 'profile-'))
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), XMEMEORY_TEST_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ ...(process.env.XMEMEORY_TEST_EXE ? { executablePath: process.env.XMEMEORY_TEST_EXE, args: [] } : { args: ['.'] }), env })
const errors: string[] = []
try {
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await expect(page.getByRole('button', { name: '新灵感', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '新灵感', exact: true }).click()
  await page.getByRole('textbox', { name: '标题', exact: true }).fill('冲突解锁验收')
  await page.getByRole('button', { name: '切换 Markdown 源码' }).click()
  const source = page.getByRole('textbox', { name: 'Markdown 源码' })
  await source.fill('原始正文')
  await expect(page.getByText('已保存到本地', { exact: true })).toBeVisible()
  const snapshot = await page.evaluate(() => window.xm.snapshot())
  const note = snapshot.notes.find(item => item.title === '冲突解锁验收')!
  const file = path.join(snapshot.library, note.path)
  await source.fill('编辑器中的版本')
  writeFileSync(file, readFileSync(file, 'utf8').replace('原始正文', '外部同步后的版本'))
  await expect(page.locator('.error-banner')).toContainText('检测到外部修改', { timeout: 10000 })
  await expect(page.getByText('已保留双方 · 请处理冲突', { exact: true })).toBeVisible()
  await expect(source).toHaveValue('外部同步后的版本')
  const current = await page.evaluate(() => window.xm.snapshot())
  expect(current.conflicts).toHaveLength(1)
  expect(current.conflicts[0].current.body).toBe('外部同步后的版本')
  expect(current.conflicts[0].incoming.body).toBe('编辑器中的版本')
  await page.getByRole('button', { name: /待处理冲突/ }).click()
  await expect(page.getByRole('heading', { name: '保留每一个版本' })).toBeVisible()
  await expect(page.locator('.conflict-card')).toHaveCount(1)
  expect(errors).toEqual([])
  console.log('PASS: 外部修改冲突完整保留双方；编辑器解除重复保存锁；冲突页面可正常打开')
} finally {
  await app.close()
}
