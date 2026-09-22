export interface HighlightSegment { text: string; highlighted: boolean }

export function splitMatches(text: string, query: string): HighlightSegment[] {
  const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length)
  if (!terms.length || !text) return [{ text, highlighted: false }]
  const escaped = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const matcher = new RegExp(`(${escaped.join('|')})`, 'giu')
  return text.split(matcher).filter(Boolean).map(part => ({ text: part, highlighted: terms.some(term => term.toLocaleLowerCase() === part.toLocaleLowerCase()) }))
}

export function splitDifference(current: string, incoming: string): [HighlightSegment[], HighlightSegment[]] {
  if (current === incoming) return [[{ text: current, highlighted: false }], [{ text: incoming, highlighted: false }]]
  let prefix = 0
  const limit = Math.min(current.length, incoming.length)
  while (prefix < limit && current[prefix] === incoming[prefix]) prefix++
  let currentEnd = current.length
  let incomingEnd = incoming.length
  while (currentEnd > prefix && incomingEnd > prefix && current[currentEnd - 1] === incoming[incomingEnd - 1]) { currentEnd--; incomingEnd-- }
  const segments = (text: string, end: number): HighlightSegment[] => [
    { text: text.slice(0, prefix), highlighted: false },
    { text: text.slice(prefix, end), highlighted: true },
    { text: text.slice(end), highlighted: false }
  ].filter(segment => segment.text.length > 0)
  return [segments(current, currentEnd), segments(incoming, incomingEnd)]
}
