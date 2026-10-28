import type { JSONContent } from '@tiptap/core'

/** Protect wiki aliases from the GFM table cell splitter, without rewriting disk text. */
export function prepareMarkdown(markdown: string) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let fence = '', table = false
  const protect = (line: string) => line.replace(/!?\[\[[^\]\n]+\]\]/g, link => link.replace(/\\\||\|/g, pipe => pipe === '|' ? '\\|' : pipe))
  return lines.map((line, i) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1]
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''; table = false; return line }
    if (fence || /^ {4}|^\t/.test(line)) return line
    if (!line.trim() || !line.includes('|')) table = false
    const next = lines[i+1] || ''
    if (line.includes('|') && next.includes('|') && /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(next)) table = true
    return table ? protect(line) : line
  }).join('\n')
}

// GFM table cells must stay a single paragraph, so line breaks inside them are left alone.
const KEEP_BREAKS = new Set(['tableCell', 'tableHeader'])

/**
 * Pasted text keeps paragraph spacing consistent: every line break inside a pasted paragraph
 * (`<br>` from web pages and chat apps, or a single newline in Markdown) becomes a new paragraph,
 * the same as pressing Enter. Code blocks, headings and table cells are untouched; marks stay on
 * their text; blank lines produced by consecutive breaks are dropped.
 * Shift+Enter typed by the user is not affected because this only runs on pasted content.
 */
export function splitPastedLineBreaks(node: JSONContent): JSONContent {
  return { ...node, content: node.content && splitChildren(node.content, KEEP_BREAKS.has(node.type || '')) }
}

function splitChildren(children: JSONContent[], keep: boolean): JSONContent[] {
  return children.flatMap(child => {
    if (child.type === 'paragraph' && !keep) return splitParagraph(child)
    if (child.type === 'codeBlock' || child.type === 'heading' || !child.content) return [child]
    return [splitPastedLineBreaks(child)]
  })
}

function splitParagraph(paragraph: JSONContent): JSONContent[] {
  const lines: JSONContent[][] = [[]]
  for (const inline of paragraph.content || []) {
    if (inline.type === 'hardBreak') { lines.push([]); continue }
    if (inline.type !== 'text' || !inline.text?.includes('\n')) { lines[lines.length - 1].push(inline); continue }
    inline.text.split(/\r\n?|\n/).forEach((part, index) => {
      if (index) lines.push([])
      if (part) lines[lines.length - 1].push({ ...inline, text: part })
    })
  }
  if (lines.length === 1) return [paragraph]
  const paragraphs = lines.filter(line => line.some(inline => inline.type !== 'text' || inline.text?.trim()))
    .map(line => ({ ...paragraph, content: line }))
  return paragraphs.length ? paragraphs : [{ ...paragraph, content: undefined }]
}
