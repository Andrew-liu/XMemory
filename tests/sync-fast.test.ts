import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { scanTar, scanTarGz } from '../src/main/sync-tarball'
import { gitBlobHash } from '../src/main/sync-cache'
import { githubJson, rateLimitDelay, SyncCancelled } from '../src/main/github-request'
import { inlineable, treeBatches } from '../src/main/sync'
import { chunkedBody, tarBuffer, tarGz } from './tar-helper'

afterEach(() => vi.useRealTimers())
const base = path.resolve('../../trash/xmemeory-dev/tarball-tests')
mkdirSync(base, { recursive: true })

describe('打包解析', () => {
  it('git archive 生成的 tar.gz（中文长文件名、空文件、二进制）按 SHA 全部取回，与 ls-tree 一致', async () => {
    const repo = mkdtempSync(path.join(base, 'repo-'))
    const files: Record<string, Buffer> = {
      'memories/2026/2026-09-13 一位作者的很长很长的名字 - 星舰第五次试飞助推器被机械臂夹住的全过程与细节.md': Buffer.from('---\ntitle: 长名\n---\n正文'),
      'inspirations/empty.md': Buffer.alloc(0),
      'attachments/a.png': Buffer.from([137, 80, 78, 71, 0, 1, 2, 255]),
      'manifest.json': Buffer.from('{"schemaVersion":2}')
    }
    for (const [file, data] of Object.entries(files)) { mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); writeFileSync(path.join(repo, file), data) }
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args])
    git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'x')
    const tree = git('ls-tree', '-r', 'HEAD').toString().trim().split('\n').map(line => line.split(/\s+/)[2])
    const archive = git('archive', '--format=tar', '--prefix=owner-repo-abc/', 'HEAD')
    const wanted = new Set(tree)
    const got = new Map<string, Buffer>()
    const result = await scanTarGz(chunkedBody(gzipSync(archive), 777), wanted, (sha, bytes) => got.set(sha, bytes))
    expect(result.matched).toBe(4)
    expect(wanted.size).toBe(0)
    for (const [sha, bytes] of got) expect(gitBlobHash(bytes)).toBe(sha)
  })
  it('自建 tar（全局 pax 头 + 长文件名 pax 记录）只交出需要的文件', async () => {
    const a = Buffer.from('甲'), b = Buffer.from('乙'.repeat(3000))
    const put: string[] = []
    const result = await scanTarGz(chunkedBody(tarGz([['x/很长的文件名'.repeat(10) + '.md', a], ['y.md', b]]), 333), new Set([gitBlobHash(b)]), sha => put.push(sha))
    expect(put).toEqual([gitBlobHash(b)])
    expect(result).toMatchObject({ entries: 2, matched: 1 })
  })
  it('数据中途截断时报错，不静默返回部分结果', async () => {
    const whole = tarBuffer([['a.md', Buffer.alloc(5000, 1)]])
    async function* cut() { yield whole.subarray(0, 2000) }
    await expect(scanTar(cut(), new Set(['x']), () => {})).rejects.toThrow('打包文件不完整')
  })
  it('损坏的 gzip 流报错', async () => {
    await expect(scanTarGz(chunkedBody(Buffer.from('not gzip at all')), new Set(), () => {})).rejects.toThrow()
  })
})

describe('分批与内联', () => {
  it('目录树按条数与内联文本大小分批（默认 200 条 / 1 MiB），顺序不变', () => {
    const many = Array.from({ length: 1201 }, (_, i) => ({ path: `f${i}`, sha: 'x' }))
    expect(treeBatches(many).map(b => b.length)).toEqual([200, 200, 200, 200, 200, 200, 1])
    expect(treeBatches(many, 500).map(b => b.length)).toEqual([500, 500, 201])
    expect(treeBatches(many).flat()).toEqual(many)
    const big = Array.from({ length: 5 }, (_, i) => ({ path: `b${i}`, content: 'a'.repeat(900 * 1024) }))
    expect(treeBatches(big, 500, 2 * 1024 * 1024).map(b => b.length)).toEqual([2, 2, 1])
    expect(treeBatches(big).map(b => b.length)).toEqual([1, 1, 1, 1, 1])
    expect(treeBatches([{ path: 'huge', content: 'a'.repeat(3 * 1024 * 1024) }]).map(b => b.length)).toEqual([1])
  })
  it('只有无损 UTF-8 的 .md/.json 内联，图片、NUL、非法 UTF-8 走 blob', () => {
    expect(inlineable('memories/a.md', Buffer.from('---\n正文\r\n'))).toBe(true)
    expect(inlineable('.xmemeory/metadata/a.json', Buffer.from('{}'))).toBe(true)
    expect(inlineable('attachments/a.png', Buffer.from('text'))).toBe(false)
    expect(inlineable('a.md', Buffer.from([0x61, 0x00]))).toBe(false)
    expect(inlineable('a.md', Buffer.from([0xff, 0xfe, 0x61]))).toBe(false)
  })
})

describe('限流', () => {
  const limited = (headers: Record<string, string>, status = 403) => new Response('{"message":"rate limit"}', { status, headers })
  it('识别 403 + 剩余 0、retry-after、无提示的 429；普通 403 不算限流', () => {
    const now = 1_000_000
    expect(rateLimitDelay(limited({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 120) }), now)).toBe(121_000)
    expect(rateLimitDelay(limited({ 'retry-after': '30' }), now)).toBe(31_000)
    expect(rateLimitDelay(limited({}, 429), now)).toBe(60_000)
    expect(rateLimitDelay(limited({}), now)).toBeUndefined()
    expect(rateLimitDelay(limited({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 99999) }), now)).toBe(65 * 60_000)
  })
  it('等待到重置时间后自动重试成功，期间显示剩余时间', async () => {
    vi.useFakeTimers()
    let calls = 0
    const statuses: string[] = []
    const task = githubJson(async () => ++calls === 1 ? limited({ 'retry-after': '90' }) : Response.json({ ok: 1 }), 'https://api.github.com/x', { method: 'POST' }, '写入远端内容', s => statuses.push(s))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toBe(1)
    expect(statuses.at(-1)).toMatch(/已达限额，\d+ 秒后自动继续/)
    await vi.advanceTimersByTimeAsync(40_000)
    expect((await task).data).toEqual({ ok: 1 })
    expect(calls).toBe(2)
    expect(statuses.some(s => s.includes('1 分'))).toBe(true)
  })
  it('连续限流超过 3 次后返回原响应，由调用方报错', async () => {
    vi.useFakeTimers()
    let calls = 0
    const task = githubJson(async () => { calls++; return limited({ 'retry-after': '1' }) }, 'https://api.github.com/x', {}, '读取远端文件', () => {})
    await vi.runAllTimersAsync()
    expect((await task).response.status).toBe(403)
    expect(calls).toBe(4)
  })
  it('等待中取消立即停止', async () => {
    vi.useFakeTimers()
    let stop = false
    const task = githubJson(async () => limited({ 'retry-after': '600' }), 'https://api.github.com/x', {}, '读取远端文件', () => {}, () => stop).catch(e => e)
    await vi.advanceTimersByTimeAsync(5_000)
    stop = true
    await vi.advanceTimersByTimeAsync(1_500)
    expect(await task).toBeInstanceOf(SyncCancelled)
  })
})
