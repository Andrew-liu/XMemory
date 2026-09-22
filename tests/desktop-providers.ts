import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve('../../trash/xmemeory-dev/providers-desktop'); mkdirSync(root, { recursive: true })
const profile = mkdtempSync(path.join(root, 'profile-'))
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string,string] => e[1] !== undefined)), XMEMEORY_TEST_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE
const launch = () => electron.launch({ ...process.env.XMEMEORY_TEST_EXE ? { executablePath: process.env.XMEMEORY_TEST_EXE, args: [] } : { args: ['.'] }, env })
async function mock(app: ElectronApplication) {
  await app.evaluate(() => {
    const store = globalThis as any; store.modelCalls = []; store.blockModel = false
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (!['https://api.deepseek.com/chat/completions', 'https://synthetic.example/v1/chat/completions'].includes(url)) throw new Error('测试禁止外部请求')
      const body = JSON.parse(String(init?.body))
      store.modelCalls.push({ url, model: body.model, auth: new Headers(init?.headers).get('Authorization') })
      if (store.blockModel) return await new Promise<Response>((_, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }) })
      const chunks = [{ id: 'synthetic', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '多模型测试候选稿' }, finish_reason: null }] }, { id: 'synthetic', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]
      return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
  })
}
let app = await launch()
try {
  let page = await app.firstWindow(); await mock(app)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('模型名称', { exact: true }).fill('deepseek-chat')
  await page.getByLabel('API Key', { exact: true }).fill('synthetic-deepseek')
  await page.getByRole('button', { name: '添加兼容服务' }).click()
  await expect(page.getByLabel('服务名称', { exact: true })).toHaveValue('兼容 API')
  await page.getByLabel('服务名称', { exact: true }).fill('服务 A')
  await page.getByLabel('Base URL', { exact: true }).fill('https://synthetic.example/v1')
  await page.getByLabel('模型名称', { exact: true }).fill('model-a')
  await page.getByLabel('API Key', { exact: true }).fill('synthetic-a')
  await page.getByRole('button', { name: '添加兼容服务' }).click()
  await expect(page.getByLabel('服务名称', { exact: true })).toHaveValue('兼容 API')
  await page.getByLabel('服务名称', { exact: true }).fill('服务 B')
  await page.getByLabel('Base URL', { exact: true }).fill('https://synthetic.example/v1')
  await page.getByLabel('模型名称', { exact: true }).fill('model-b')
  // Leave the settings page without pressing Save; edits must persist.
  await page.getByRole('button', { name: '新灵感', exact: true }).click()
  let settings = (await page.evaluate(() => window.xm.snapshot())).settings
  const a = settings.providers.find(p => p.name === '服务 A')!, b = settings.providers.find(p => p.name === '服务 B')!
  expect(a.hasKey).toBe(true); expect(b.hasKey).toBe(false)
  await page.getByRole('button', { name: '创作', exact: true }).click()
  await expect(page.locator('.error-banner')).toContainText('服务 B')
  expect(await app.evaluate(() => (globalThis as any).modelCalls.length)).toBe(0)
  await page.getByLabel('创作模型', { exact: true }).selectOption(a.id)
  await page.getByRole('button', { name: '生成候选稿' }).click()
  await expect.poll(async () => (await page.evaluate(() => window.xm.snapshot())).notes.filter(n => n.kind === 'draft').length).toBe(1)
  await page.getByLabel('创作模型', { exact: true }).selectOption('deepseek')
  await page.getByRole('button', { name: '生成候选稿' }).click()
  await expect.poll(async () => (await page.evaluate(() => window.xm.snapshot())).notes.filter(n => n.kind === 'draft').length).toBe(2)
  await expect(page.getByRole('button', { name: '生成候选稿' })).toBeEnabled()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('当前服务', { exact: true }).selectOption(b.id)
  await page.getByLabel('API Key', { exact: true }).fill('synthetic-b')
  await page.getByRole('button', { name: '新灵感', exact: true }).click()
  await page.getByRole('button', { name: '创作', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => window.xm.snapshot())).notes.filter(n => n.kind === 'draft').length).toBe(3)
  expect(await app.evaluate(() => (globalThis as any).modelCalls)).toEqual([
    { url: 'https://synthetic.example/v1/chat/completions', model: 'model-a', auth: 'Bearer synthetic-a' },
    { url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat', auth: 'Bearer synthetic-deepseek' },
    { url: 'https://synthetic.example/v1/chat/completions', model: 'model-b', auth: 'Bearer synthetic-b' }
  ])
  expect((await page.evaluate(() => window.xm.snapshot())).notes.filter(n => n.kind === 'draft').map(n => n.generationProvider?.model).sort()).toEqual(['deepseek-chat', 'model-a', 'model-b'])
  await app.evaluate(() => { (globalThis as any).blockModel = true })
  await page.getByRole('button', { name: '生成候选稿' }).click()
  await expect(page.getByLabel('创作模型', { exact: true })).toBeDisabled()
  const blocked = await page.evaluate(async () => { try { await window.xm.settings({ activeProvider: 'deepseek' }); return '' } catch (e) { return String(e) } })
  expect(blocked).toContain('创作中不能修改')
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await expect(page.getByLabel('创作模型', { exact: true })).toBeEnabled()
  await app.close(); app = await launch(); page = await app.firstWindow(); await mock(app)
  settings = (await page.evaluate(() => window.xm.snapshot())).settings
  expect(settings.activeProvider).toBe(b.id)
  expect(settings.providers.every(p => p.hasKey)).toBe(true)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '删除当前服务' }).click()
  await expect(page.getByLabel('当前服务', { exact: true })).toHaveValue('deepseek')
  await page.evaluate(async provider => { const s = (await window.xm.snapshot()).settings; await window.xm.settings({ providers: [...s.providers, provider], activeProvider: provider.id }) }, { id: b.id, name: '重新添加 B', baseURL: b.baseURL, model: b.model })
  expect((await page.evaluate(() => window.xm.snapshot())).settings.providers.find(p => p.id === b.id)?.hasKey).toBe(false)
  await expect(page.getByLabel('服务名称', { exact: true })).toHaveValue('重新添加 B')
  await page.getByLabel('Base URL', { exact: true }).fill('invalid-url')
  await page.getByLabel('当前服务', { exact: true }).selectOption('deepseek')
  await expect(page.locator('.error-banner')).toBeVisible()
  expect((await page.evaluate(() => window.xm.snapshot())).settings.activeProvider).toBe(b.id)
  await expect(page.getByLabel('Base URL', { exact: true })).toHaveValue('invalid-url')
  await page.getByRole('button', { name: '删除当前服务' }).click()
  await expect(page.getByLabel('当前服务', { exact: true })).toHaveValue('deepseek')
  await page.getByLabel('当前服务', { exact: true }).selectOption(a.id)
  await page.getByRole('button', { name: '删除当前服务' }).click()
  await expect(page.getByRole('button', { name: '删除当前服务' })).toBeDisabled()
  const rejected = await page.evaluate(async () => {
    const s = (await window.xm.snapshot()).settings
    try { await window.xm.settings({ providers: [{ ...s.providers[0], id: 'github' }], activeProvider: 'github' }, { providerId: 'github', apiKey: 'synthetic-invalid' }); return '' } catch (e) { return String(e) }
  })
  expect(rejected).toContain('保留名称')
  await expect(page.locator('.error-banner')).toHaveCount(0)
  await page.screenshot({ path: path.join(profile, 'providers.png') })
  expect(readFileSync(path.join(profile, 'settings.json'), 'utf8')).not.toContain('synthetic-b')
  expect(readFileSync(path.join(profile, 'credentials.bin')).includes(Buffer.from('synthetic-a'))).toBe(false)
  console.log('PASS: 新增/编辑/切换保存，三个模型实际地址/模型/Key 隔离，无 Key 不回退，候选稿模型来源，生成锁定/停止，重启与删除 Key（合成 API）')
} finally { await app.close() }
