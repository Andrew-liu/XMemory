import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, session, Menu, Tray, nativeImage, clipboard, ClipboardItem, nativeTheme, powerMonitor, powerSaveBlocker, protocol } from 'electron'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { ASSET_SCHEME, parseAssetURL } from '../shared/assets'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Library, atomic, safePath } from './library'
import { migrateLibrary } from './migrate'
import { resolveImage } from './layout'
import { GithubSync, githubTokenKind, normalizeGithubToken, normalizeRepository, runConfiguredStartupSync } from './sync'
import { githubNetworkFetch } from './github-network'
import { pruneSecrets } from './providers'
import type { Settings, Snapshot } from '../shared/types'
import { validDate } from '../shared/calendar'
import { palettes, themeColors } from '../shared/themes'
import { XCapture } from './x-capture'
import { AutoCollector } from './auto-collect'
import { addRecovery, clearRecoveries, pendingRecoveries } from './recovery'
import { trayIcon16, trayIcon32 } from './tray-icon'
import { trayTemplate18, trayTemplate36 } from './tray-template'

const dir = path.dirname(fileURLToPath(import.meta.url))
let win: BrowserWindow
let tray: Tray | undefined
let quitting = false
let closing = false
let rendererDirty = false
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
let capture: XCapture
let auto: AutoCollector | undefined
let sync: GithubSync
let settings: Settings
let settingsFile: string
let secretsFile: string
let secrets: Record<string,string> = {}
let tick: ReturnType<typeof setInterval>
const defaults: Settings = { theme: 'system', closeToTray: true, branch: 'main', autoCollect: false, backfillHistory: false, memoryView: 'list' }
const loginItems: { available: boolean; get(): boolean; set(enabled: boolean): void } = process.env.XMEMEORY_TEST_DATA
  ? (() => { let enabled = false; return { available: process.env.XMEMEORY_TEST_AUTOSTART !== 'unavailable', get: () => enabled, set: (value: boolean) => { enabled = value } } })()
  : {
      available: app.isPackaged,
      get: () => app.getLoginItemSettings(process.platform === 'win32' ? { args: ['--hidden'] } : undefined).openAtLogin,
      set: (enabled: boolean) => app.setLoginItemSettings(process.platform === 'win32' ? { openAtLogin: enabled, args: ['--hidden'] } : { openAtLogin: enabled })
    }
const changed = () => { keepAwake(!!capture?.busy); if (win && !win.isDestroyed()) win.webContents.send('xm:changed') }
// While collecting, keep macOS from napping this app and its helper Chrome (App Nap throttles timers and page scrolling).
// Shown for a minute after an on-disk layout upgrade, then left to the backup folder and the changelog.
let upgradeNotice = { text: '', until: 0 }
let napBlocker: number | undefined
function keepAwake(active: boolean) {
  if (active && napBlocker === undefined) napBlocker = powerSaveBlocker.start('prevent-app-suspension')
  else if (!active && napBlocker !== undefined) { powerSaveBlocker.stop(napBlocker); napBlocker = undefined }
}
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
  if (sync?.running) throw new Error('请等待同步结束后切换资料库')
  // Older libraries are upgraded in place to the Obsidian-compatible layout before anything reads them.
  const migrated = migrateLibrary(root)
  const nextLibrary = new Library(root, changed)
  if (migrated) upgradeNotice = { text: `资料库已升级为 Obsidian 兼容结构（${migrated.notes} 篇笔记），可直接用 Obsidian 打开此文件夹。升级前的完整备份：${migrated.backup}`, until: Date.now() + 60_000 }
  auto?.dispose(); capture?.pause(); await capture?.disconnect().catch(() => {}); await library?.close()
  library = nextLibrary; library.start()
  capture = new XCapture(library, app.getPath('userData'), changed)
  const owner = capture
  auto = new AutoCollector({
    now: () => Date.now(), random: () => Math.random(),
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    summary: () => owner.bookmarksSummary(),
    backfill: () => settings.backfillHistory === true,
    run: async limit => {
      const backfill = settings.backfillHistory === true
      const result = await owner.collectBookmarks(limit, { silent: true, backfill })
      // Backfill turns itself off once a round reaches the oldest bookmark.
      if (backfill && result.stopReason === 'bottom') { settings = { ...settings, backfillHistory: false }; persist() }
      if (settings.autoCollect && ['bottom', 'known-streak', 'check-limit', 'limit', 'time'].includes(result.stopReason)) await owner.retryIncomplete()
      return result
    },
    finish: async () => { await owner.release() },
    change: changed
  })
  if (settings?.autoCollect) auto.setEnabled(true)
  sync = new GithubSync(library, changed, githubNetworkFetch, () => rendererDirty)
}
const memoryViews = ['list', 'card'] as const
const settingsSchema = z.object({ theme: z.enum(['system','light','dark']).optional(), palette: z.enum(palettes).optional(), closeToTray: z.boolean().optional(), repo: z.string().max(200).optional(), branch: z.string().max(150).optional(), memoryView: z.enum(memoryViews).optional(), backfillHistory: z.boolean().optional(), usdToCnyRate: z.number().min(0.01).max(1000).optional(), incomeCategories: z.array(z.string().max(60)).max(80).optional() })
// Unattended rounds share one Chrome; turning off stops the round and closes Chrome right away.
async function setAutoCollect(enabled: boolean) {
  settings = { ...settings, autoCollect: enabled }; persist()
  auto?.setEnabled(enabled)
  if (!enabled && auto?.running) { capture.pause(); await capture.disconnect() }
  changed()
}
async function recollect(id: string) {
  const note = library.notes.get(id)
  if (!note || note.deleted || note.kind !== 'memory' || !note.source) throw new Error('只有带原文链接的记忆可以重新采集')
  if (auto?.running || capture.busy) throw new Error('采集中，请等待本轮结束')
  try { return await capture.collectUrl(note.source) }
  finally { await capture.release().catch(() => {}) }
}
const windowBackground = () => themeColors(settings.palette, settings.theme === 'dark' || (settings.theme !== 'light' && nativeTheme.shouldUseDarkColors)).bg
const syncWindowBackground = () => { if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground()) }
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
const imageMime = (file: string) => file.endsWith('.png') ? 'image/png' : /\.jpe?g$/i.test(file) ? 'image/jpeg' : file.endsWith('.gif') ? 'image/gif' : 'image/webp'
/** Absolute path of a library image referenced from a note; rejects paths outside the library and non-image files. */
function libraryImage(rel: string, from?: string) {
  const file = safePath(library.root, resolveImage(rel, from || 'inspirations/note.md'))
  if (!/\.(png|jpe?g|gif|webp)$/i.test(file)) throw new Error('不支持的图片格式')
  return file
}
/** Serves `xm-asset://` image requests with async file reads so large images never block the main process. */
async function serveAsset(request: Request) {
  const ref = parseAssetURL(request.url)
  if (!ref) return new Response('无效的图片地址', { status: 400 })
  try {
    const file = libraryImage(ref.relative, ref.from)
    const info = await stat(file)
    if (!info.isFile() || info.size > 20 * 1024 * 1024) return new Response('图片不可用', { status: 404 })
    return new Response(new Uint8Array(await readFile(file)), { headers: { 'Content-Type': imageMime(file), 'Cache-Control': 'no-cache' } })
  } catch { return new Response('图片缺失或不可访问', { status: 404 }) }
}
async function dispatch(method: string, args: unknown[]) {
  if (method === 'recoverUnsaved') {
    const note = z.object({ id: z.string().max(100), title: z.string().max(400), body: z.string().max(4_000_000) }).parse(args[0])
    const recoveryDir = path.join(app.getPath('userData'), 'recovery')
    const file = path.join(recoveryDir, `${Date.now()}-${randomUUID()}.md`)
    atomic(file, `# ${note.title.replace(/[\r\n]/g, ' ')}\n\n${note.body}`)
    addRecovery(path.join(app.getPath('userData'), 'recovery-notice.json'), recoveryDir, file)
    return file
  }
  if (method === 'snapshot') return { notes: [...library.notes.values()], conflicts: [...library.conflicts.values()], library: library.root, version: app.getVersion(), settings: { ...settings, hasGithubKey: !!secrets.github, githubTokenType: githubTokenKind(secrets.github), openAtLogin: loginItems.get(), openAtLoginAvailable: loginItems.available }, status: [Date.now() < upgradeNotice.until ? upgradeNotice.text : '', ...library.errors].filter(Boolean).join('；'), xStatus: capture.status, syncStatus: sync.status, archive: capture.progress, xLoggedIn: capture.loggedIn, xLogin: capture.loginRecord, bookmarks: capture.bookmarksSummary(), auto: auto?.state || { enabled: false, active: false }, partialRetries: capture.retryInfo() } satisfies Snapshot
  if (method === 'save') {
    const note = z.object({ id: z.string().optional(), kind: z.enum(['inspiration','memory','draft','topic','income']), title: z.string().max(400), body: z.string().max(4_000_000), tags: z.array(z.string()).max(50).optional(), groupId: z.string().optional(), parentId: z.string().optional(), scheduledDate: z.string().refine(validDate).optional(), completed: z.boolean().optional(), author: z.string().max(80).optional(), source: z.string().max(500).optional(), publishedAt: z.iso.datetime().optional(), sortOrder: z.number().int().min(0).optional(), partial: z.boolean().optional(), capturedImages: z.array(z.string().max(500)).max(40).optional(), amount: z.number().min(0).max(100_000_000).optional(), currency: z.enum(['CNY', 'USD']).optional(), incomeCategory: z.string().max(80).optional(), incomeStatus: z.enum(['confirmed', 'completed', 'received']).optional(), receivedAt: z.string().max(80).optional() }).parse(args[0])
    return library.save(note, z.string().optional().parse(args[1]), z.object({ quiet: z.boolean().optional() }).optional().parse(args[2]))
  }
  if (method === 'remove') return library.remove(z.string().parse(args[0]), z.boolean().optional().parse(args[1]))
  if (method === 'search') return library.search(z.object({ query: z.string().max(1000).optional(), kind: z.enum(['inspiration','memory','draft','topic','income']).optional(), tag: z.string().optional(), author: z.string().optional(), from: z.string().optional(), to: z.string().optional(), deleted: z.boolean().optional(), sort: z.enum(['relevance','date']).optional() }).parse(args[0]))
  if (method === 'resolve') return library.resolve(z.string().parse(args[0]), z.enum(['current','incoming','both','merge']).parse(args[1]), z.string().optional().parse(args[2]))
  if (method === 'image') return library.addImage(Buffer.from(z.array(z.number().int().min(0).max(255)).max(20*1024*1024).parse(args[0])), z.string().parse(args[1]))
  if (method === 'asset' || method === 'copyImage' || method === 'showImageMenu') {
    const rel = z.string().parse(args[0]); const from = z.string().optional().parse(args[1])
    const file = libraryImage(rel, from)
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
    return `data:${imageMime(file)};base64,${bytes.toString('base64')}`
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
    const secret = z.object({ githubKey: z.string().max(4096).optional() }).optional().parse(args[1])
    const nextSecrets = { ...secrets }
    if (secret?.githubKey !== undefined) nextSecrets.github = normalizeGithubToken(secret.githubKey)
    if (secret?.githubKey !== undefined) saveSecrets(nextSecrets)
    settings = { ...settings, ...next, ...(secret?.githubKey !== undefined ? { githubTokenSavedAt: new Date().toISOString() } : {}) }; persist()
    if (next.theme !== undefined || next.palette !== undefined) syncWindowBackground()
    changed(); return
  }
  if (method === 'loginX') return capture.login()
  if (method === 'connectX') return capture.checkLogin()
  if (method === 'showX') return capture.showWindow()
  if (method === 'disconnectX') return capture.disconnect()
  if (method === 'setAutoCollect') return setAutoCollect(z.boolean().parse(args[0]))
  if (method === 'recollect') return recollect(z.string().max(200).parse(args[0]))
  if (method === 'sync') return sync.run(settings.repo || '', settings.branch, secrets.github || '')
  if (method === 'checkSync') return sync.check(settings.repo || '', settings.branch, secrets.github || '')
  if (method === 'setOpenAtLogin') {
    const enabled = z.boolean().parse(args[0])
    if (!loginItems.available) throw new Error('开机自启仅安装版可用')
    loginItems.set(enabled)
    if (loginItems.get() !== enabled) throw new Error('系统未接受开机自启设置，可能受权限或策略限制')
    changed(); return
  }
  if (method === 'external') { const url = new URL(z.string().parse(args[0])); if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('仅允许网页链接'); return shell.openExternal(url.href) }
  throw new Error('不支持的操作')
}
// Acquire before opening files or SQLite, including when launched from another build directory.
if (process.env.XMEMEORY_TEST_DATA) app.setPath('userData', process.env.XMEMEORY_TEST_DATA)
protocol.registerSchemesAsPrivileged([{ scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus() } })
app.whenReady().then(async () => {
  if (!primaryInstance) return
  mkdirSync(app.getPath('userData'), { recursive: true })
  protocol.handle(ASSET_SCHEME, serveAsset)
  settingsFile = path.join(app.getPath('userData'), 'settings.json'); secretsFile = path.join(app.getPath('userData'), 'credentials.bin')
  const stored: Record<string, unknown> = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile,'utf8')) : {}
  for (const legacy of ['scanMinutes', 'collect', 'cookieDirectory', 'providers', 'activeProvider']) delete stored[legacy]
  settings = { ...defaults, ...stored }
  if (settings.palette !== undefined && !(palettes as readonly string[]).includes(settings.palette)) delete settings.palette
  if (typeof settings.autoCollect !== 'boolean') settings.autoCollect = false
  if (typeof settings.backfillHistory !== 'boolean') settings.backfillHistory = false
  if (!(memoryViews as readonly unknown[]).includes(settings.memoryView)) settings.memoryView = 'list'
  if (existsSync(secretsFile)) { try { secrets = JSON.parse(safeStorage.decryptString(readFileSync(secretsFile))) } catch { secrets = {} } }
  if (pruneSecrets(secrets)) { try { saveSecrets() } catch { /* Retry on the next launch. */ } }
  if (!settings.legacyXCleanedAt) {
    try {
      await session.fromPartition('persist:xmemeory-x').clearStorageData()
      settings.legacyXCleanedAt = new Date().toISOString()
      persist()
    } catch { /* Retry on the next launch. */ }
  }
  const rootFile = path.join(app.getPath('userData'), 'library-path.json')
  try { await openLibrary(existsSync(rootFile) ? JSON.parse(readFileSync(rootFile, 'utf8')) : path.join(app.getPath('userData'), 'library')) }
  catch (error) {
    // Never run on a half-understood library: report and quit, leaving the files (and any backup) untouched.
    dialog.showErrorBox('无法打开资料库', error instanceof Error ? error.message : '未知错误')
    app.exit(1); return
  }
  await capture.restore()
  persist()
  powerMonitor.on('resume', () => auto?.resume())
  const startHidden = process.argv.includes('--hidden') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin)
  win = new BrowserWindow({ width: 1360, height: 900, minWidth: 960, minHeight: 640, title: 'XMemeory', backgroundColor: windowBackground(), titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', show: !startHidden, webPreferences: { preload: path.join(dir, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  nativeTheme.on('updated', syncWindowBackground)
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
  const recoveryDir = path.join(app.getPath('userData'), 'recovery')
  const showRecoveryNotice = () => {
    const files = pendingRecoveries(recoveryNotice, recoveryDir)
    if (!files.length) return
    const names = files.slice(-3).map(file => `· ${path.basename(file)}`).join('\n')
    void dialog.showMessageBox(win, { type: 'info', message: `发现 ${files.length} 份此前另存的未保存正文`, detail: `${names}${files.length > 3 ? '\n…' : ''}\n\n恢复副本目录：${recoveryDir}\n确认内容已找回后，可选择“已处理，不再提醒”。`, buttons: ['稍后处理', '打开恢复副本', '打开恢复目录', '已处理，不再提醒'], defaultId: 1, cancelId: 0 }).then(result => {
      if (result.response === 1) void shell.openPath(files.at(-1)!)
      if (result.response === 2) void shell.openPath(recoveryDir)
      if (result.response === 3) clearRecoveries(recoveryNotice)
    })
  }
  if (startHidden) win.once('show', showRecoveryNotice)
  else showRecoveryNotice()
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'XMemeory', submenu: [{ label: '显示窗口', click: () => win.show() }, { role: 'quit', label: '退出' }] }, { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]))
  // macOS menu bar icons are monochrome "template" images that the system recolours for light/dark menu bars.
  const mac = process.platform === 'darwin'
  const icon = nativeImage.createFromDataURL(mac ? trayTemplate18 : trayIcon16)
  icon.addRepresentation({ scaleFactor: 2, dataURL: mac ? trayTemplate36 : trayIcon32 })
  if (mac) icon.setTemplateImage(true)
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
    if (sync?.running) {
      // Stop at the next checkpoint; a sync stopped before its branch update leaves the remote untouched.
      sync.cancel()
      for (let waited = 0; sync.running && waited < 15_000; waited += 200) await new Promise(resolve => setTimeout(resolve, 200))
      if (sync.running) throw new Error('同步正在等待 GitHub 响应，请稍后再退出')
    }
    auto?.dispose(); capture?.pause(); clearInterval(tick)
    await capture?.shutdown()
    // The OS closes SQLite after exit. In-flight archive requests may still finish before exit.
    quitting = true; app.quit()
  // showMessageBox, not showErrorBox: the latter blocks the main thread, so even a system-initiated quit could not proceed.
  })().catch(e => { void dialog.showMessageBox(win, { type: 'warning', title: '尚未退出', message: e instanceof Error ? e.message : '退出前的处理未完成', buttons: ['好'] }) }).finally(() => { closing = false })
})
// Clicking the Dock icon brings the window back after it was closed to the menu bar.
app.on('activate', () => { if (win && !win.isDestroyed()) { win.show(); win.focus() } })
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !settings?.closeToTray) app.quit() })
