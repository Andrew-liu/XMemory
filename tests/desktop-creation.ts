import { _electron as electron, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { dateKey } from '../src/shared/calendar'

const temporary = path.resolve('../../trash/xmemeory-dev/creation-desktop')
mkdirSync(temporary, { recursive: true })
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), XMEMEORY_TEST_DATA: mkdtempSync(path.join(temporary, 'profile-')) }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ ...(process.env.XMEMEORY_TEST_EXE ? { executablePath: process.env.XMEMEORY_TEST_EXE, args: [] } : { args: ['.'] }), env })
try {
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: '这一周的灵感' })).toBeVisible()
  await expect(page.locator('.sidebar nav').getByRole('button', { name: /创作/ })).toHaveCount(0)
  await app.evaluate(() => {
    const store = globalThis as any
    store.creationRequests = []
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url !== 'https://api.deepseek.com/chat/completions') throw new Error('合成测试禁止外部网络')
      store.creationRequests.push(JSON.parse(String(init?.body)))
      const chunks = [
        { id: 'synthetic', model: 'deepseek-chat', choices: [{ index: 0, delta: { role: 'assistant', content: '这是根据当前灵感生成的合成候选稿。' }, finish_reason: null }] },
        { id: 'synthetic', model: 'deepseek-chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]
      return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
  })
  const ids = await page.evaluate(async scheduledDate => {
    const inspiration = await window.xm.save({ kind: 'inspiration', title: '仅标题灵感', body: '', scheduledDate })
    const memory = await window.xm.save({ kind: 'memory', title: '合成记忆', body: '记忆不能直接创作' })
    return { inspiration: inspiration.id, memory: memory.id }
  }, dateKey())
  await page.getByRole('button', { name: '仅标题灵感', exact: true }).click()
  await page.getByRole('button', { name: '创作', exact: true }).click()
  await expect(page.locator('.error-banner')).toContainText('DeepSeek')
  expect(await app.evaluate(() => (globalThis as any).creationRequests.length)).toBe(0)
  await page.evaluate(() => window.xm.settings({ activeProvider: 'deepseek', providers: [{ id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' }] }, { providerId: 'deepseek', apiKey: 'synthetic-key' }))
  await expect(page.getByRole('button', { name: '生成候选稿', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '关闭创作面板' }).click()
  await page.getByRole('button', { name: '创作', exact: true }).click()
  await expect(page.locator('.generated')).toContainText('合成候选稿')
  await expect.poll(async () => (await page.evaluate(() => window.xm.snapshot())).notes.filter(n => n.kind === 'draft').length).toBe(1)
  const first = await app.evaluate(() => (globalThis as any).creationRequests[0])
  expect(JSON.stringify(first.messages)).toContain('灵感标题：仅标题灵感')
  expect(first.model).toBe('deepseek-chat')
  await page.getByRole('button', { name: '关闭创作面板' }).click()
  await page.getByRole('textbox', { name: '标题', exact: true }).fill('刚修改的标题')
  await page.getByRole('button', { name: '切换 Markdown 源码' }).click()
  await page.getByRole('textbox', { name: 'Markdown 源码' }).fill('尚未等待自动保存的灵感正文')
  await page.getByRole('button', { name: '创作', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => window.xm.snapshot())).notes.filter(n => n.kind === 'draft').length).toBe(2)
  const second = await app.evaluate(() => (globalThis as any).creationRequests[1])
  expect(JSON.stringify(second.messages)).toContain('刚修改的标题')
  expect(JSON.stringify(second.messages)).toContain('尚未等待自动保存的灵感正文')
  const drafts = (await page.evaluate(() => window.xm.snapshot())).notes.filter(n => n.kind === 'draft')
  expect(drafts.every(n => n.parentId === ids.inspiration)).toBe(true)
  await expect(page.locator('.inspiration-drafts summary')).toContainText('2')
  await page.getByRole('button', { name: '搜索所有内容' }).click()
  await page.getByPlaceholder('搜索灵感、记忆、选题和候选稿…').fill('合成候选稿')
  await expect(page.locator('.note-card')).toHaveCount(2)
  await page.getByRole('button', { name: '记忆', exact: false }).first().click()
  await page.getByRole('heading', { name: '合成记忆', exact: true }).click()
  await expect(page.getByRole('button', { name: '创作', exact: true })).toHaveCount(0)
  const error = await page.evaluate(async id => { try { await window.xm.generate(id, '', [], 'short', 'local'); return '' } catch (e) { return String(e) } }, ids.memory)
  expect(error).toBeTruthy()
  expect(await app.evaluate(() => (globalThis as any).creationRequests.length)).toBe(2)
  console.log('PASS: 无独立创作 Tab、无 Key 不请求、灵感单击调用 DeepSeek、仅标题与最新正文、候选稿关联和搜索、禁止记忆直接创作（合成 API）')
} finally { await app.close() }
