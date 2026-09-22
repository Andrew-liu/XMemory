import { chromium, expect } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { downloadChromeImage, updatedCaptureBody } from '../src/main/x-cdp-target'
import { Library } from '../src/main/library'

const temporary = path.resolve(process.cwd(), '../../trash/xmemeory-dev/browser-images')
mkdirSync(temporary, { recursive: true })
const executablePath = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
  .filter(Boolean).map(root => path.join(root!, 'Google/Chrome/Application/chrome.exe')).find(existsSync)
if (!executablePath) throw new Error('真实图片测试需要安装 Chrome')
const profile = mkdtempSync(path.join(temporary, 'profile-'))
const context = await chromium.launchPersistentContext(profile, { executablePath, headless: false, args: ['--window-position=-10000,40'] })
const library = new Library(mkdtempSync(path.join(temporary, 'library-')))
try {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2l8AAAAASUVORK5CYII=', 'base64')
  const url = 'https://pbs.twimg.com/media/synthetic-long-image-address.png?name=orig'
  await context.route('**/*', route => route.request().url() === url
    ? route.fulfill({ status: 200, contentType: 'image/png', body: bytes }) : route.abort())
  const pagesBefore = context.pages().length
  const downloaded = await downloadChromeImage(context, url)
  expect(downloaded.equals(bytes)).toBe(true)
  expect(context.pages()).toHaveLength(pagesBefore)
  const asset = library.addImage(downloaded, 'synthetic')
  const original = library.save({ kind: 'memory', id: 'x-1-2', title: '合成图片回归', body: `# X 原文\n\n![图片](${url})\n\n# 我的笔记\n我的观点` })
  const relative = path.posix.relative(path.posix.dirname(original.path), asset)
  const body = updatedCaptureBody(original, original.body, original.body.replace(url, relative), { [url]: relative })
  const saved = library.save({ ...original, body }, original.hash)
  expect(saved.body).toContain('我的观点')
  expect(saved.body).not.toContain(url)
  expect(readFileSync(path.resolve(library.root, path.dirname(saved.path), relative)).equals(bytes)).toBe(true)
  console.log('PASS: 真实 Chrome 图片响应、本地 PNG 保存、Markdown 相对路径、保留笔记、临时标签页关闭（合成响应，无真实账号）')
} finally {
  await context.close()
  await library.close()
}
