import { describe, expect, it } from 'vitest'
import { chromeCandidates, chromeMissingMessage, processManagerName } from '../src/main/x-capture'
import { trayTemplate18, trayTemplate36 } from '../src/main/tray-template'

describe('Mac 平台适配', () => {
  it('Mac 在“应用程序”与用户 Applications 里依次查找正式版和 Beta 版 Chrome', () => {
    expect(chromeCandidates('darwin', {}, '/Users/me')).toEqual([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Users/me/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'
    ])
  })
  it('Windows 仍按 Program Files 与 LocalAppData 查找，缺少环境变量时跳过', () => {
    const found = chromeCandidates('win32', { PROGRAMFILES: 'C:/Program Files', LOCALAPPDATA: 'C:/Users/me/AppData/Local' }, 'C:/Users/me')
    expect(found.every(file => file.endsWith('chrome.exe'))).toBe(true)
    expect(found).toHaveLength(4)
    expect(chromeCandidates('win32', {}, 'C:/Users/me')).toEqual([])
  })
  it('提示文案按平台指向活动监视器或任务管理器，Mac 缺少 Chrome 时给出安装指引', () => {
    expect(processManagerName('darwin')).toBe('活动监视器')
    expect(processManagerName('win32')).toBe('任务管理器')
    expect(chromeMissingMessage('darwin')).toContain('应用程序')
    expect(chromeMissingMessage('win32')).not.toContain('应用程序')
  })
  it('菜单栏模板图是 18px 与 36px 的 PNG', () => {
    for (const [url, size] of [[trayTemplate18, 18], [trayTemplate36, 36]] as const) {
      const bytes = Buffer.from(url.replace('data:image/png;base64,', ''), 'base64')
      expect(bytes.subarray(1, 4).toString()).toBe('PNG')
      expect(bytes.readUInt32BE(16)).toBe(size)
      expect(bytes.readUInt32BE(20)).toBe(size)
    }
  })
})
