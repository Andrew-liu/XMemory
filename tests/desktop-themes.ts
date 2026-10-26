import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { paletteNames, palettes, themes } from '../src/shared/themes'

const temporary = path.resolve(process.cwd(), '../../trash/xmemeory-dev/themes')
mkdirSync(temporary, { recursive: true })
const baseEnv: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
delete baseEnv.ELECTRON_RUN_AS_NODE
const launch = (userData: string) => electron.launch({ ...(process.env.XMEMEORY_TEST_EXE ? { executablePath: process.env.XMEMEORY_TEST_EXE, args: [] } : { args: ['.'] }), env: { ...baseEnv, XMEMEORY_TEST_DATA: userData } })
const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`
const windowColor = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase())
const errors: string[] = []
async function ready(app: ElectronApplication) {
  const page = await app.firstWindow()
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.waitForLoadState('load')
  await expect(page.getByRole('button', { name: '新灵感', exact: true })).toBeVisible()
  return page
}
const settingsNav = (page: Page) => page.getByRole('button', { name: '设置', exact: true })

const userData = mkdtempSync(path.join(temporary, 'profile-'))
const shots: { label: string; file: string }[] = []
let app = await launch(userData)
try {
  let page = await ready(app)
  for (let i = 0; i < 4; i++) await page.evaluate(n => window.xm.save({ kind: 'memory', title: `合成记忆 ${n + 1}：本地优先的写作工作流`, body: '这是一段用于主题截图的合成正文，验证卡片、标签和次要文字在不同配色下的可读性。', author: 'sample', tags: n % 2 ? ['写作'] : [] }), i)
  await settingsNav(page).click()
  await expect(page.getByRole('button', { name: '配色：雾蓝' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'mist')
  for (const mode of ['light', 'dark'] as const) {
    await settingsNav(page).click()
    await page.getByRole('button', { name: mode === 'dark' ? '深色' : '浅色', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
    for (const palette of palettes) {
      await settingsNav(page).click()
      await page.getByRole('button', { name: `配色：${paletteNames[palette]}` }).click()
      const c = themes[palette][mode]
      await expect(page.locator('html')).toHaveAttribute('data-palette', palette)
      await expect(page.getByRole('button', { name: `配色：${paletteNames[palette]}` })).toHaveAttribute('aria-pressed', 'true')
      await expect.poll(() => windowColor(app)).toContain(c.bg.slice(1))
      await page.locator('.sidebar nav').getByRole('button', { name: '记忆' }).click()
      const primary = page.locator('.auto-collect').getByRole('button', { name: '开启自动采集', exact: true })
      await expect(primary).toHaveCSS('background-color', rgb(c.accent))
      await expect(primary).toHaveCSS('color', rgb(c.onAccent))
      await page.getByRole('button', { name: /合成记忆 1/ }).click()
      await expect(page.getByRole('button', { name: '← 返回记忆' })).toHaveCSS('border-top-color', rgb(c.control))
      const file = path.join(temporary, `${palette}-${mode}.png`)
      await page.screenshot({ path: file })
      shots.push({ label: `${paletteNames[palette]} · ${mode === 'dark' ? '深色' : '浅色'}`, file })
    }
  }
  await settingsNav(page).click()
  await page.getByRole('button', { name: '配色：青瓷' }).click()
  await expect(page.getByRole('button', { name: '配色：青瓷' })).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: path.join(temporary, 'settings-jade-dark.png') })
  await page.locator('.sidebar nav').getByRole('button', { name: '灵感' }).click()
  await page.screenshot({ path: path.join(temporary, 'calendar-jade-dark.png') })
  await app.close()

  app = await launch(userData)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  expect(await page.evaluate(() => document.documentElement.dataset.palette), '首帧沿用缓存配色').toBe('jade')
  page = await ready(app)
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'jade')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await windowColor(app)).toContain(themes.jade.dark.bg.slice(1))
  await app.close()

  const broken = mkdtempSync(path.join(temporary, 'profile-'))
  writeFileSync(path.join(broken, 'settings.json'), JSON.stringify({ theme: 'dark', palette: 'neon', closeToTray: true, branch: 'main' }))
  app = await launch(broken)
  page = await ready(app)
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'mist')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await windowColor(app)).toContain(themes.mist.dark.bg.slice(1))
  expect(JSON.parse(readFileSync(path.join(broken, 'settings.json'), 'utf8')).palette).toBeUndefined()

  const tiles = shots.map(s => `<figure><img src="data:image/png;base64,${readFileSync(s.file).toString('base64')}"><figcaption>${s.label}</figcaption></figure>`).join('')
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:16px;background:#e9eaee;font:600 18px 'Microsoft YaHei',sans-serif;display:grid;grid-template-columns:repeat(3,1fr);gap:14px}figure{margin:0}img{width:100%;display:block;border-radius:6px;box-shadow:0 2px 8px #0002}figcaption{padding:6px 2px}</style>${tiles}`
  writeFileSync(path.join(temporary, 'sheet.html'), html)
  const sheetPng = await app.evaluate(async ({ BrowserWindow }, file) => {
    const sheet = new BrowserWindow({ show: false, width: 2400, height: 2000, webPreferences: { offscreen: true } })
    await sheet.loadFile(file)
    const height = await sheet.webContents.executeJavaScript('document.documentElement.scrollHeight')
    sheet.setContentSize(2400, height)
    await new Promise(r => setTimeout(r, 400))
    const image = await sheet.webContents.capturePage()
    sheet.destroy()
    return image.toPNG().toString('base64')
  }, path.join(temporary, 'sheet.html')).catch(e => { errors.push(`拼图失败：${(e as Error).message}`); return '' })
  if (sheetPng) writeFileSync(path.join(temporary, 'contact-sheet.png'), Buffer.from(sheetPng, 'base64'))
  expect(errors).toEqual([])
  console.log(JSON.stringify({ result: 'PASS', screenshots: temporary, checks: ['12 组配色切换', '主按钮底色与文字色', '次级按钮边框', '窗口底色同步', '重启保持与首帧缓存', '非法配色回退'] }))
} finally { await app.close().catch(() => {}) }
