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
