import { _electron as electron, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve('../../trash/xmemeory-dev/sync-cache-desktop'); mkdirSync(root, { recursive: true })
const profile = mkdtempSync(path.join(root, 'profile-'))
const env: Record<string,string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string,string] => e[1] !== undefined)), XMEMEORY_TEST_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ ...process.env.XMEMEORY_TEST_EXE ? { executablePath: process.env.XMEMEORY_TEST_EXE, args: [] } : { args: ['.'] }, env })
try {
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: '这一周的灵感' })).toBeVisible()
  const snapshot = await page.evaluate(() => window.xm.snapshot())
  const manifest = readFileSync(path.join(snapshot.library, 'manifest.json'), 'utf8')
  await app.evaluate(async ({ session }, manifest) => {
    const { createHash } = process.getBuiltinModule('node:crypto')
    const store = globalThis as any
    store.blobGets = 0
    store.remoteText = '---\nxmemeory_id: synthetic-remote\ntype: topic\ntitle: 缓存桌面测试\ncreatedAt: 2026-01-01T00:00:00.000Z\ncompleted: false\n---\n远端原正文'
    session.fromPartition('github-sync').fetch = async (input, init) => {
      const url = String(input)
      if (!url.startsWith('https://api.github.com/repos/example/synthetic')) throw new Error('禁止真实网络')
      if (init?.method !== 'GET') throw new Error('本场景不应上传')
      const files = new Map([['manifest.json', manifest], ['topics/synthetic-remote.md', store.remoteText as string]])
      const endpoint = url.split('/synthetic')[1]
      if (!endpoint) return Response.json({ private: true })
      if (endpoint === '/git/ref/heads/master') return Response.json({ object: { sha: 'head' } })
      if (endpoint === '/git/commits/head') return Response.json({ tree: { sha: 'tree' } })
      if (endpoint === '/git/trees/tree?recursive=1') return Response.json({ tree: [...files].map(([path, text]) => ({ path, sha: createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex'), mode: '100644', type: 'blob', size: Buffer.byteLength(text) })) })
      if (endpoint.startsWith('/git/blobs/')) {
        store.blobGets++
        const text = [...files.values()].find(text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex') === endpoint.split('/').at(-1))
        if (!text) throw new Error('Unexpected blob')
        return Response.json({ encoding: 'base64', content: Buffer.from(text).toString('base64') })
      }
      throw new Error('Unexpected request')
    }
  }, manifest)
  await page.evaluate(() => window.xm.settings({ repo: 'example/synthetic', branch: 'master' }, { githubKey: 'github_pat_synthetic' }))
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '立即同步' }).click()
  await expect(page.getByText(/已同步.*下载 1.*复用本地 1/)).toBeVisible()
  expect(await app.evaluate(() => (globalThis as any).blobGets)).toBe(1)
  await page.getByRole('button', { name: '立即同步' }).click()
  await expect(page.getByText(/已同步.*下载 0.*复用本地 2/)).toBeVisible()
  expect(await app.evaluate(() => (globalThis as any).blobGets)).toBe(1)
  await app.evaluate(() => { (globalThis as any).remoteText = (globalThis as any).remoteText.replace('远端原正文', '远端新正文') })
  await page.getByRole('button', { name: '立即同步' }).click()
  await expect(page.getByText(/已同步.*下载 1.*复用本地 1/)).toBeVisible()
  expect(await app.evaluate(() => (globalThis as any).blobGets)).toBe(2)
  expect((await page.evaluate(() => window.xm.snapshot())).notes.find(n => n.id === 'synthetic-remote')?.body).toBe('远端新正文')
  await expect(page.locator('.error-banner')).toHaveCount(0)
  console.log('PASS: 桌面连续同步第一次仅下载新增文件，第二次零下载，远端修改后只下载变化正文，状态计数与请求吻合（合成 API）')
} finally { await app.close() }
