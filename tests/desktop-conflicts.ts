import { _electron as electron, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const root = path.resolve('../../trash/xmemeory-dev/conflicts-desktop')
mkdirSync(root, { recursive: true })
const profile = mkdtempSync(path.join(root, 'profile-'))
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), XMEMEORY_TEST_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ ...process.env.XMEMEORY_TEST_EXE ? { executablePath: process.env.XMEMEORY_TEST_EXE, args: [] } : { args: ['.'] }, env })
try {
  const page = await app.firstWindow(), errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await expect(page.getByRole('heading', { name: '这一周的灵感' })).toBeVisible()
  const notes = await page.evaluate(async () => {
    const notes = []
    for (const title of ['字段差异', '旧记录', '空格差异', '仅格式']) notes.push(await window.xm.save({ kind: 'inspiration', title, body: '正文一样\n' }))
    return notes
  })
  const snapshot = await page.evaluate(() => window.xm.snapshot())
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  for (const [index, note] of notes.entries()) {
    const raw = readFileSync(path.join(snapshot.library, note.path), 'utf8')
    const remote = index === 0 ? raw.replace('completed: false', 'completed: true\ncustom: 远端自定义值') : index === 2 ? raw.replace('正文一样', '正文 一样') : raw.replace(/\n/g, '\r\n')
    const incoming = { ...note, hash: hash(remote), body: index === 2 ? '正文 一样\n' : note.body }
    const conflict = { id: `synthetic-${index}`, noteId: note.id, title: note.title, current: note, incoming, createdAt: new Date(Date.UTC(2026, 8, 21, 12, index)).toISOString(), ...(index === 1 ? {} : { currentRaw: raw, incomingRaw: remote }), ...(index === 0 ? { currentMetadata: { completed: false }, incomingMetadata: { completed: true, custom: '远端自定义值' } } : {}) }
    writeFileSync(path.join(snapshot.library, 'conflicts', `${conflict.id}.json`), JSON.stringify(conflict))
    if (index === 0) for (let duplicate = 1; duplicate < 7; duplicate++) {
      const chained = { ...conflict, id: `synthetic-chain-${duplicate}`, current: { ...note, hash: duplicate < 4 ? `stale-${duplicate % 2}` : note.hash }, createdAt: new Date(Date.UTC(2026, 8, 21, 13, duplicate)).toISOString() }
      writeFileSync(path.join(snapshot.library, 'conflicts', `${chained.id}.json`), JSON.stringify(chained))
    }
  }
  // Saving a separate synthetic note refreshes the library, including conflict files.
  await page.evaluate(() => window.xm.save({ kind: 'inspiration', title: '刷新测试', body: '' }))
  await page.getByRole('button', { name: /待处理冲突/ }).click()
  await expect(page.locator('.conflict-card')).toHaveCount(3)
  const fields = page.locator('.conflict-card').filter({ has: page.getByRole('heading', { name: '字段差异', exact: true }) })
  await expect(fields).toContainText('正文相同')
  await expect(fields.locator('table')).toContainText('远端自定义值')
  const legacy = page.locator('.conflict-card').filter({ has: page.getByRole('heading', { name: '旧记录', exact: true }) })
  await expect(legacy).toContainText('未保存完整文件信息')
  const whitespace = page.locator('.conflict-card').filter({ has: page.getByRole('heading', { name: '空格差异', exact: true }) })
  await expect(whitespace).toContainText('正文仅空白字符不同')
  await expect(whitespace.locator('mark')).toContainText('·')
  await page.screenshot({ path: path.join(profile, 'conflicts.png') })
  await fields.getByRole('button', { name: '采用 B', exact: true }).click()
  await expect(page.locator('.conflict-card')).toHaveCount(2)
  const updated = (await page.evaluate(() => window.xm.snapshot())).notes.find(n => n.id === notes[0].id)!
  expect(updated.completed).toBe(true)
  expect(readFileSync(path.join(snapshot.library, updated.path), 'utf8')).toContain('custom: 远端自定义值')
  expect(errors).toEqual([])
  console.log('PASS: 等价冲突归档，正文相同显示附加字段，旧记录提示，空白差异可见，采用 B 保留完整字段，无页面错误')
} finally { await app.close() }
