import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Note } from '../src/shared/types'
import { captureFromPayload } from '../src/main/x-parse'
import { Library } from '../src/main/library'
import { XCapture } from '../src/main/x-capture'
import { RiskGuard, DAILY_ARTICLES } from '../src/main/x-bookmarks'
import { legacySourceHash, mergeCapturedSource, PartialRetries, sourceHash } from '../src/main/partial-retry'

const temporary = path.resolve(process.cwd(), '../../trash/xmemeory-dev/partial-retry')
mkdirSync(temporary, { recursive: true })
const at = (hours: number) => new Date(new Date(2026, 9, 26, 10).getTime() + hours * 60 * 60_000)

function fixture(id: string, options: { legacy?: boolean; text?: string } = {}) {
  const root = mkdtempSync(path.join(temporary, 'retries-'))
  mkdirSync(path.join(root, 'metadata'), { recursive: true })
  const captured = captureFromPayload({
    rest_id: id,
    legacy: { full_text: options.text || '尚未取得完整内容', truncated: true, entities: { urls: [] } },
    core: { user_results: { result: { legacy: { screen_name: 'author' } } } }
  }, id)!
  const note: Note = {
    id: `x-42-${id}`, kind: 'memory', title: '待补采', body: captured.markdown,
    hash: 'synthetic', path: `memories/42/${id}.md`, tags: [],
    createdAt: at(0).toISOString(), updatedAt: at(0).toISOString(),
    source: `https://x.com/author/status/${id}`, partial: true
  }
  const meta = { ...captured.structured, sourceHash: options.legacy ? undefined : sourceHash(note.body) }
  writeFileSync(path.join(root, 'metadata', `${note.id}.capture.json`), JSON.stringify(meta))
  return { root, note, meta }
}

describe('不完整记忆补采预算与来源核验', () => {
  it('可从旧版元数据验证原文，不比较用户笔记；修改原文时拒绝自动补采', () => {
    const { root, note, meta } = fixture('101', { legacy: true })
    expect(legacySourceHash(meta)).toBe(sourceHash(note.body))
    const withNotes = { ...note, body: note.body + '\n我的笔记内容' }
    expect(new PartialRetries(root, at(0)).select([withNotes], '42', at(0))?.note.id).toBe(note.id)
    const edited = { ...note, body: note.body.replace('尚未取得完整内容', '我改过原文') }
    expect(new PartialRetries(root, at(0)).select([edited], '42', at(0))).toBeUndefined()
    expect(new PartialRetries(root, at(0)).info([edited])[note.id].result).toBe('review')
  })

  it('只替换 X 原文段并保留笔记；基线不符或结构歧义不写入', () => {
    const old = '# X 原文\n\n旧正文\n\n# 我的笔记\n\n这里是我写的笔记'
    const complete = '# X 原文\n\n完整正文\n\n# 我的笔记\n'
    const merged = mergeCapturedSource(old, complete, sourceHash(old)!)
    expect(merged).toBe('# X 原文\n\n完整正文\n\n# 我的笔记\n\n这里是我写的笔记')
    expect(mergeCapturedSource(old.replace('旧正文', '外部改动'), complete, sourceHash(old)!)).toBeUndefined()
    expect(mergeCapturedSource(old + '\n# 我的笔记\n', complete, sourceHash(old)!)).toBeUndefined()
  })

  it('限制单条间隔和三次上限，重启后也保留尝试次数', () => {
    const { root, note } = fixture('102')
    const retry = new PartialRetries(root, at(0))
    expect(retry.select([note], '42', at(0))).toBeDefined()
    retry.begin(note.id, at(0))
    retry.finish(note.id, 'incomplete', 'content-state-missing')
    expect(new PartialRetries(root, at(1)).select([note], '42', at(1))).toBeUndefined()
    expect(new PartialRetries(root, at(6)).select([note], '42', at(6))).toBeDefined()
    retry.begin(note.id, at(6)); retry.finish(note.id, 'error', 'network')
    expect(new PartialRetries(root, at(12)).select([note], '42', at(12))).toBeDefined()
    retry.begin(note.id, at(12)); retry.finish(note.id, 'incomplete')
    expect(new PartialRetries(root, at(48)).select([note], '42', at(48))).toBeUndefined()
    expect(retry.info([note])[note.id]).toMatchObject({ attempts: 3, result: 'incomplete' })
  })

  it('跨条目每天只补采三次，次日重置当天额度', () => {
    const a = fixture('103')
    const retry = new PartialRetries(a.root, at(0))
    const all = [a.note]
    for (const id of ['104', '105', '106']) {
      const other = { ...a.note, id: `x-42-${id}`, source: `https://x.com/author/status/${id}` }
      writeFileSync(path.join(a.root, 'metadata', `${other.id}.capture.json`),
        readFileSync(path.join(a.root, 'metadata', `${a.note.id}.capture.json`)))
      all.push(other)
    }
    for (let index = 0; index < 3; index++) {
      const selected = retry.select(all, '42', at(index))!
      expect(selected.note.id).toBe(all[index].id)
      retry.begin(selected.note.id, at(index))
      retry.finish(selected.note.id, 'incomplete')
    }
    expect(retry.select(all, '42', at(12))).toBeUndefined()
    expect(retry.select(all, '42', at(24))?.note.id).toBe(a.note.id)
    retry.finish(a.note.id, 'complete')
    expect(retry.info(all)[a.note.id]).toBeDefined()
    expect(retry.select([a.note], 'other-account', at(48))).toBeUndefined()
  })

  it('切换资料库仍共享本机当日预算，但分别记录每个资料库的同 ID 状态', () => {
    const a = fixture('150'), b = fixture('150')
    const device = mkdtempSync(path.join(temporary, 'device-'))
    const first = new PartialRetries(a.root, at(0), device)
    for (let hour = 0; hour < 3; hour++) {
      first.begin(a.note.id, at(hour))
      first.finish(a.note.id, 'incomplete')
    }
    const second = new PartialRetries(b.root, at(3), device)
    expect(second.select([b.note], '42', at(3))).toBeUndefined()
    expect(second.info([b.note])[b.note.id].attempts).toBe(0)
    expect(second.select([b.note], '42', at(24))?.note.id).toBe(b.note.id)
  })

  it('跳过只缺视频或图片、删除、无效链接、缺元数据及正文被编辑的记录', () => {
    const { root, note } = fixture('107')
    const retry = new PartialRetries(root, at(0))
    expect(retry.select([{ ...note, partial: false }], '42', at(0))).toBeUndefined()
    expect(retry.select([{ ...note, deleted: true }], '42', at(0))).toBeUndefined()
    expect(retry.select([{ ...note, source: 'https://example.com/107' }], '42', at(0))).toBeUndefined()
    const missing = { ...note, id: 'x-42-108', source: 'https://x.com/author/status/108' }
    expect(retry.select([missing], '42', at(0))).toBeUndefined()
    expect(retry.info([missing])[missing.id].result).toBe('review')
  })

  it('自动轮结束后复用 Chrome 补采一条，并保留用户笔记；长文额度满时不补采', async () => {
    const root = mkdtempSync(path.join(temporary, 'capture-'))
    const library = new Library(root)
    try {
      const capture = new XCapture(library, root, () => {})
      const payload = (truncated: boolean) => ({
        rest_id: '123', legacy: { full_text: truncated ? '截断正文' : '已取得完整正文', truncated, entities: { urls: [] } },
        core: { user_results: { result: { legacy: { screen_name: 'author' } } } }
      })
      const partial = captureFromPayload(payload(true), '123')!
      const full = captureFromPayload(payload(false), '123')!
      const first = await (capture as any).persistCaptured(partial, '42')
      const old = library.get(first.noteId)
      library.save({ ...old, body: old.body + '\n用户自己的笔记' }, old.hash)
      let calls = 0
      ;(capture as any).context = { cookies: async () => [{ name: 'twid', value: 'u%3D42' }] }
      ;(capture as any).browser = { isConnected: () => true }
      ;(capture as any).refreshLogin = async () => true
      ;(capture as any).collectOne = async (_url: string, _id: string, _account: string, _page: unknown, _via: unknown, expected: string) => {
        calls++
        return (capture as any).persistCaptured(full, '42', undefined, expected)
      }
      await capture.retryIncomplete()
      expect(calls).toBe(1)
      expect(library.get(first.noteId).partial).toBe(false)
      expect(library.get(first.noteId).body).toContain('已取得完整正文')
      expect(library.get(first.noteId).body).toContain('用户自己的笔记')
      await capture.retryIncomplete()
      expect(calls).toBe(1)
      const guard = new RiskGuard(root, '42')
      expect(guard.state.articlesToday).toBe(1)
      guard.state.articlesToday = DAILY_ARTICLES
      guard.save()
      await capture.retryIncomplete()
      expect(calls).toBe(1)
    } finally { await library.close() }
  })
})
