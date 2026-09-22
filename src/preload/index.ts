import { contextBridge, ipcRenderer } from 'electron'
import type { Bridge, RunEvent } from '../shared/types'
const call = (method: string, ...args: unknown[]) => ipcRenderer.invoke('xm:call', method, args).then((r: { value?: unknown; error?: string }) => { if (r.error) throw new Error(r.error); return r.value })
const bridge: Bridge = {
  editorDirty: dirty => ipcRenderer.send('xm:dirty', dirty),
  onBeforeClose: fn => {
    const listener = (_: unknown, recover: boolean, requestId: string) => { void Promise.resolve().then(()=>fn(recover)).then(() => ipcRenderer.send('xm:flushed', requestId, '')).catch(() => ipcRenderer.send('xm:flushed', requestId, '存在未保存内容，请处理保存错误或冲突后再关闭')) }
    ipcRenderer.on('xm:flush', listener)
    return () => { ipcRenderer.removeListener('xm:flush', listener) }
  },
  snapshot: () => call('snapshot') as ReturnType<Bridge['snapshot']>,
  recoverUnsaved: note => call('recoverUnsaved', note) as Promise<string>,
  save: (note, expected) => call('save', note, expected) as ReturnType<Bridge['save']>,
  search: q => call('search', q) as ReturnType<Bridge['search']>,
  remove: (id, restore) => call('remove', id, restore) as Promise<void>,
  resolve: (id, action, body) => call('resolve', id, action, body) as Promise<void>,
  image: (data, name) => call('image', data, name) as Promise<string>,
  asset: (path, notePath) => call('asset', path, notePath) as Promise<string>,
  copyImage: (path, notePath) => call('copyImage', path, notePath) as Promise<void>,
  showImageMenu: (path, notePath) => call('showImageMenu', path, notePath) as Promise<void>,
  selectLibrary: () => call('selectLibrary') as Promise<void>, openLibrary: () => call('openLibrary') as Promise<void>,
  exportNote: id => call('exportNote', id) as Promise<void>,
  settings: (value, secret) => call('settings', value, secret) as Promise<void>,
  importCookies: () => call('importCookies') as Promise<void>, watchCookies: () => call('watchCookies') as Promise<void>,
  loginX: () => call('loginX') as Promise<void>, connectX: () => call('connectX') as Promise<void>, showX: () => call('showX') as Promise<void>, disconnectX: () => call('disconnectX') as Promise<void>,
  collectTestPosts: () => call('collectTestPosts') as Promise<void>, pauseScan: () => call('pauseScan') as Promise<void>, retryFailed: () => call('retryFailed') as Promise<void>,
  sync: () => call('sync') as Promise<void>, checkSync: () => call('checkSync') as Promise<void>, generate: (...args) => call('generate', ...args) as Promise<void>, cancel: () => call('cancel') as Promise<void>,
  external: url => call('external', url) as Promise<void>,
  onChange: fn => { ipcRenderer.on('xm:changed', fn); return () => { ipcRenderer.removeListener('xm:changed', fn) } },
  onRun: fn => { const listener = (_: unknown, e: RunEvent) => fn(e); ipcRenderer.on('xm:run', listener); return () => { ipcRenderer.removeListener('xm:run', listener) } }
}
contextBridge.exposeInMainWorld('xm', bridge)
