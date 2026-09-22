import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'

const temporary = path.resolve('../../trash/xmemeory-dev/github-token')
mkdirSync(temporary, { recursive: true })
const userData = mkdtempSync(path.join(temporary, 'profile-'))
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), XMEMEORY_TEST_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE
const launch = () => electron.launch({ ...(process.env.XMEMEORY_TEST_EXE ? { executablePath: process.env.XMEMEORY_TEST_EXE, args: [] } : { args: ['.'] }), env })
const mock = (app: ElectronApplication) => app.evaluate(({ session }) => {
  const store = globalThis as any
  store.authStatus = 200; store.repoStatus = 200; store.brokenBodies = 0; store.githubCalls = []
  session.fromPartition('github-sync').fetch = async (input, init) => {
    if (init?.credentials !== 'omit' || init?.redirect !== 'error') throw new Error('缺少 Cookie 或重定向隔离')
    const url = String(input)
    if (!url.startsWith('https://api.github.com/')) throw new Error('测试禁止真实网络')
    if (init?.method !== 'GET') throw new Error('连接检查不得写入远端')
    store.githubCalls.push(url)
    if (store.brokenBodies > 0) { store.brokenBodies--; return new Response(new ReadableStream({ start(c) { c.error(new TypeError('terminated')) } })) }
    const header = new Headers(init?.headers).get('Authorization')
    if (header !== 'Bearer github_pat_syntheticNewValue') return new Response('{}', { status: 401 })
    if (url === 'https://api.github.com/user') return Response.json({ login: 'synthetic-user' }, { status: store.authStatus })
    if (url === 'https://api.github.com/repos/example/synthetic') return Response.json({ private: true }, { status: store.repoStatus })
    if (url === 'https://api.github.com/repos/example/synthetic/git/ref/heads/master') return Response.json({ object: { sha: 'head' } })
    throw new Error('意外的测试请求')
  }
})
let app = await launch()
try {
  let page = await app.firstWindow()
  await mock(app)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('私有仓库', { exact: true }).fill('example/synthetic')
  await page.getByLabel('分支', { exact: true }).fill('master')
  await page.getByLabel('访问 Token', { exact: true }).fill('github_pat_syntheticOldValue')
  await page.getByRole('button', { name: '保存连接' }).click()
  await expect(page.getByLabel('Token 保存状态')).toContainText('细粒度 Token')
  await page.getByLabel('访问 Token', { exact: true }).fill(' github_pat_syntheticNewValue ')
  await page.getByRole('button', { name: '检查连接' }).click()
  await expect(page.getByText(/连接检查通过（@synthetic-user）/)).toBeVisible()
  await expect(page.getByLabel('访问 Token', { exact: true })).toHaveValue('')
  await page.getByLabel('访问 Token', { exact: true }).fill('Bearer github_pat_syntheticRejected')
  await page.getByRole('button', { name: '保存连接' }).click()
  await expect(page.locator('.error-banner')).toContainText('不要包含 Bearer')
  expect(readFileSync(path.join(userData, 'credentials.bin')).includes(Buffer.from('github_pat_syntheticNewValue'))).toBe(false)
  expect(readFileSync(path.join(userData, 'settings.json'), 'utf8')).not.toContain('github_pat_')
  await app.close()
  app = await launch(); page = await app.firstWindow(); await mock(app)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByLabel('Token 保存状态')).toContainText('细粒度 Token')
  await page.getByRole('button', { name: '检查连接' }).click()
  await expect(page.getByText(/连接检查通过（@synthetic-user）/)).toBeVisible()
  await app.evaluate(() => { (globalThis as any).authStatus = 401; (globalThis as any).githubCalls = [] })
  await page.getByRole('button', { name: '检查连接' }).click()
  await expect(page.locator('.error-banner')).toContainText('401（验证 Token）')
  expect(await app.evaluate(() => (globalThis as any).githubCalls)).toEqual(['https://api.github.com/user'])
  await app.evaluate(() => { (globalThis as any).authStatus = 200; (globalThis as any).repoStatus = 404 })
  await page.getByRole('button', { name: '检查连接' }).click()
  await expect(page.locator('.error-banner')).toContainText('Token 已认证为 @synthetic-user')
  await app.evaluate(() => { (globalThis as any).repoStatus = 200; (globalThis as any).brokenBodies = 1; (globalThis as any).githubCalls = [] })
  await page.getByRole('button', { name: '检查连接' }).click()
  await expect(page.getByText(/连接检查通过（@synthetic-user）/)).toBeVisible()
  expect((await app.evaluate(() => (globalThis as any).githubCalls)).length).toBe(4)
  await app.evaluate(() => { (globalThis as any).brokenBodies = 3; (globalThis as any).githubCalls = [] })
  await page.getByRole('button', { name: '检查连接' }).click()
  await expect(page.locator('.error-banner')).toContainText('连接失败（验证 Token）', { timeout: 8000 })
  await expect(page.locator('.error-banner')).toContainText('已重试 2 次')
  await expect(page.getByRole('button', { name: '检查连接' })).toBeEnabled()
  expect((await app.evaluate(() => (globalThis as any).githubCalls)).length).toBe(3)
  console.log('PASS: 专用网络通道省略 Cookie、禁止跳转、响应中断恢复和有限重试、错误定位； Token 替换后加密保存、非法输入不覆盖、重启使用新值、类型和保存时间、401 身份失败与 404 仓库授权区分（合成凭据，无远端写入）')
} finally { await app.close() }
