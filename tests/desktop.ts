import { _electron as electron, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const temporary = path.resolve(process.cwd(), '../../trash/xmemeory-dev/desktop')
mkdirSync(temporary, { recursive: true })
const userData = mkdtempSync(path.join(temporary, 'profile-'))
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), XMEMEORY_TEST_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ ...(process.env.XMEMEORY_TEST_EXE ? { executablePath: process.env.XMEMEORY_TEST_EXE, args: [] } : { args: ['.'] }), env })
const errors: string[] = []
try {
  const page = await app.firstWindow()
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') console.error('renderer:', m.text()) })
  page.on('requestfailed', request => console.error('request failed:', request.url()))
  await page.waitForLoadState('load')
  await expect(page.getByRole('button', { name: '新灵感', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '新灵感', exact: true }).click()
  await page.getByRole('textbox', { name: '标题', exact: true }).fill('桌面验收灵感')
  const linked = await page.evaluate(() => window.xm.save({ kind: 'inspiration', title: '链接目标', body: '## 段落\n目标正文' }))
  const markdown = `本机保存验收\n\n[外部链接](https://example.com/test?a=1&b=2)\n\n[本地笔记](${linked.id}.md)\n\n[[链接目标|别名]]\n\n| 标题 | 内容 |\n| :--- | ---: |\n| 表格 | [表格链接](https://example.com) |\n| 双链 | [[链接目标|表格别名]] |`
  await page.getByRole('button', { name: '切换 Markdown 源码' }).click()
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill(markdown)
  await expect(page.getByText('已保存到本地', { exact: true })).toBeVisible()
  const snapshot = await page.evaluate(() => window.xm.snapshot())
  const note = snapshot.notes.find(n => n.title === '桌面验收灵感')!
  expect(note.body).toContain('本机保存验收')
  const file = path.join(snapshot.library, note.path)
  writeFileSync(file, readFileSync(file, 'utf8').replace('本机保存验收', '外部修改回读验收'))
  await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toContainText('外部修改回读验收', { timeout: 10000 })
  await page.getByRole('button', { name: '切换 Markdown 源码' }).click()
  await expect(page.locator('.tiptap table')).toBeVisible()
  await expect(page.locator('.tiptap table tr')).toHaveCount(3)
  await expect(page.getByRole('link', { name: '外部链接', exact: true })).toHaveAttribute('href', 'https://example.com/test?a=1&b=2')
  await expect(page.locator('.tiptap table a')).toHaveAttribute('href', 'https://example.com')
  await expect(page.locator('.tiptap table .wiki-link')).toContainText('表格别名')
  await page.getByRole('link', { name: '本地笔记', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '标题', exact: true })).toHaveValue('链接目标')
  await page.getByRole('heading', { name: '桌面验收灵感' }).click()
  await expect(page.locator('.tiptap table')).toBeVisible()
  await page.locator('.tiptap').click()
  await app.evaluate(async ({ clipboard, nativeImage, ClipboardItem }) => {
    const bitmap = Buffer.alloc(16 * 16 * 4, 255)
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(nativeImage.createFromBitmap(bitmap, { width: 16, height: 16 }).toPNG())], { type: 'image/png' }) })])
  })
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Control+V')
  const localImage = page.locator('.tiptap img.local-image')
  await expect(localImage).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.xm.snapshot())).notes.find(n => n.title === '桌面验收灵感')?.body).toContain('../assets/')
  await localImage.click()
  await page.keyboard.press('Control+C')
  await expect.poll(() => app.evaluate(async ({ clipboard }) => (await clipboard.has('image/png')))).toBe(true)
  await expect.poll(() => app.evaluate(async ({ clipboard }) => (await clipboard.has('text/html')))).toBe(false)
  const copiedImage = await app.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read()
    const image = items.find(item => item.types.includes('image/png'))
    const html = items.find(item => item.types.includes('text/html'))
    return {
      pngSize: image ? (await image.getType('image/png') as Blob).size : 0,
      html: html ? await (await html.getType('text/html') as Blob).text() : ''
    }
  })
  expect(copiedImage.pngSize).toBeGreaterThan(0)
  expect(copiedImage.html).toBe('')
  await page.screenshot({ path: path.join(temporary, 'desktop-editor.png') })
  await page.getByRole('button', { name: '切换 Markdown 源码' }).click()
  await expect(page.getByRole('textbox', { name: 'Markdown 源码' })).toContainText('[表格链接](https://example.com)')
  await page.getByRole('button', { name: '切换 Markdown 源码' }).click()
  await expect(page.locator('.tiptap table .wiki-link')).toContainText('表格别名')
  await page.getByRole('button', { name: '切换 Markdown 源码' }).click()
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill('立即关闭窗口也应保存')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('立即关闭窗口也应保存')
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
  await page.getByRole('button', { name: '搜索所有内容' }).click()
  await page.getByPlaceholder('搜索灵感、记忆和候选稿…').fill('关闭窗口')
  await expect(page.getByRole('heading', { name: '桌面验收灵感' })).toBeVisible()
  await page.screenshot({ path: path.join(temporary, 'desktop-search.png') })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const cookieDirectory = path.join(userData, 'synthetic-cookie-exports')
  mkdirSync(cookieDirectory)
  const fakeCookies = (value: string) => JSON.stringify(['auth_token','ct0'].map(name => ({ domain: '.x.com', path: '/', name, value })))
  writeFileSync(path.join(cookieDirectory, 'cookies.txt'), fakeCookies('synthetic-one'))
  await app.evaluate(({ dialog }, folder) => {
    const original = dialog.showOpenDialog
    dialog.showOpenDialog = (async () => { dialog.showOpenDialog = original; return { canceled: false, filePaths: [folder] } }) as typeof dialog.showOpenDialog
  }, cookieDirectory)
  await page.getByText('备用：导入 Cookie 文件').click()
  await page.getByRole('button', { name: '选择自动接收目录', exact: true }).click()
  await expect(page.getByLabel('Cookie 导入状态')).toContainText('已导入 cookies.txt')
  writeFileSync(path.join(cookieDirectory, 'x.com_cookies (1).json'), fakeCookies('synthetic-two'))
  await expect(page.getByLabel('Cookie 导入状态')).toContainText('已导入 x.com_cookies (1).json', { timeout: 10000 })
  expect(readFileSync(path.join(userData, 'credentials.bin')).includes(Buffer.from('synthetic-two'))).toBe(false)
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.getByLabel('Cookie 导入状态')).toContainText('已退出登录')
  await page.getByRole('button', { name: '深色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.screenshot({ path: path.join(temporary, 'desktop-dark.png') })
  expect(errors).toEqual([])
  console.log(JSON.stringify({ result: 'PASS', userData, screenshots: temporary, checks: ['Electron 窗口', 'Markdown 保存', '外部编辑回读', '表格渲染', '系统剪贴板粘贴图片', '关闭前保存与托盘隐藏', '中文全局搜索', '深色设置', '无渲染异常'] }))
} finally { await app.close() }
