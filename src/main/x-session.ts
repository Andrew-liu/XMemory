import { BrowserWindow, session as electronSession } from 'electron'
import type { CookieRecord } from './cookies'
import { X_USER_AGENT } from './x-client'
import { X_PARTITION, captureFromHttp, cookiesFromList, cookiesFromStorage, hasLoginCookies, type CapturedEndpoint, type StorageState } from './x-auth'

export { cookiesFromStorage, captureFromHttp as endpointFromRequest, hasLoginCookies, X_PARTITION }
export type { CapturedEndpoint, StorageState }

export function xAuthSession() {
  return electronSession.fromPartition(X_PARTITION)
}

export class XSession {
  status = '尚未登录 X'
  endpoint?: CapturedEndpoint
  loggedIn = false
  get ready() { return this.loggedIn }
  private loginWindow?: BrowserWindow
  private loginTask?: Promise<StorageState>
  private watching = false
  constructor(private persist: (state: StorageState, endpoint?: CapturedEndpoint) => void, private change: (message: string) => void) {}
  private report(message: string) { this.status = message; this.change(message) }
  async prepare() {
    const ses = xAuthSession()
    ses.setUserAgent(X_USER_AGENT)
    await ses.setProxy({ mode: 'system' })
    if (!this.watching) {
      this.watching = true
      const remember = (found?: CapturedEndpoint) => {
        if (!found) return
        this.endpoint = { ...this.endpoint, ...found, bearer: found.bearer || this.endpoint?.bearer || found.bearer, features: found.features || this.endpoint?.features, fieldToggles: found.fieldToggles || this.endpoint?.fieldToggles, origin: found.origin || this.endpoint?.origin, method: found.method || this.endpoint?.method }
      }
      ses.webRequest.onBeforeRequest({ urls: ['https://x.com/i/api/graphql/*', 'https://api.x.com/graphql/*'] }, (details, callback) => {
        const body = details.uploadData?.[0]?.bytes ? Buffer.from(details.uploadData[0].bytes).toString('utf8') : undefined
        remember(captureFromHttp(details.url, details.method, {}, body))
        callback({})
      })
      ses.webRequest.onBeforeSendHeaders({ urls: ['https://x.com/i/api/graphql/*', 'https://api.x.com/graphql/*'] }, (details, callback) => {
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(details.requestHeaders)) if (typeof value === 'string') headers[key.toLowerCase()] = value
        remember(captureFromHttp(details.url, details.method, headers))
        callback({ requestHeaders: details.requestHeaders })
      })
    }
  }
  async readCookies() {
    const ses = xAuthSession()
    const cookies = [...await ses.cookies.get({ url: 'https://x.com' }), ...await ses.cookies.get({ url: 'https://twitter.com' })]
    return cookiesFromList(cookies)
  }
  async snapshot(): Promise<StorageState> {
    const cookies = await this.readCookies()
    return {
      cookies: cookies.map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expirationDate,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure
      }))
    }
  }
  async importCookies(cookies: CookieRecord[]) {
    const ses = xAuthSession()
    for (const cookie of cookies) {
      const host = cookie.domain.replace(/^\./, '')
      await ses.cookies.set({
        url: `https://${host}/`,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: !!cookie.httpOnly,
        expirationDate: cookie.expirationDate
      })
    }
    this.loggedIn = hasLoginCookies(await this.readCookies())
  }
  async restore(state?: StorageState, endpoint?: CapturedEndpoint) {
    await this.prepare()
    this.endpoint = endpoint
    let cookies = await this.readCookies()
    if (!hasLoginCookies(cookies) && state && hasLoginCookies(cookiesFromStorage(state))) {
      await this.importCookies(cookiesFromStorage(state))
      cookies = await this.readCookies()
    }
    this.loggedIn = hasLoginCookies(cookies)
    if (this.loggedIn) {
      await this.ensureWorker().catch(() => {})
      this.report('已载入上次登录态，可检查登录或扫描书签')
    }
    return this.loggedIn
  }
  async login(parent?: BrowserWindow): Promise<StorageState> {
    if (this.loginTask) return this.loginTask
    this.loginTask = this.runLogin(parent).finally(() => { this.loginTask = undefined })
    return this.loginTask
  }
  private async runLogin(parent?: BrowserWindow): Promise<StorageState> {
    await this.prepare()
    this.report('正在打开登录窗口（使用系统代理）…')
    if (this.loginWindow && !this.loginWindow.isDestroyed()) { this.loginWindow.show(); this.loginWindow.focus() }
    else {
      this.loginWindow = new BrowserWindow({
        width: 1100,
        height: 800,
        parent,
        title: '登录 X',
        autoHideMenuBar: true,
        backgroundColor: '#ffffff',
        webPreferences: { session: xAuthSession(), contextIsolation: true, nodeIntegration: false, sandbox: true }
      })
      this.loginWindow.webContents.setWindowOpenHandler(({ url }) => {
        try {
          const host = new URL(url).hostname
          if (!/(^|\.)(x\.com|twitter\.com|accounts\.google\.com|appleid\.apple\.com)$/i.test(host)) return { action: 'deny' as const }
        } catch { return { action: 'deny' as const } }
        return {
          action: 'allow' as const,
          overrideBrowserWindowOptions: {
            parent: this.loginWindow,
            width: 520,
            height: 720,
            webPreferences: { session: xAuthSession(), contextIsolation: true, nodeIntegration: false, sandbox: true }
          }
        }
      })
      await this.loginWindow.loadURL('https://x.com/i/bookmarks')
    }
    await this.waitForLogin()
    this.report('已检测到登录，正在保存会话…')
    try { if (this.loginWindow && !this.loginWindow.isDestroyed()) await this.loginWindow.loadURL('https://x.com/i/bookmarks') } catch { /* Cookies already exist. */ }
    const until = Date.now() + 8_000
    while (!this.endpoint && Date.now() < until) await new Promise(r => setTimeout(r, 400))
    const state = await this.snapshot()
    if (!hasLoginCookies(cookiesFromStorage(state))) throw new Error('未拿到 X 登录 Cookie，请确认已登录成功')
    this.loggedIn = true
    this.persist(state, this.endpoint)
    this.keepWorker()
    this.report(this.endpoint ? '已记住登录态，并捕获书签接口' : '已记住登录态；扫描时再识别书签接口')
    return state
  }
  private async waitForLogin() {
    const deadline = Date.now() + 10 * 60_000
    while (Date.now() < deadline) {
      const closed = !this.loginWindow || this.loginWindow.isDestroyed()
      const cookies = await this.readCookies()
      if (hasLoginCookies(cookies)) return
      if (closed) throw new Error('登录窗口已关闭，未保存登录态')
      await new Promise(r => setTimeout(r, 1000))
    }
    throw new Error('登录超时。请在 10 分钟内完成登录，或关闭窗口后重试')
  }
  private worker?: BrowserWindow
  async ensureWorker() {
    if (this.hasWorker()) return
    this.worker = new BrowserWindow({
      show: false,
      width: 900,
      height: 700,
      title: 'X 会话',
      webPreferences: { session: xAuthSession(), contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    await this.worker.loadURL('https://x.com/i/bookmarks')
    await new Promise(r => setTimeout(r, 800))
  }
  private keepWorker() {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.worker = this.loginWindow
      this.loginWindow = undefined
      this.worker.setTitle('X 会话')
      this.worker.hide()
    }
  }
  private closeLoginWindow() {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) this.loginWindow.close()
    this.loginWindow = undefined
  }
  hasWorker() { return !!this.worker && !this.worker.isDestroyed() }
  async fetch(input: RequestInfo | URL, init?: RequestInit) {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.protocol !== 'https:' || !['x.com', 'api.x.com', 'abs.twimg.com', 'pbs.twimg.com', 'twitter.com'].includes(url.hostname) || url.username || url.password) throw new Error('X 请求地址不在允许范围')
    if (this.loggedIn && !this.hasWorker() && url.hostname !== 'abs.twimg.com' && url.hostname !== 'pbs.twimg.com') await this.ensureWorker().catch(() => {})
    if (!this.hasWorker() || url.hostname === 'abs.twimg.com' || url.hostname === 'pbs.twimg.com') {
      const { xNetworkFetch } = await import('./x-network')
      return xNetworkFetch(input, init)
    }
    const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) }
    delete headers.cookie
    delete headers.Cookie
    const redirect = init?.redirect === 'error' || init?.redirect === 'manual' ? 'manual' : 'follow'
    const result = await this.worker!.webContents.executeJavaScript(`(async () => {
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 30000)
        const response = await fetch(${JSON.stringify(url.href)}, { method: ${JSON.stringify(init?.method || 'GET')}, headers: ${JSON.stringify(headers)}, credentials: 'include', redirect: ${JSON.stringify(redirect)}, signal: ctrl.signal })
        clearTimeout(timer)
        const headerMap = {}
        response.headers.forEach((value, key) => { headerMap[key] = value })
        return { status: response.status, headers: headerMap, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) }
      } catch (error) {
        return { error: String(error && error.message || error) }
      }
    })()`) as { status?: number; headers?: Record<string, string>; bytes?: number[]; error?: string }
    if (result.error) throw new Error(result.error)
    return new Response(Uint8Array.from(result.bytes || []), { status: result.status || 0, headers: result.headers })
  }
  async shutdown() {
    this.closeLoginWindow()
    if (this.worker && !this.worker.isDestroyed()) this.worker.close()
    this.worker = undefined
  }
  async disconnect() {
    await this.shutdown()
    this.loggedIn = false
    this.endpoint = undefined
    await xAuthSession().clearStorageData()
    this.report('已退出 X 登录')
  }
}
