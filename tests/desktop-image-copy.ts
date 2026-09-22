import { _electron as electron, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import path from 'node:path'

const temporary = path.resolve(process.cwd(), '../../trash/xmemeory-dev/image-copy')
mkdirSync(temporary, { recursive: true })
const userData = mkdtempSync(path.join(temporary, 'profile-'))
const env: Record<string, string> = {
  ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  XMEMEORY_TEST_DATA: userData
}
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  ...(process.env.XMEMEORY_TEST_EXE ? { executablePath: process.env.XMEMEORY_TEST_EXE, args: [] } : { args: ['.'] }),
  env
})
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('load')
  await page.getByRole('button', { name: '新灵感', exact: true }).click()
  await page.getByRole('textbox', { name: '标题', exact: true }).fill('邮件图片复制验收')
  await page.locator('.tiptap').click()
  await app.evaluate(async ({ clipboard, nativeImage, ClipboardItem }) => {
    const bitmap = Buffer.alloc(1600 * 1000 * 4, 255)
    const png = nativeImage.createFromBitmap(bitmap, { width: 1600, height: 1000 }).toPNG()
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
  })
  await page.keyboard.press('Control+V')
  const localImage = page.locator('.tiptap img.local-image')
  await expect(localImage).toBeVisible()
  await expect.poll(() => localImage.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1600)
  await expect(page.locator('.save-status')).toContainText('已保存到本地')
  const before = (await page.evaluate(() => window.xm.snapshot())).notes.find(n => n.title === '邮件图片复制验收')!
  await app.evaluate(({ Menu }) => {
    const original = Menu.buildFromTemplate
    Menu.buildFromTemplate = ((template) => {
      const menu = original(template)
      const popup = menu.popup.bind(menu)
      menu.popup = options => {
        const copy = template.find(item => item.label === ((globalThis as any).imageCopyMenuLabel || '复制图片'))
        if (!copy?.click) throw new Error('图片右键菜单缺少“复制图片”')
        copy.click(menu.items[0], options?.window, {} as Electron.KeyboardEvent)
      }
      ;(globalThis as typeof globalThis & { restoreImageMenu?: () => void }).restoreImageMenu = () => { menu.popup = popup; Menu.buildFromTemplate = original }
      return menu
    }) as typeof Menu.buildFromTemplate
  })
  await localImage.click({ button: 'right' })
  const copied = await app.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read()
    const image = items.find(item => item.types.includes('image/png'))
    const html = items.find(item => item.types.includes('text/html'))
    return {
      hasPng: await clipboard.has('image/png'),
      hasHtml: await clipboard.has('text/html'),
      hasText: await clipboard.has('text/plain'),
      pngSize: image ? (await image.getType('image/png') as Blob).size : 0,
      html: html ? await (await html.getType('text/html') as Blob).text() : ''
    }
  })
  expect(copied.hasPng).toBe(true)
  expect(copied.hasHtml).toBe(false)
  expect(copied.hasText).toBe(false)
  expect(copied.pngSize).toBeGreaterThan(0)
  expect(copied.html).toBe('')
  await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.id = 'clipboard-probe'; probe.contentEditable = 'true'
    probe.style.cssText = 'position:fixed;inset:10px auto auto 10px;width:100px;height:30px;z-index:9999;background:white'
    probe.addEventListener('paste', event => {
      event.preventDefault()
      ;(window as any).clipboardProbe = {
        files: Array.from(event.clipboardData?.files || []).map(file => ({ type: file.type, size: file.size })),
        html: event.clipboardData?.getData('text/html'), text: event.clipboardData?.getData('text/plain')
      }
    })
    document.body.append(probe); probe.focus()
  })
  await page.keyboard.press('Control+V')
  await expect.poll(() => page.evaluate(() => (window as any).clipboardProbe?.files.length)).toBe(1)
  const pasted = await page.evaluate(() => (window as any).clipboardProbe)
  expect(pasted.files[0].type).toBe('image/png')
  expect(pasted.files[0].size).toBeGreaterThan(0)
  expect(pasted.html).toBe(''); expect(pasted.text).toBe('')
  await page.evaluate(() => document.getElementById('clipboard-probe')?.remove())
  await app.evaluate(() => { (globalThis as any).imageCopyMenuLabel = '复制图片（邮件富文本）' })
  await localImage.click({ button: 'right' })
  await expect.poll(() => app.evaluate(async ({ clipboard }) => await clipboard.has('text/html'))).toBe(true)
  expect(await app.evaluate(async ({ clipboard }) => {
    const item = (await clipboard.read()).find(item => item.types.includes('text/html'))!
    return (await item.getType('text/html') as Blob).text()
  })).toContain('<img src="data:image/png;base64,')
  await app.evaluate(() => { (globalThis as any).imageCopyMenuLabel = '复制图片' })
  const inlineWidth = (await localImage.boundingBox())!.width
  await localImage.dblclick()
  const preview = page.getByRole('dialog', { name: '图片预览' })
  await expect(preview).toBeVisible()
  expect((await preview.locator('img').boundingBox())!.width).toBeGreaterThan(inlineWidth)
  await preview.getByRole('button', { name: '原始尺寸', exact: true }).click()
  expect((await preview.locator('img').boundingBox())!.width).toBe(1600)
  await preview.getByRole('button', { name: '适应窗口', exact: true }).click()
  await preview.getByRole('button', { name: '复制图片', exact: true }).click()
  await expect(preview).toContainText('已复制图片')
  expect(await app.evaluate(async ({ clipboard }) => await clipboard.has('text/html'))).toBe(false)
  await preview.locator('img').click({ button: 'right' })
  await expect.poll(() => app.evaluate(async ({ clipboard }) => await clipboard.has('image/png'))).toBe(true)
  await page.screenshot({ path: path.join(temporary, 'image-preview.png') })
  await page.keyboard.press('Escape')
  await expect(preview).not.toBeVisible()
  await localImage.dblclick()
  await preview.getByRole('button', { name: '关闭图片预览' }).click()
  await expect(preview).not.toBeVisible()
  await localImage.dblclick()
  await preview.click({ position: { x: 5, y: 5 } })
  await expect(preview).not.toBeVisible()
  const after = (await page.evaluate(() => window.xm.snapshot())).notes.find(n => n.id === before.id)!
  expect(after.hash).toBe(before.hash)
  expect(after.body).toBe(before.body)
  console.log('PASS: 默认复制仅 PNG、Chromium 粘贴得到图片文件、显式邮件 HTML、默认复制清除旧 HTML、图片预览及正文未修改')
} finally {
  await app.close()
}
