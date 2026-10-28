export function searchTerms(query: string) {
  return [...new Set([...query.matchAll(/"([^"]+)"|(\S+)/g)].map(m => (m[1] || m[2]).normalize('NFKC').toLocaleLowerCase()).filter(Boolean))]
}

function normalizedIndex(text: string) {
  let normalized = '', offset = 0
  const starts: number[] = [], ends: number[] = []
  for (const char of text) {
    const value = char.normalize('NFKC').toLocaleLowerCase()
    for (let i = 0; i < value.length; i++) { starts.push(offset); ends.push(offset + char.length) }
    normalized += value; offset += char.length
  }
  return { normalized, starts, ends }
}

export function findSearchMatch(text: string, query: string): { from: number; to: number } | undefined {
  return findAllSearchMatches(text, query)[0]
}

/** Every occurrence of every query term, sorted and with overlaps merged; offsets refer to the original text. */
export function findAllSearchMatches(text: string, query: string): { from: number; to: number }[] {
  const terms = searchTerms(query)
  if (!terms.length || !text) return []
  const { normalized, starts, ends } = normalizedIndex(text)
  const found: { from: number; to: number }[] = []
  for (const term of terms) {
    for (let at = normalized.indexOf(term); at >= 0; at = normalized.indexOf(term, at + term.length)) found.push({ from: starts[at], to: ends[at + term.length - 1] })
  }
  found.sort((a, b) => a.from - b.from || b.to - a.to)
  const merged: { from: number; to: number }[] = []
  for (const range of found) {
    const last = merged[merged.length - 1]
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to)
    else merged.push({ ...range })
  }
  return merged
}
