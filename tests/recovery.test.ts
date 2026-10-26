import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addRecovery, clearRecoveries, pendingRecoveries } from '../src/main/recovery'

const setup = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'xm-recovery-'))
  const dir = path.join(root, 'recovery'); mkdirSync(dir)
  return { root, dir, notice: path.join(root, 'recovery-notice.json') }
}

describe('恢复副本提示', () => {
  it('旧格式标记指向的副本已不存在时，删除标记且不再提示', () => {
    const { dir, notice } = setup()
    writeFileSync(notice, JSON.stringify({ file: path.join(dir, 'gone.md') }))
    expect(pendingRecoveries(notice, dir)).toEqual([])
    expect(existsSync(notice)).toBe(false)
  })
  it('兼容旧格式，副本仍在时继续提示', () => {
    const { dir, notice } = setup()
    const file = path.join(dir, 'a.md'); writeFileSync(file, '# 标题\n\n正文')
    writeFileSync(notice, JSON.stringify({ file }))
    expect(pendingRecoveries(notice, dir)).toEqual([file])
  })
  it('多次另存累积多份，只剔除已消失的副本', () => {
    const { dir, notice } = setup()
    const a = path.join(dir, 'a.md'), b = path.join(dir, 'b.md')
    writeFileSync(a, 'A'); writeFileSync(b, 'B')
    addRecovery(notice, dir, a); addRecovery(notice, dir, b); addRecovery(notice, dir, b)
    expect(pendingRecoveries(notice, dir)).toEqual([a, b])
    writeFileSync(a, ''); rmSync(a)
    expect(pendingRecoveries(notice, dir)).toEqual([b])
    expect(JSON.parse(readFileSync(notice, 'utf8')).files).toEqual([b])
  })
  it('忽略恢复目录以外的路径和损坏的标记', () => {
    const { root, dir, notice } = setup()
    const outside = path.join(root, 'outside.md'); writeFileSync(outside, 'x')
    writeFileSync(notice, JSON.stringify({ files: [outside, 42] }))
    expect(pendingRecoveries(notice, dir)).toEqual([])
    writeFileSync(notice, '{broken')
    expect(pendingRecoveries(notice, dir)).toEqual([])
    expect(existsSync(notice)).toBe(false)
  })
  it('“已处理，不再提醒”清除标记但保留副本文件', () => {
    const { dir, notice } = setup()
    const a = path.join(dir, 'a.md'); writeFileSync(a, 'A')
    addRecovery(notice, dir, a)
    clearRecoveries(notice)
    expect(pendingRecoveries(notice, dir)).toEqual([])
    expect(existsSync(a)).toBe(true)
  })
})
