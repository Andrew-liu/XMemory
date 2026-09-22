import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
import FileHandler from '@tiptap/extension-file-handler'
import { Bold, Italic, List, Quote, Code, Table2, Link2, ImagePlus, FileCode2, Eye, ArrowDownToLine } from 'lucide-react'
import type { Note } from '../shared/types'
import { Wiki, resolveLink } from './wiki'
import { prepareMarkdown } from './markdown'
import { TypedMarkdownLink, linkAddress } from './links'

export interface EditorHandle { flush(): Promise<void>; recover(): Promise<void> }
export const NoteEditor = forwardRef<EditorHandle, { note: Note; notes: Note[]; open: (id: string) => void; error: (s: string) => void; saved: (note: Note) => void }>(function NoteEditor({ note, notes, open, error, saved }, ref) {
  const [title, setTitle] = useState(note.title)
  const [body, setBody] = useState(note.body)
  const [source, setSource] = useState(false)
  const [status, setStatus] = useState('已保存到本地')
  const [linkPicker, setLinkPicker] = useState(false)
  const [linkTerm, setLinkTerm] = useState('')
  const [linkForm, setLinkForm] = useState(false)
  const [linkText, setLinkText] = useState('')
  const [linkURL, setLinkURL] = useState('')
  const [linkError, setLinkError] = useState('')
  const [preview, setPreview] = useState<{ src: string; relative: string; alt: string } | null>(null)
  const [originalSize, setOriginalSize] = useState(false)
  const [imageMessage, setImageMessage] = useState('')
  const imageDialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = imageDialog.current
    if (!dialog) return
    if (preview && !dialog.open) dialog.showModal()
    if (!preview && dialog.open) dialog.close()
  }, [preview])
  const data = useRef({ note, title: note.title, body: note.body, dirty: false, busy: false })
  const notesRef = useRef(notes); notesRef.current = notes
  const saveChain = useRef(Promise.resolve())
  const input = useRef<HTMLInputElement>(null)
  const selectedImage = useRef<string | null>(null)
  const flush = () => {
    const work = async () => {
      const d = data.current
      if (!d.dirty) return
      const snapshot = { ...d.note, title: d.title, body: d.body }
      setStatus('保存中…')
      let result: Note
      try { result = await window.xm.save(snapshot, d.note.hash) }
      catch (cause) {
        const message = cause instanceof Error ? cause.message : '保存失败'
        if (message === '检测到外部修改，已保留双方。请在“冲突”中处理。') {
          const current = (await window.xm.snapshot()).notes.find(item => item.id === d.note.id)
          if (current) {
            d.note = current; d.title = current.title; d.body = current.body; d.dirty = false
            setTitle(current.title); setBody(current.body)
            editor?.commands.setContent(prepareMarkdown(current.body), { contentType: 'markdown', emitUpdate: false })
            window.xm.editorDirty(false); saved(current); setStatus('已保留双方 · 请处理冲突')
          }
        }
        throw cause
      }
      d.note = result
      if (d.title === snapshot.title && d.body === snapshot.body) d.dirty = false
      window.xm.editorDirty(d.dirty)
      saved(result); setStatus(d.dirty ? '等待保存…' : '已保存到本地')
    }
    saveChain.current = saveChain.current.catch(() => {}).then(work)
    return saveChain.current
  }
  useImperativeHandle(ref, () => ({ flush, recover: async () => {
    const d = data.current
    if (d.dirty) { await window.xm.recoverUnsaved({ id: d.note.id, title: d.title, body: d.body }); setStatus('未保存正文已另存恢复副本'); window.xm.editorDirty(false) }
  } }))
  useEffect(() => { window.xm.editorDirty(false); return () => window.xm.editorDirty(false) }, [note.id])
  const update = (value: string) => { if (value === data.current.body) return; data.current.body = value; data.current.dirty = true; window.xm.editorDirty(true); setBody(value); setStatus('等待保存…') }
  const importFiles = async (files: File[]) => {
    for (const file of files) {
      const relative = await window.xm.image([...new Uint8Array(await file.arrayBuffer())], file.name)
      editor?.chain().focus().setImage({ src: '../' + relative, alt: file.name }).run()
    }
  }
  const LocalImage = Image.extend({
    addAttributes() { return { ...this.parent?.(), src: { default: null, parseHTML: element => element.getAttribute('data-local-src') || element.getAttribute('src') } } },
    renderHTML({ HTMLAttributes }) {
      const { src, ...attributes } = HTMLAttributes
      return ['img', { ...attributes, 'data-local-src': src }]
    },
    addNodeView() {
      return ({ node }) => {
        const img = document.createElement('img'); img.alt = String(node.attrs.alt || '图片'); img.className = 'local-image'; img.dataset.localSrc = String(node.attrs.src || '')
        if (!/^https?:|^data:|^file:/i.test(node.attrs.src)) void window.xm.asset(node.attrs.src, data.current.note.path).then(src => { img.src = src }).catch(() => { img.alt = '图片缺失或不可访问' })
        else img.alt = '远程图片尚未导入，请粘贴图片文件'
        img.addEventListener('contextmenu', event => {
          event.preventDefault()
          selectedImage.current = img.dataset.localSrc || null
          if (selectedImage.current) void window.xm.showImageMenu(selectedImage.current, data.current.note.path).catch(e => error(e.message))
        })
        img.addEventListener('dblclick', event => {
          event.preventDefault(); event.stopPropagation()
          if (!img.src.startsWith('data:image/') || !img.complete || !img.naturalWidth) { error('图片尚未加载或本地文件缺失'); return }
          setOriginalSize(false); setImageMessage('')
          setPreview({ src: img.src, relative: img.dataset.localSrc || '', alt: img.alt })
        })
        img.title = '双击放大 · 右键复制图片'
        return { dom: img }
      }
    }
  })
  const editor = useEditor({
    extensions: [TypedMarkdownLink, StarterKit.configure({ link: { openOnClick: false, protocols: ['http','https'] } }), LocalImage, TableKit, Markdown.configure({ markedOptions: { gfm: true } }), Wiki.configure({ notes: () => notesRef.current, path: () => data.current.note.path, open }), FileHandler.configure({ allowedMimeTypes: ['image/png','image/jpeg','image/webp','image/gif'], consumePasteEvent: true, onPaste: (_ed, files, html) => { void importFiles(files).catch(e => error(e.message)); if (html) { const plain = new DOMParser().parseFromString(html, 'text/html').body.textContent; if (plain?.trim()) _ed.commands.insertContent({ type: 'text', text: plain }) } }, onDrop: (_ed, files) => { void importFiles(files).catch(e => error(e.message)) } })],
    content: prepareMarkdown(note.body), contentType: 'markdown',
    editorProps: {
      attributes: { 'aria-label': '灵感正文', spellcheck: 'false' },
      handlePaste: (_view, event) => {
        const clipboard = event.clipboardData
        if (!clipboard || clipboard.files.length) return false
        const text = clipboard.getData('text/plain')
        // Plain Markdown from editors/chat often also has an HTML text wrapper.
        if (!/(?:^|\n)\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}|!?\[[^\]\n]+\]\([^)]+\)|!?\[\[[^\]\n]+\]\]/m.test(text)) return false
        event.preventDefault()
        editor?.commands.insertContent(prepareMarkdown(text), { contentType: 'markdown' })
        return true
      },
      handleClick: (_view, _pos, event) => {
        const element = event.target as HTMLElement
        const image = element.closest('img.local-image')
        if (image) {
          selectedImage.current = image.getAttribute('data-local-src')
          return false
        }
        selectedImage.current = null
        const target = element.closest('a')
        if (!target) return false
        event.preventDefault()
        const href = target.getAttribute('href') || ''
        if (/^https?:\/\//i.test(href)) void window.xm.external(href).catch(e => error(e.message))
        else {
          let decoded = href
          try { decoded = decodeURIComponent(href) } catch { /* Keep original when malformed. */ }
          const linked = resolveLink(notesRef.current, decoded, data.current.note.path)
          if (linked) open(linked.id)
          else error('未找到链接的本地笔记；外部链接需要 http:// 或 https://')
        }
        return true
      },
      handleKeyDown: (_view, event) => {
        if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c' || !selectedImage.current) return false
        event.preventDefault()
        void window.xm.copyImage(selectedImage.current, data.current.note.path).catch(e => error(e.message))
        return true
      }
    },
    onUpdate: ({ editor }) => update(editor.getMarkdown())
  }, [note.id])
  useEffect(() => { const timer = setTimeout(() => { if (data.current.dirty) void flush().catch(e => { if (data.current.dirty) setStatus('未保存 · 存在错误'); error(e.message) }) }, 550); return () => clearTimeout(timer) }, [body, title])
  useEffect(() => {
    if (note.hash !== data.current.note.hash && !data.current.dirty) { data.current.note = note; data.current.body = note.body; data.current.title = note.title; setBody(note.body); setTitle(note.title); editor?.commands.setContent(prepareMarkdown(note.body), { contentType: 'markdown', emitUpdate: false }); setStatus('已读取外部更新') }
  }, [note.hash])
  const command = (fn: () => void) => { if (source) { editor?.commands.setContent(prepareMarkdown(body), { contentType: 'markdown', emitUpdate: false }); setSource(false) }; fn(); editor?.commands.focus() }
  const toggle = () => { if (source) editor?.commands.setContent(prepareMarkdown(body), { contentType: 'markdown', emitUpdate: false }); setSource(!source) }
  return <section className="document">
    <dialog ref={imageDialog} className="image-preview" aria-label="图片预览" onCancel={event => { event.preventDefault(); setPreview(null) }} onClick={event => { if (event.target === event.currentTarget) setPreview(null) }}>
      {preview && <div className="image-preview-frame">
        <header><span>图片预览</span><button onClick={() => setOriginalSize(value => !value)}>{originalSize ? '适应窗口' : '原始尺寸'}</button><button onClick={() => { void window.xm.copyImage(preview.relative, data.current.note.path).then(() => setImageMessage('已复制图片')).catch(e => setImageMessage(e.message)) }}>复制图片</button><button aria-label="关闭图片预览" onClick={() => setPreview(null)}>关闭 · Esc</button></header>
        <div className={`image-preview-media ${originalSize ? 'original-size' : ''}`}><img src={preview.src} alt={preview.alt} onContextMenu={event => { event.preventDefault(); void window.xm.showImageMenu(preview.relative, data.current.note.path).catch(e => setImageMessage(e.message)) }}/></div>
        <p aria-live="polite">{imageMessage || '双击打开的大图 · 右键可复制图片'}</p>
      </div>}
    </dialog>
    <header className="document-top"><span className="eyebrow">{note.kind === 'memory' ? '记忆档案' : note.kind === 'draft' ? '候选稿' : note.kind === 'topic' ? '长文选题' : '灵感笔记'}</span><span className="save-status"><i />{status}</span><button title="导出 Markdown 和图片" onClick={() => { void flush().then(() => window.xm.exportNote(note.id)).catch(e => error(e.message)) }}><ArrowDownToLine size={16}/></button></header>
    <input className="document-title" aria-label="标题" placeholder={note.kind === 'topic' ? '给长文起个标题' : '给灵感起个名字'} value={title} onChange={e => { setTitle(e.target.value); data.current.title = e.target.value; data.current.dirty = true; window.xm.editorDirty(true) }} />
    <div className="doc-meta">{note.kind === 'draft' && <span>{note.generationProvider ? `${note.generationProvider.name} · ${note.generationProvider.model}` : '生成模型未记录'}</span>}<span>{new Date(note.kind === 'memory' ? note.publishedAt || note.createdAt : note.createdAt).toLocaleDateString('zh-CN')}</span><span>{note.tags.join(' · ') || '私人资料库'}</span>{note.source && <button onClick={() => void window.xm.external(note.source!)}>查看原文 ↗</button>}{note.webSources?.map(source => <button key={source.url} title={source.title} onClick={() => void window.xm.external(source.url).catch(e => error(e.message))}>来源 · {source.source} ↗</button>)}</div>
    <div className="toolbar">
      <button title="加粗" onClick={() => command(() => editor?.chain().toggleBold().run())}><Bold size={16}/></button>
      <button title="斜体" onClick={() => command(() => editor?.chain().toggleItalic().run())}><Italic size={16}/></button>
      <button title="标题" onClick={() => command(() => editor?.chain().toggleHeading({ level: 2 }).run())}>H₂</button>
      <button title="列表" onClick={() => command(() => editor?.chain().toggleBulletList().run())}><List size={17}/></button>
      <button title="引用" onClick={() => command(() => editor?.chain().toggleBlockquote().run())}><Quote size={16}/></button>
      <button title="代码块" onClick={() => command(() => editor?.chain().toggleCodeBlock().run())}><Code size={17}/></button>
      <span className="toolbar-divider"/>
      <button title="插入表格" onClick={() => command(() => editor?.chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}><Table2 size={17}/></button>
      <button title="添加表格行" onClick={() => command(() => editor?.chain().addRowAfter().run())}>+行</button>
      <button title="添加表格列" onClick={() => command(() => editor?.chain().addColumnAfter().run())}>+列</button>
      <button title="删除表格行" onClick={() => command(() => editor?.chain().deleteRow().run())}>−行</button>
      <button title="删除表格列" onClick={() => command(() => editor?.chain().deleteColumn().run())}>−列</button>
      <button title="插入双链或嵌入" onClick={() => setLinkPicker(!linkPicker)}><Link2 size={17}/></button>
      <button title="插入链接" aria-label="插入链接" onClick={() => { setLinkForm(!linkForm); setLinkError('') }}>链接</button>
      <button title="插入图片" onClick={() => input.current?.click()}><ImagePlus size={17}/></button>
      <button className={source ? 'active' : ''} title="切换 Markdown 源码" onClick={toggle}>{source ? <Eye size={17}/> : <FileCode2 size={17}/>}</button>
      <input hidden ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={e => { void importFiles(Array.from(e.target.files || [])).catch(e => error(e.message)); e.target.value = '' }} />
    </div>
    {linkForm && <form className="link-form" onSubmit={e=>{e.preventDefault();try { const href=linkAddress(linkURL); command(()=>editor?.chain().focus().insertContent({type:'text',text:linkText.trim() || href,marks:[{type:'link',attrs:{href}}]}).run());setLinkForm(false);setLinkText('');setLinkURL('') } catch(e) {setLinkError((e as Error).message)} }}><input aria-label="链接文字" placeholder="链接文字" value={linkText} onChange={e=>setLinkText(e.target.value)}/><input aria-label="链接地址" placeholder="https://… 或笔记.md" value={linkURL} onChange={e=>setLinkURL(e.target.value)}/><button type="submit">插入</button><button type="button" onClick={()=>setLinkForm(false)}>取消</button>{linkError && <p role="alert">{linkError}</p>}</form>}
    {linkPicker && <div className="link-picker"><input autoFocus value={linkTerm} onChange={e => setLinkTerm(e.target.value)} placeholder="搜索要链接的笔记"/>{notes.filter(n => !n.deleted && n.title.includes(linkTerm)).slice(0, 8).map(n => <div key={n.id}><span>{n.title}</span><button onClick={() => { editor?.commands.insertContent({ type: 'wiki', attrs: { target: n.path.replace(/\.md$/, ''), label: n.title, embed: false } }); setLinkPicker(false) }}>双链</button><button onClick={() => { editor?.commands.insertContent({ type: 'wiki', attrs: { target: n.path.replace(/\.md$/, ''), label: n.title, embed: true } }); setLinkPicker(false) }}>嵌入</button></div>)}</div>}
    {source ? <textarea className="source-editor" aria-label="Markdown 源码" value={body} onChange={e => update(e.target.value)} spellCheck={false}/> : <EditorContent editor={editor}/>}
    <footer className="document-footer"><span>{body.length} 字符 · Markdown</span><span>{note.path}</span></footer>
    <div className="backlinks"><span className="eyebrow">反向链接</span>{notes.filter(n => n.id !== note.id && (n.body.includes(`[[${note.title}`) || n.body.includes(`[[${note.path.replace(/\.md$/, '')}`))).map(n => <button key={n.id} onClick={() => open(n.id)}>↗ {n.title}</button>)}</div>
  </section>
})
