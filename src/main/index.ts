import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu, Tray, nativeImage, clipboard, ClipboardItem } from 'electron'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Library, atomic, safePath } from './library'
import { CookieWatcher, type CookieRecord } from './cookies'
import { XArchive } from './x-source'
import { GithubSync, githubTokenKind, normalizeGithubToken, normalizeRepository, runConfiguredStartupSync } from './sync'
import { githubNetworkFetch } from './github-network'
import { generate } from './ai'
import { validateProviders } from './providers'
import type { Settings, Snapshot } from '../shared/types'
import { validDate } from '../shared/calendar'
import { xNetworkFetch } from './x-network'
import { XSession, cookiesFromStorage, type CapturedEndpoint, type StorageState } from './x-session'
import { CdpTargetArchive } from './x-cdp-target'

const dir = path.dirname(fileURLToPath(import.meta.url))
let win: BrowserWindow
let tray: Tray | undefined
let quitting = false
let closing = false
let rendererDirty = false
let generation: Promise<void> | undefined
async function flushWindow(recover = false) {
  if (!win || win.isDestroyed()) return
  await new Promise<void>((resolve, reject) => {
    const requestId = randomUUID()
    const timer = setTimeout(() => { ipcMain.removeListener('xm:flushed', listener); reject(new Error('SAVE_RESPONSE_TIMEOUT')) }, 10000)
    const listener = (event: Electron.IpcMainEvent, responseId: string, error: string) => {
      if (event.sender !== win.webContents || responseId !== requestId) return
      clearTimeout(timer); ipcMain.removeListener('xm:flushed', listener)
      error ? reject(new Error(error)) : resolve()
    }
    ipcMain.on('xm:flushed', listener); win.webContents.send('xm:flush', recover, requestId)
  })
}
async function ensureSaved() {
  if (!rendererDirty) return
  try { await flushWindow() } catch (error) {
    if (!rendererDirty) return
    if (error instanceof Error && error.message === 'SAVE_RESPONSE_TIMEOUT') {
      await dialog.showMessageBox(win, {type:'warning',title:'窗口暂未响应',message:'保存确认暂未收到，请返回窗口后重试。',detail:'这不表示原文件保存失败，也没有创建恢复副本。',buttons:['返回窗口']})
      throw new Error('窗口暂未响应，已保留窗口')
    }
    const result = await dialog.showMessageBox(win, { type: 'warning', title: '正文尚未保存到原文件', message: '可以将未保存正文另存为恢复副本，再关闭窗口。', detail: '原文和冲突记录保持不变。恢复副本会保存到应用数据目录 recovery，下一次启动会提示位置。', buttons: ['保留窗口', '另存恢复副本并继续关闭'], defaultId: 0, cancelId: 0 })
    if (result.response !== 1) throw new Error('已取消关闭，正文仍在当前窗口')
    await flushWindow(true)
  }
}
let library: Library
let archive: XArchive
let targetArchive: CdpTargetArchive
let sync: GithubSync
let cookieWatcher: CookieWatcher
let xSession!: XSession
let controller: AbortController | undefined
let credentials: CookieRecord[] = []
let settings: Settings
let settingsFile: string
let secretsFile: string
let secrets: Record<string,string> = {}
let tick: ReturnType<typeof setInterval>
const defaults: Settings = { theme: 'system', providers: [{ id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash' }], activeProvider: 'deepseek', scanMinutes: 30, collect: false, closeToTray: true, branch: 'main' }
const changed = () => { if (win && !win.isDestroyed()) win.webContents.send('xm:changed') }
const persist = () => atomic(settingsFile, JSON.stringify(settings))
function saveSecrets(nextSecrets = secrets) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，未保存密钥')
  const serialized = JSON.stringify(nextSecrets)
  const encrypted = safeStorage.encryptString(serialized)
  if (safeStorage.decryptString(encrypted) !== serialized) throw new Error('凭据加密校验失败，未替换原密钥')
  atomic(secretsFile, encrypted)
  if (safeStorage.decryptString(readFileSync(secretsFile)) !== serialized) throw new Error('凭据保存后校验失败，请重新保存')
  secrets = nextSecrets
}
async function openLibrary(root: string) {
  if (controller || sync?.running) throw new Error('请等待创作和同步结束后切换资料库')
  const nextLibrary = new Library(root, changed)
  archive?.pause(); targetArchive?.pause(); await cookieWatcher?.close(); await library?.close()
  library = nextLibrary; library.start()
  archive = new XArchive(library, () => credentials, changed, (input, init) => xSession.hasWorker() || xSession.loggedIn ? xSession.fetch(input, init) : xNetworkFetch(input, init))
  targetArchive = new CdpTargetArchive(library, app.getPath('userData'), changed)
  sync = new GithubSync(library, changed, githubNetworkFetch, () => rendererDirty)
  cookieWatcher = new CookieWatcher(async candidate => {
    const previous = secrets.cookies
    try { secrets.cookies = JSON.stringify(candidate); saveSecrets() }
    catch (e) { if (previous === undefined) delete secrets.cookies; else secrets.cookies = previous; throw e }
    archive.pause()
    credentials = candidate
    await xSession.importCookies(candidate)
    archive.status = 'Cookie 已保存到旧兼容会话；CDP 测试版请使用独立 Chrome 登录'
    changed()
  }, () => changed())
  if (credentials.length) cookieWatcher.status = secrets.xState ? '已记住浏览器登录态；可直接检查登录或扫描' : '已从本机加密存储载入 Cookie；登录状态需联网验证'
  if (settings.cookieDirectory) await cookieWatcher.watch(settings.cookieDirectory).catch(() => { cookieWatcher.status = '自动接收目录不可访问，请重新选择目录' })
}
const providerSchema = z.object({ id: z.string().regex(/^[\w-]+$/), name: z.string().trim().min(1).max(80), baseURL: z.url().refine(s => { const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password }), model: z.string().trim().min(1).max(150) })
const settingsSchema = z.object({ theme: z.enum(['system','light','dark']).optional(), providers: z.array(providerSchema).max(20).optional(), activeProvider: z.string().optional(), scanMinutes: z.number().int().min(15).max(1440).optional(), collect: z.boolean().optional(), closeToTray: z.boolean().optional(), repo: z.string().max(200).optional(), branch: z.string().max(150).optional() })
async function copyImageToClipboard(bytes: Buffer, richText = false) {
  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) throw new Error('图片无法读取')
  const png = image.toPNG()
  const dataURL = `data:image/png;base64,${png.toString('base64')}`
  await clipboard.write([new ClipboardItem({
    'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }),
    ...(richText ? { 'text/html': `<img src="${dataURL}" alt="图片">` } : {})
  })])
}
async function dispatch(method: string, args: unknown[]) {
  if (method === 'recoverUnsaved') {
    const note = z.object({ id: z.string().max(100), title: z.string().max(400), body: z.string().max(4_000_000) }).parse(args[0])
    const file = path.join(app.getPath('userData'), 'recovery', `${Date.now()}-${randomUUID()}.md`)
    atomic(file, `# ${note.title.replace(/[\r\n]/g, ' ')}\n\n${note.body}`)
    atomic(path.join(app.getPath('userData'), 'recovery-notice.json'), JSON.stringify({ file }))
    return file
  }
  if (method === 'snapshot') return { notes: [...library.notes.values()], conflicts: [...library.conflicts.values()], library: library.root, settings: { ...settings, providers: settings.providers.map(p => ({ ...p, hasKey: !!secrets[p.id] })), hasGithubKey: !!secrets.github, githubTokenType: githubTokenKind(secrets.github) }, status: library.errors.join('；'), xStatus: targetArchive.status, cookieStatus: 'CDP 使用独立 Chrome Profile 保存登录态', syncStatus: sync.status, archive: targetArchive.progress, xLoggedIn: targetArchive.loggedIn } satisfies Snapshot
  if (method === 'save') {
    const note = z.object({ id: z.string().optional(), kind: z.enum(['inspiration','memory','draft','topic']), title: z.string().max(400), body: z.string().max(4_000_000), tags: z.array(z.string()).max(50).optional(), groupId: z.string().optional(), parentId: z.string().optional(), scheduledDate: z.string().refine(validDate).optional(), completed: z.boolean().optional(), author: z.string().max(80).optional(), source: z.string().max(500).optional(), publishedAt: z.iso.datetime().optional(), sortOrder: z.number().int().min(0).optional(), partial: z.boolean().optional(), capturedImages: z.array(z.string().max(500)).max(40).optional() }).parse(args[0])
    return library.save(note, z.string().optional().parse(args[1]))
  }
  if (method === 'remove') return library.remove(z.string().parse(args[0]), z.boolean().optional().parse(args[1]))
  if (method === 'search') return library.search(z.object({ query: z.string().max(1000).optional(), kind: z.enum(['inspiration','memory','draft','topic']).optional(), tag: z.string().optional(), author: z.string().optional(), from: z.string().optional(), to: z.string().optional(), deleted: z.boolean().optional(), sort: z.enum(['relevance','date']).optional() }).parse(args[0]))
  if (method === 'resolve') return library.resolve(z.string().parse(args[0]), z.enum(['current','incoming','both','merge']).parse(args[1]), z.string().optional().parse(args[2]))
  if (method === 'image') return library.addImage(Buffer.from(z.array(z.number().int().min(0).max(255)).max(20*1024*1024).parse(args[0])), z.string().parse(args[1]))
  if (method === 'asset' || method === 'copyImage' || method === 'showImageMenu') {
    const rel = z.string().parse(args[0]); const from = z.string().optional().parse(args[1])
    const relative = rel.startsWith('assets/') ? rel : path.join(path.dirname(from || 'inspirations/note.md'), rel)
    const file = safePath(library.root, relative)
    if (!/\.(png|jpe?g|gif|webp)$/i.test(file)) throw new Error('不支持的图片格式')
    const bytes = readFileSync(file)
    if (bytes.length > 20*1024*1024) throw new Error('图片过大')
    if (method === 'copyImage') {
      await copyImageToClipboard(bytes)
      return
    }
    if (method === 'showImageMenu') {
      const copy = (richText = false) => { void copyImageToClipboard(bytes, richText).catch(() => dialog.showErrorBox('图片复制失败', '剪贴板暂不可用，请稍后重试。')) }
      Menu.buildFromTemplate([
        { label: '复制图片', click: () => copy() },
        { label: '复制图片（邮件富文本）', click: () => copy(true) }
      ]).popup({ window: win })
      return
    }
    const mime = file.endsWith('.png') ? 'png' : /\.jpe?g$/i.test(file) ? 'jpeg' : file.endsWith('.gif') ? 'gif' : 'webp'
    return `data:image/${mime};base64,${bytes.toString('base64')}`
  }
  if (method === 'selectLibrary') {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    if (!result.canceled) { await openLibrary(result.filePaths[0]); atomic(path.join(app.getPath('userData'), 'library-path.json'), JSON.stringify(result.filePaths[0])); changed() }
    return
  }
  if (method === 'openLibrary') return shell.openPath(library.root)
  if (method === 'exportNote') { const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }); if (!result.canceled) return shell.openPath(library.export(z.string().parse(args[0]), result.filePaths[0])); return }
  if (method === 'settings') {
    const next = settingsSchema.parse(args[0])
    if (next.repo?.trim()) next.repo = normalizeRepository(next.repo)
    if (next.branch !== undefined) next.branch = next.branch.trim()
    const secret = z.object({ providerId: z.string().optional(), apiKey: z.string().max(4096).optional(), githubKey: z.string().max(4096).optional() }).optional().parse(args[1])
    const nextSecrets = { ...secrets }
    const modelChange = next.providers !== undefined || next.activeProvider !== undefined || secret?.providerId !== undefined || secret?.apiKey !== undefined
    if (modelChange) {
      if (controller) throw new Error('创作中不能修改模型配置，请先停止')
      validateProviders(next.providers ?? settings.providers, next.activeProvider ?? settings.activeProvider, secret?.providerId)
      if (secret?.apiKey !== undefined && !secret.providerId) throw new Error('保存 Key 时必须指定模型服务')
    }
    const removed = next.providers ? settings.providers.filter(p => !next.providers!.some(n => n.id === p.id)) : []
    for (const p of removed) { if (!['github', 'cookies', 'xState', '__proto__', 'prototype', 'constructor'].includes(p.id)) delete nextSecrets[p.id] }
    if (secret?.providerId && secret.apiKey?.trim()) nextSecrets[secret.providerId] = secret.apiKey.trim()
    if (secret?.githubKey !== undefined) nextSecrets.github = normalizeGithubToken(secret.githubKey)
    if (secret || removed.length) saveSecrets(nextSecrets)
    settings = { ...settings, ...next, ...(secret?.githubKey !== undefined ? { githubTokenSavedAt: new Date().toISOString() } : {}) }; persist()
    changed(); return
  }
  if (method === 'importCookies') {
    const result = await dialog.showOpenDialog(win, { filters: [{ name: 'Cookie 导出文件', extensions: ['txt', 'json'] }], properties: ['openFile'] })
    if (!result.canceled) await cookieWatcher.import(result.filePaths[0]); return
  }
  if (method === 'watchCookies') {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (!result.canceled) { settings.cookieDirectory = result.filePaths[0]; persist(); await cookieWatcher.watch(result.filePaths[0]); changed() }; return
  }
  if (method === 'loginX') return targetArchive.login()
  if (method === 'connectX') return targetArchive.checkLogin()
  if (method === 'showX') return targetArchive.showWindow()
  if (method === 'disconnectX') return targetArchive.disconnect()
  if (method === 'collectTestPosts') return targetArchive.collectWithLogin()
  if (method === 'pauseScan') return targetArchive.pause()
  if (method === 'retryFailed') throw new Error('CDP 测试版本暂不批量补抓附件，请重新采集两条测试内容')
  if (method === 'sync') return sync.run(settings.repo || '', settings.branch, secrets.github || '')
  if (method === 'checkSync') return sync.check(settings.repo || '', settings.branch, secrets.github || '')
  if (method === 'cancel') { controller?.abort(); return }
  if (method === 'generate') {
    if (controller) throw new Error('已有创作正在进行，请先停止')
    const [id, instruction, selected, mode, agentMode] = z.tuple([z.string(), z.string().max(8000), z.array(z.string()).max(30), z.enum(['short','thread']), z.enum(['local','web'])]).parse(args)
    const origin = library.get(id)
    if (origin.kind !== 'inspiration' || origin.deleted) throw new Error('请从未删除的灵感中开始创作')
    validateProviders(settings.providers, settings.activeProvider)
    const configured = settings.providers.find(p => p.id === settings.activeProvider)!
    const provider = { ...configured }
    if (!secrets[provider.id]?.trim() || !provider.model.trim()) throw new Error(`请先在设置中保存 ${provider.name} 的模型名称和 API Key`)
    controller = new AbortController()
    generation = generate(library, provider, secrets[provider.id] || '', id, instruction, selected, mode, agentMode, controller.signal, e => { if (!win.isDestroyed()) win.webContents.send('xm:run', e) }).catch(e => { if (!win.isDestroyed()) win.webContents.send('xm:run', { type: 'error', text: e?.name === 'AbortError' ? '已停止，已有内容已保存' : '生成失败，请检查服务配置、额度或网络；已有内容已保存。' }) }).finally(() => { controller = undefined; changed() })
    return
  }
  if (method === 'external') { const url = new URL(z.string().parse(args[0])); if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('仅允许网页链接'); return shell.openExternal(url.href) }
  throw new Error('不支持的操作')
}
// Acquire before opening files or SQLite, including when launched from another build directory.
if (process.env.XMEMEORY_TEST_DATA) app.setPath('userData', process.env.XMEMEORY_TEST_DATA)
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus() } })
app.whenReady().then(async () => {
  if (!primaryInstance) return
  mkdirSync(app.getPath('userData'), { recursive: true })
  settingsFile = path.join(app.getPath('userData'), 'settings.json'); secretsFile = path.join(app.getPath('userData'), 'credentials.bin')
  settings = { ...defaults, ...(existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile,'utf8')) : {}) }
  if (existsSync(secretsFile)) { try { secrets = JSON.parse(safeStorage.decryptString(readFileSync(secretsFile))); credentials = JSON.parse(secrets.cookies || '[]') } catch { secrets = {} } }
  xSession = new XSession((state: StorageState, endpoint?: CapturedEndpoint) => {
    secrets.xState = JSON.stringify(state)
    if (endpoint) secrets.xEndpoint = JSON.stringify(endpoint)
    credentials = cookiesFromStorage(state)
    saveSecrets()
  }, message => { if (cookieWatcher) cookieWatcher.status = message; changed() })
  await xSession.prepare()
  const rootFile = path.join(app.getPath('userData'), 'library-path.json')
  await openLibrary(existsSync(rootFile) ? JSON.parse(readFileSync(rootFile, 'utf8')) : path.join(app.getPath('userData'), 'library'))
  await targetArchive.restore()
  settings.collect = false
  persist()
  win = new BrowserWindow({ width: 1360, height: 900, minWidth: 960, minHeight: 640, title: 'XMemeory', backgroundColor: '#f7f8fa', titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', webPreferences: { preload: path.join(dir, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', e => e.preventDefault())
  ipcMain.on('xm:dirty', (event, dirty) => { if (event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && typeof dirty === 'boolean') rendererDirty = dirty })
  ipcMain.handle('xm:call', async (event, method, args) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || typeof method !== 'string' || !Array.isArray(args)) return { error: '无效调用来源' }
    try { return { value: await dispatch(method, args) } } catch (e) { return { error: e instanceof Error ? e.message.replace(/Bearer\s+\S+/gi, 'Bearer [隐藏]') : '操作失败' } }
  })
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await win.loadFile(path.join(dir, '../renderer/index.html'))
  const recoveryNotice = path.join(app.getPath('userData'), 'recovery-notice.json')
  if (existsSync(recoveryNotice)) void dialog.showMessageBox(win, { type: 'info', message: '发现此前另存的未保存正文', detail: `恢复副本目录：${path.join(app.getPath('userData'), 'recovery')}`, buttons: ['稍后处理', '打开恢复目录'] }).then(result => { if (result.response === 1) void shell.openPath(path.join(app.getPath('userData'), 'recovery')) })
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'XMemeory', submenu: [{ label: '显示窗口', click: () => win.show() }, { role: 'quit', label: '退出' }] }, { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]))
  const pixels = Buffer.alloc(32 * 32 * 4)
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const at = (y * 32 + x) * 4, stroke = x > 6 && x < 25 && (Math.abs(x-y) < 3 || Math.abs(x+y-31) < 3)
    pixels.set(stroke ? [255,255,255,255] : [176,106,62,255], at)
  }
  const icon = nativeImage.createFromBitmap(pixels, { width: 32, height: 32 })
  tray = new Tray(icon); tray.setToolTip('XMemeory'); tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 XMemeory', click: () => win.show() }, { label: '退出', click: () => app.quit() }])); tray.on('click', () => win.show())
  win.on('close', e => {
    if (quitting) return
    e.preventDefault()
    if (!settings.closeToTray) { app.quit(); return }
    if (closing) return
    closing = true
    void ensureSaved().then(() => win.hide()).catch(() => { win.show() }).finally(() => { closing = false })
  })
  let lastSync = Date.now()
  void runConfiguredStartupSync(sync, settings.repo, settings.branch, secrets.github).finally(() => { lastSync = Date.now() })
  tick = setInterval(() => {
    if (settings.repo && secrets.github && !sync.running && Date.now()-lastSync >= 600_000) { lastSync = Date.now(); void sync.run(settings.repo, settings.branch, secrets.github).catch(() => {}) }
  }, 30_000)
}).catch(() => { dialog.showErrorBox('无法打开 XMemeory', '资料库初始化失败，请检查目录权限并退出其他版本后重试。没有删除资料库。'); app.exit(1) })
app.on('before-quit', e => {
  if (!primaryInstance) return
  if (quitting) return
  e.preventDefault()
  if (closing) return
  closing = true
  void (async () => {
    await ensureSaved()
    if (sync?.running) throw new Error('正在同步，请同步完成后退出')
    controller?.abort(); archive?.pause(); targetArchive?.pause(); clearInterval(tick)
    await generation
    await cookieWatcher?.close()
    await targetArchive?.shutdown()
    await xSession?.shutdown()
    // The OS closes SQLite after exit. In-flight archive requests may still finish before exit.
    quitting = true; app.quit()
  })().catch(e => dialog.showErrorBox('尚未退出', e.message)).finally(() => { closing = false })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !settings?.closeToTray) app.quit() })
