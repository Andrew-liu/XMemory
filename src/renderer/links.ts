import { Extension, InputRule } from '@tiptap/core'
export function linkAddress(input: string) {
  const value = input.trim()
  if (/^(?:\.{1,2}\/|#)/.test(value) || /^[^:?#]+\.md(?:#.*)?$/.test(value)) return value
  const candidate = /^[\w-]+(?:\.[\w-]+)+(?:[/:?#]|$)/.test(value) ? `https://${value}` : value
  let url: URL
  try { url = new URL(candidate) } catch { throw new Error('请输入完整网址，例如 https://www.baidu.com，或本地笔记.md') }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持 http/https 网页或本地笔记链接')
  return url.href
}
export const TypedMarkdownLink = Extension.create({
  name: 'typedMarkdownLink',
  addInputRules() { return [new InputRule({
    find: /(?<![\\!])\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/,
    handler: ({ state, range, match }) => {
      if (state.selection.$from.parent.type.spec.code) return null
      state.tr.replaceWith(range.from, range.to, state.schema.text(match[1], [state.schema.marks.link.create({ href: match[2] })]))
    }
  })] }
})
