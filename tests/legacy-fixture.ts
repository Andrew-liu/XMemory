import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { hash, walk } from '../src/main/library'
import { sourceHash } from '../src/main/partial-retry'

export const base = path.resolve('../../trash/xmemeory-dev/layout-tests')
mkdirSync(base, { recursive: true })
export const fresh = () => mkdtempSync(path.join(base, 'lib-'))
export const write = (root: string, file: string, content: string | Buffer) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), content) }
// A real 1x1 PNG, so the app can actually decode and display it.
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMAAQAAAAUAAQ0KLbQAAAAASUVORK5CYII=', 'base64')

/** A synthetic schemaVersion 1 library, exactly as v0.6.0 wrote it. */
export function legacyLibrary() {
  const root = fresh()
  write(root, 'manifest.json', JSON.stringify({ schemaVersion: 1, application: 'XMemeory' }))
  for (const folder of ['inspirations', 'memories', 'drafts', 'topics', 'assets', 'metadata', 'tombstones', 'conflicts', 'local']) mkdirSync(path.join(root, folder), { recursive: true })
  write(root, `assets/${hash(PNG)}.png`, PNG)
  const source = `# X 原文\n\n正文第一段\n\n![X 图片 1](../../assets/${hash(PNG)}.png)\n\n[原文](https://x.com/alice/status/222)\n\n# 我的笔记\n\n我的批注`
  write(root, 'memories/11/222.md', `---\nxmemeory_id: x-11-222\ntype: memory\ntitle: 星舰 试飞\ntags: []\ncreatedAt: 2026-09-14T08:30:00.000Z\nauthor: alice\nsource: https://x.com/alice/status/222\npublishedAt: 2026-09-13T20:00:00.000Z\n---\n${source}`)
  write(root, 'memories/11/333.md', `---\nxmemeory_id: x-11-333\ntype: memory\ntitle: 星舰 试飞\ntags: []\ncreatedAt: 2026-09-14T09:30:00.000Z\nauthor: alice\npublishedAt: 2026-09-13T20:00:00.000Z\n---\n另一条同名记忆`)
  write(root, 'memories/11/444.md', `---\nxmemeory_id: x-11-444\ntype: memory\ntitle: 已删除的书签\ncreatedAt: 2026-01-02T00:00:00.000Z\nauthor: bob\n---\n将在回收站`)
  write(root, 'tombstones/x-11-444.json', JSON.stringify({ id: 'x-11-444', deleted: true, time: '2026-02-01T00:00:00.000Z' }))
  write(root, 'inspirations/idea-1.md', `---\nxmemeory_id: idea-1\ntype: inspiration\ntitle: 灵感一\ncreatedAt: 2026-10-01T00:00:00.000Z\n---\n灵感正文 [[星舰 试飞]] ![](../assets/${hash(PNG)}.png)`)
  write(root, 'topics/topic-1.md', '---\nxmemeory_id: topic-1\ntype: topic\ntitle: 选题甲\ncreatedAt: 2026-10-02T00:00:00.000Z\ncompleted: false\n---\n大纲')
  write(root, 'metadata/x-11-222.capture.json', JSON.stringify({ sourceHash: sourceHash(source), localImages: { 'https://pbs.twimg.com/a.jpg': `../../assets/${hash(PNG)}.png` } }))
  write(root, 'metadata/x-11-222.json', JSON.stringify({ id: 'x-11-222', kind: 'memory', title: '星舰 试飞' }))
  write(root, 'local/index.sqlite', '')
  write(root, 'local/sync-0123456789abcdef.json', JSON.stringify({ hashes: {}, lastRemoteSha: 'h', lastTreeSha: 't' }))
  return { root, source }
}
// The search index is a rebuildable cache and is not part of a backup.
// The search index is a rebuildable cache and is not part of a backup.
export const snapshot = (root: string) => Object.fromEntries(walk(root, '').filter(f => f !== 'local/index.sqlite').map(f => [f, hash(readFileSync(path.join(root, f)))]))
