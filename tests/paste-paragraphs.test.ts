import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import { splitPastedLineBreaks } from '../src/renderer/markdown'

const text = (value: string, marks?: JSONContent['marks']): JSONContent => marks ? { type: 'text', text: value, marks } : { type: 'text', text: value }
const br: JSONContent = { type: 'hardBreak' }
const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content })
const texts = (node: JSONContent) => (node.content || []).map(child => (child.content || []).map(inline => inline.text ?? `<${inline.type}>`).join(''))

describe('粘贴内容段内换行拆成段落', () => {
  it('<br> 硬换行拆成独立段落', () => {
    expect(texts(splitPastedLineBreaks(doc(p(text('第一句'), br, text('第二句'), br, text('第三句')))))).toEqual(['第一句', '第二句', '第三句'])
  })
  it('文本中的单个换行也拆段，连续换行不产生空段', () => {
    expect(texts(splitPastedLineBreaks(doc(p(text('甲\n乙\r\n\n丙')), p(text('丁')))))).toEqual(['甲', '乙', '丙', '丁'])
    expect(texts(splitPastedLineBreaks(doc(p(text('甲'), br, br, text('乙'), br))))).toEqual(['甲', '乙'])
  })
  it('格式随文字保留，行内图片等非文字节点不丢', () => {
    const bold = [{ type: 'bold' }]
    const result = splitPastedLineBreaks(doc(p(text('加粗', bold), br, { type: 'image', attrs: { src: 'a.png' } }, text(' 说明'))))
    expect(result.content).toEqual([p(text('加粗', bold)), p({ type: 'image', attrs: { src: 'a.png' } }, text(' 说明'))])
  })
  it('代码块、标题、表格单元格不拆', () => {
    const code: JSONContent = { type: 'codeBlock', content: [text('a\nb')] }
    const heading: JSONContent = { type: 'heading', attrs: { level: 2 }, content: [text('标'), br, text('题')] }
    const table: JSONContent = { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p(text('格'), br, text('内'))] }] }] }
    const input = doc(code, heading, table)
    expect(splitPastedLineBreaks(input)).toEqual(input)
  })
  it('列表项和引用里的段落同样拆分', () => {
    const result = splitPastedLineBreaks(doc({ type: 'blockquote', content: [p(text('引一'), br, text('引二'))] }, { type: 'bulletList', content: [{ type: 'listItem', content: [p(text('项一'), br, text('项二'))] }] }))
    expect(texts(result.content![0])).toEqual(['引一', '引二'])
    expect(texts(result.content![1].content![0])).toEqual(['项一', '项二'])
  })
  it('没有换行的段落原样返回，只有换行的段落变为空段', () => {
    const plain = doc(p(text('普通段落')))
    expect(splitPastedLineBreaks(plain)).toEqual(plain)
    expect(splitPastedLineBreaks(doc(p(br)))).toEqual(doc({ type: 'paragraph', content: undefined }))
  })
})
