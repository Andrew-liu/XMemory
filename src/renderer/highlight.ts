import { findAllSearchMatches } from '../shared/search-location'

export interface HighlightSegment { text: string; highlighted: boolean }

export function splitMatches(text: string, query: string): HighlightSegment[] {
  const matches = findAllSearchMatches(text, query)
  if (!matches.length) return [{ text, highlighted: false }]
  const segments: HighlightSegment[] = []
  let cursor = 0
  for (const { from, to } of matches) {
    if (from > cursor) segments.push({ text: text.slice(cursor, from), highlighted: false })
    segments.push({ text: text.slice(from, to), highlighted: true })
    cursor = to
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), highlighted: false })
  return segments
}

/** Preview text that starts near the first match, so a hit beyond the first 140 characters is still visible. */
export function matchSnippet(text: string, query: string, length = 140) {
  const first = findAllSearchMatches(text, query)[0]
  if (!first || first.from < length - 40) return text.slice(0, length)
  const start = Math.max(0, first.from - 40)
  return `…${text.slice(start, start + length)}`
}

/**
 * Keep the order the user is looking at while the list identity (page, query, filters) is unchanged.
 * Items already shown keep their positions; newly appearing items go first in their natural order.
 */
export function stableOrder<T extends { id: string }>(previous: readonly string[], items: readonly T[]): T[] {
  const rank = new Map(previous.map((id, index) => [id, index]))
  const fresh = items.filter(item => !rank.has(item.id))
  const known = items.filter(item => rank.has(item.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  return [...fresh, ...known]
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
