import { _electron as electron, expect } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'

const temporary = path.resolve(process.cwd(), '../../trash/xmemeory-dev/desktop-recovery')
mkdirSync(temporary, { recursive: true })
const userData = mkdtempSync(path.join(temporary, 'profile-'))
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), XMEMEORY_TEST_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE
const args = process.env.XMEMEORY_TEST_EXE ? [] : ['.']
const app = await electron.launch({ ...(process.env.XMEMEORY_TEST_EXE ? { executablePath: process.env.XMEMEORY_TEST_EXE } : {}), args, env })
try {
  const page = await app.firstWindow()
  await expect(page.getByRole('button', { name: '新灵感', exact: true })).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  const executable = await app.evaluate(() => process.execPath)
  const second = spawn(executable, args, { env, windowsHide: true, stdio: 'ignore' })
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => { second.kill(); reject(new Error('重复实例未退出')) }, 10000)
    second.once('error', error => { clearTimeout(timeout); reject(error) })
    second.once('exit', code => { clearTimeout(timeout); resolve(code) })
  })
  expect(code).toBe(0)
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true)
  await page.getByRole('button', { name: '新灵感', exact: true }).click()
  await page.getByRole('button', { name: '切换 Markdown 源码' }).click()
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill('原始内容')
  await expect(page.getByText('已保存到本地', { exact: true })).toBeVisible()
  const snapshot = await page.evaluate(() => window.xm.snapshot())
  const note = snapshot.notes[0]
  const file = path.join(snapshot.library, note.path)
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox })
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill('窗口中尚未保存的正文')
  writeFileSync(file, readFileSync(file, 'utf8').replace('原始内容', '外部冲突内容'))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), { timeout: 10000 }).toBe(false)
  const recovery = path.join(userData, 'recovery')
  expect(existsSync(recovery) ? readdirSync(recovery).filter(f => f.endsWith('.md')) : []).toHaveLength(0)
  expect(readFileSync(file, 'utf8')).toContain('外部冲突内容')
  const conflicts = (await page.evaluate(() => window.xm.snapshot())).conflicts
  expect(conflicts).toHaveLength(1)
  expect(conflicts[0].current.body).toContain('外部冲突内容')
  expect(conflicts[0].incoming.body).toContain('窗口中尚未保存的正文')
  console.log('PASS: 重复启动退出并唤醒已有窗口；保存冲突完整保留双方且不重复生成恢复副本；窗口可正常关闭')
} finally { await app.close() }
