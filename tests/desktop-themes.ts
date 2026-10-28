import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { themes } from '../src/shared/themes'

const temporary = path.resolve(process.cwd(), '../../trash/xmemeory-dev/themes')
mkdirSync(temporary, { recursive: true })
const baseEnv: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
delete baseEnv.ELECTRON_RUN_AS_NODE
const launch = (userData: string, size?: { width: number; height: number }) => electron.launch({ ...(process.env.XMEMEORY_TEST_EXE ? { executablePath: process.env.XMEMEORY_TEST_EXE, args: [] } : { args: ['.'] }), env: { ...baseEnv, XMEMEORY_TEST_DATA: userData } }).then(async app => { if (size) await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]?.setContentSize(s.width, s.height), size).catch(() => {}); return app })
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
const nav = (page: Page, name: string) => page.locator('.sidebar nav').getByRole('button', { name })
const noOverflow = (page: Page) => page.evaluate(() => [document.documentElement, ...document.querySelectorAll('.workspace, .settings-page, .content-layout, .calendar-page')].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => (el as HTMLElement).className || el.tagName))

const userData = mkdtempSync(path.join(temporary, 'profile-'))
const shots: { label: string; file: string }[] = []
const shot = async (page: Page, name: string, label: string) => { const file = path.join(temporary, `${name}.png`); await page.screenshot({ path: file }); shots.push({ label, file }) }
let app = await launch(userData, { width: 1440, height: 900 })
try {
  let page = await ready(app)
  await page.evaluate(async () => {
    const today = new Date(); const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    for (let n = 0; n < 4; n++) await window.xm.save({ kind: 'memory', title: `合成记忆 ${n + 1}：本地优先的写作工作流`, body: `## 核心观点\n\n这是一段用于主题截图的合成正文，验证卡片、标签和次要文字在亮暗两版下的可读性。\n\n> 慢下来，才能看清楚。\n\n- 第一条要点\n- 第二条要点`, author: 'sample', tags: n % 2 ? ['写作'] : [] })
    for (const title of ['整理本周书签', '写一段开场白', '和纸配色截图']) await window.xm.save({ kind: 'inspiration', title, body: '', scheduledDate: key })
    await window.xm.save({ kind: 'topic', title: '合成选题：留白的力量', body: '大纲' })
  })
  await settingsNav(page).click()
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'washi')
  await expect(page.getByRole('button', { name: /^配色：/ })).toHaveCount(0)
  await expect(page.getByText('配色', { exact: true })).toHaveCount(0)
  const serifReady = await page.evaluate(async () => { await document.fonts.ready; await document.fonts.load('400 20px "Noto Serif SC"', '灵感记忆'); return [...document.fonts].some(f => f.family.replace(/"/g, '') === 'Noto Serif SC' && f.status === 'loaded') })
  expect(serifReady, '思源宋体已加载').toBe(true)
  await expect(page.locator('.settings-section h2').first()).toHaveCSS('font-family', /Noto Serif SC/)
  for (const mode of ['light', 'dark'] as const) {
    const c = themes.washi[mode]
    await settingsNav(page).click()
    await page.getByRole('button', { name: mode === 'dark' ? '深色' : '浅色', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
    await expect.poll(() => windowColor(app)).toContain(c.bg.slice(1))
    await expect(page.locator('body')).toHaveCSS('background-color', rgb(c.bg))
    await shot(page, `settings-${mode}`, `设置 · ${mode === 'dark' ? '深色' : '浅色'}`)
    await nav(page, '灵感').click()
    await expect(page.locator('.calendar-day')).toHaveCount(7)
    await shot(page, `calendar-${mode}`, `灵感日历 · ${mode === 'dark' ? '深色' : '浅色'}`)
    await nav(page, '记忆').click()
    const primary = page.locator('.auto-collect').getByRole('button', { name: '开启自动采集', exact: true })
    await expect(primary).toHaveCSS('background-color', rgb(c.accent))
    await expect(primary).toHaveCSS('color', rgb(c.onAccent))
    await page.getByRole('button', { name: /合成记忆 1/ }).click()
    await expect(page.getByRole('button', { name: '← 返回记忆' })).toHaveCSS('border-top-color', rgb(c.control))
    await expect(page.locator('.tiptap')).toHaveCSS('color', rgb(c.text))
    await expect(page.locator('.note-card').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await shot(page, `memory-${mode}`, `记忆详情 · ${mode === 'dark' ? '深色' : '浅色'}`)
    await nav(page, '选题').click()
    await shot(page, `topic-${mode}`, `选题 · ${mode === 'dark' ? '深色' : '浅色'}`)
    expect(await noOverflow(page), `${mode} 1440 无水平溢出`).toEqual([])
  }
  for (const [width, height] of [[1100, 760], [900, 640]] as const) {
    await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s[0], s[1]), [width, height])
    await page.waitForTimeout(300)
    for (const name of ['灵感', '记忆', '选题']) { await nav(page, name).click(); expect(await noOverflow(page), `${name} ${width}x${height} 无水平溢出`).toEqual([]) }
    await settingsNav(page).click(); expect(await noOverflow(page), `设置 ${width}x${height} 无水平溢出`).toEqual([])
    if (height < 680) await expect(page.locator('.motto')).toBeHidden()
    else await expect(page.locator('.motto')).toBeVisible()
  }
  await shot(page, 'settings-dark-900', '设置 · 深色 · 900×640')
  await app.close()

  app = await launch(userData)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  expect(await page.evaluate(() => document.documentElement.dataset.theme), '首帧沿用缓存明暗').toBe('dark')
  page = await ready(app)
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'washi')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await windowColor(app)).toContain(themes.washi.dark.bg.slice(1))
  await app.close()

  for (const legacy of ['jade', 'neon']) {
    const old = mkdtempSync(path.join(temporary, 'profile-'))
    writeFileSync(path.join(old, 'settings.json'), JSON.stringify({ theme: 'dark', palette: legacy, closeToTray: true, branch: 'main' }))
    app = await launch(old)
    page = await ready(app)
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'washi')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    expect(await windowColor(app)).toContain(themes.washi.dark.bg.slice(1))
    expect(JSON.parse(readFileSync(path.join(old, 'settings.json'), 'utf8')).palette, `旧配色 ${legacy} 被清除`).toBeUndefined()
    await app.close()
  }

  const tiles = shots.map(s => `<figure><img src="data:image/png;base64,${readFileSync(s.file).toString('base64')}"><figcaption>${s.label}</figcaption></figure>`).join('')
  writeFileSync(path.join(temporary, 'sheet.html'), `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:16px;background:#e9e7e2;font:600 18px 'Microsoft YaHei',sans-serif;display:grid;grid-template-columns:repeat(2,1fr);gap:14px}figure{margin:0}img{width:100%;display:block;box-shadow:0 2px 8px #0002}figcaption{padding:6px 2px}</style>${tiles}`)
  console.log(JSON.stringify({ result: 'PASS', screenshots: temporary, checks: ['只剩和纸配色且设置页无配色区', '思源宋体加载并用于标题', '亮/暗主按钮底色与文字色', '次级按钮边框', '正文颜色', '窗口底色同步', '1440/1100/900 无水平溢出', '矮窗口隐藏竖排标语', '重启保持与首帧缓存', '旧配色与非法配色回退和纸'] }))
  expect(errors).toEqual([])
} finally { await app.close().catch(() => {}) }
