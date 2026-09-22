export function findSearchMatch(text: string, query: string): { from: number; to: number } | undefined {
  const terms = [...query.matchAll(/"([^"]+)"|(\S+)/g)].map(m => (m[1] || m[2]).normalize('NFKC').toLocaleLowerCase())
  let normalized = '', offset = 0
  const starts: number[] = [], ends: number[] = []
  for (const char of text) {
    const value = char.normalize('NFKC').toLocaleLowerCase()
    for (let i = 0; i < value.length; i++) { starts.push(offset); ends.push(offset + char.length) }
    normalized += value; offset += char.length
  }
  let result: { from: number; to: number } | undefined
  for (const term of terms) {
    const at = term ? normalized.indexOf(term) : -1
    if (at >= 0 && (!result || starts[at] < result.from)) result = { from: starts[at], to: ends[at + term.length - 1] }
  }
  return result
}
