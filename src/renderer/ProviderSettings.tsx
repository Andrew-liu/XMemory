import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Provider, Settings } from '../shared/types'

export interface ProviderSettingsHandle { flush(): Promise<void> }
export const ProviderSettings = forwardRef<ProviderSettingsHandle, { settings: Settings; refresh: () => Promise<void>; error: (message: string) => void }>(function ProviderSettings({ settings, refresh, error }, ref) {
  const [draft, setDraft] = useState<Provider | undefined>(() => settings.providers.find(p => p.id === settings.activeProvider))
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const dirty = useRef(false), pending = useRef<Promise<void> | null>(null)
  useEffect(() => { if (!dirty.current && !pending.current) setDraft(settings.providers.find(p => p.id === settings.activeProvider)) }, [settings.providers, settings.activeProvider])
  function commit(action: 'save' | 'switch' | 'add' | 'delete', nextId?: string): Promise<void> {
    if (pending.current) return pending.current
    const operation = async () => {
      setBusy(true); error('')
      try {
        let providers = settings.providers.map(p => p.id === draft?.id ? draft : p).map(({ hasKey, ...p }) => p)
        let activeProvider = nextId ?? settings.activeProvider
        if (action === 'add') { activeProvider = crypto.randomUUID(); providers.push({ id: activeProvider, name: '兼容 API', baseURL: 'https://api.example.com/v1', model: '填写模型名称' }) }
        if (action === 'delete') { providers = providers.filter(p => p.id !== draft?.id); activeProvider = providers[0]?.id ?? '' }
        await window.xm.settings({ providers, activeProvider }, action !== 'delete' && key.trim() && draft ? { providerId: draft.id, apiKey: key.trim() } : undefined)
        dirty.current = false; window.xm.editorDirty(false); setKey('')
        const snapshot = await window.xm.snapshot()
        setDraft(snapshot.settings.providers.find(p => p.id === snapshot.settings.activeProvider))
        setStatus(action === 'delete' ? '已删除服务及其本机 Key，已切换到剩余服务' : '模型设置已保存')
        await refresh()
      } finally { setBusy(false) }
    }
    pending.current = operation().finally(() => { pending.current = null })
    return pending.current
  }
  useImperativeHandle(ref, () => ({ async flush() { if (pending.current) await pending.current; if (dirty.current) await commit('save') } }))
  const run = (action: 'save' | 'switch' | 'add' | 'delete', id?: string) => { void commit(action, id).catch(e => error(e.message)) }
  const edit = (field: string, value: string) => { dirty.current = true; window.xm.editorDirty(true); setStatus('未保存'); setDraft(p => p && ({ ...p, [field]: value })) }
  return <section className="settings-section"><h2>写作模型</h2><fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
    <label>当前服务<select aria-label="当前服务" value={settings.activeProvider} onChange={e => run('switch', e.target.value)}>{!draft && <option value={settings.activeProvider}>请选择有效服务</option>}{settings.providers.map(p => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}</select></label>
    {draft && <div className="form-grid">
      <label>服务名称<input value={draft.name} onChange={e => edit('name', e.target.value)}/></label>
      <label>模型名称<input value={draft.model} onChange={e => edit('model', e.target.value)}/></label>
      <label className="full">Base URL<input value={draft.baseURL} onChange={e => edit('baseURL', e.target.value)}/></label>
      <label className="full">API Key<input type="password" autoComplete="off" value={key} placeholder={draft.hasKey ? '已加密保存；留空保持原值' : '仅保存在本机'} onChange={e => { dirty.current = true; window.xm.editorDirty(true); setKey(e.target.value) }}/></label>
    </div>}
    <div className="button-row"><button className="primary" onClick={() => run('save')}>保存配置</button><button disabled={settings.providers.length >= 20} onClick={() => run('add')}>添加兼容服务</button><button disabled={!draft || settings.providers.length <= 1} onClick={() => run('delete')}>删除当前服务</button></div>
    <p>{status || '支持 DeepSeek 与 OpenAI Chat Completions 兼容接口；模型需支持流式输出和工具调用。切换服务或离开设置前会保存当前修改。'}</p>
  </fieldset></section>
})
