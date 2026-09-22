import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import { useEffect, useState } from 'react'
import type { Note } from '../shared/types'

export function resolveLink(notes: Note[], target: string, from = '') {
  const name = target.split('#')[0].replace(/\.md$/, '')
  if (!name && from) return notes.find(n => !n.deleted && n.path === from)
  const normalize = (s: string) => { const parts: string[] = []; for (const p of s.split('/')) { if (p === '..') parts.pop(); else if (p && p !== '.') parts.push(p) }; return parts.join('/') }
  const relative = normalize(from.split('/').slice(0,-1).join('/') + '/' + name)
  const direct = notes.filter(n => !n.deleted && (n.path.replace(/\.md$/, '') === name || n.path.replace(/\.md$/, '') === relative))
  if (direct.length) return direct.length === 1 ? direct[0] : undefined
  const matches = notes.filter(n => !n.deleted && (n.title === name || n.id === name || n.path.split('/').pop()?.replace(/\.md$/, '') === name))
  return matches.length === 1 ? matches[0] : undefined
}
function WikiView({ node, extension }: NodeViewProps) {
  const { target, label, embed } = node.attrs
  const options = extension.options as { notes: () => Note[]; path: () => string; open: (id: string) => void }
  const note = resolveLink(options.notes(), target, options.path())
  const [image, setImage] = useState('')
  const imageTarget = /\.(png|jpe?g|webp|gif)$/i.test(target)
  useEffect(() => { if (embed && imageTarget) void window.xm.asset(target, options.path()).then(setImage).catch(() => setImage('')) }, [target, embed, imageTarget])
  let excerpt = note?.body || ''
  const heading = target.split('#')[1]
  if (heading) { const lines = excerpt.split('\n'); const at = lines.findIndex(l => l.replace(/^#+\s*/, '') === heading); excerpt = at >= 0 ? lines.slice(at, at+14).join('\n') : '未找到此标题' }
  return <NodeViewWrapper as="span" className={embed ? 'wiki-embed' : 'wiki-link'} contentEditable={false}>
    {embed && imageTarget ? image ? <img src={image} alt={target} style={{ maxWidth: /^\d+$/.test(label) ? Number(label) : undefined }} /> : <span>图片缺失：{target}</span>
      : <span onClick={() => note && options.open(note.id)} role="link" tabIndex={0} onKeyDown={e => e.key === 'Enter' && note && options.open(note.id)}>
        <span>{embed ? '↗ ' : '[['}{label || target}{!embed && ']]'}{!note && ' · 未找到或重名'}</span>
        {embed && note && <span className="embed-excerpt">{excerpt.slice(0, 700)}</span>}
      </span>}
  </NodeViewWrapper>
}
export const Wiki = Node.create({
  name: 'wiki', group: 'inline', inline: true, atom: true,
  addOptions() { return { notes: () => [] as Note[], path: (): string => '', open: (_id: string) => {} } },
  addAttributes() { return { target: { default: '' }, label: { default: '' }, embed: { default: false } } },
  parseHTML() { return [{ tag: 'span[data-wiki]' }] },
  renderHTML({ HTMLAttributes }) { return ['span', mergeAttributes(HTMLAttributes, { 'data-wiki': '' }), `[[${HTMLAttributes.target}]]`] },
  markdownTokenizer: {
    name: 'wiki', level: 'inline', start: (src: string) => src.search(/!?\[\[/),
    tokenize: (src: string) => { const m = src.match(/^(!?)\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/); return m ? { type: 'wiki', raw: m[0], target: m[2], label: m[3] || '', embed: m[1] === '!' } : undefined }
  },
  parseMarkdown: (token, helpers) => helpers.createNode('wiki', { target: token.target, label: token.label, embed: token.embed }),
  renderMarkdown: node => `${node.attrs?.embed ? '!' : ''}[[${node.attrs?.target}${node.attrs?.label ? `|${node.attrs.label}` : ''}]]`,
  addNodeView() { return ReactNodeViewRenderer(WikiView) }
})
