/** Images in the library load through this scheme so bytes stream directly instead of crossing IPC as base64. */
export const ASSET_SCHEME = 'xm-asset'

/** URL for a library image referenced as `relative` from the note at `from` (both library-relative, `/`-separated). */
export function assetURL(relative: string, from = '') {
  return `${ASSET_SCHEME}://library/?p=${encodeURIComponent(relative)}&from=${encodeURIComponent(from)}`
}

/** Parse an asset URL back to its reference; undefined for anything that is not a well-formed asset URL. */
export function parseAssetURL(url: string): { relative: string; from: string } | undefined {
  let parsed: URL
  try { parsed = new URL(url) } catch { return undefined }
  if (parsed.protocol !== `${ASSET_SCHEME}:` || parsed.hostname !== 'library') return undefined
  const relative = parsed.searchParams.get('p')
  if (!relative) return undefined
  return { relative, from: parsed.searchParams.get('from') || '' }
}

/** Link written into a note for a library attachment, relative to the note's folder (trashed notes count from their original place). */
export function imageReference(attachment: string, notePath: string) {
  const logical = notePath.startsWith('.xmemeory/trash/') ? notePath.slice('.xmemeory/trash/'.length) : notePath
  return '../'.repeat(Math.max(0, logical.split('/').length - 1)) + attachment
}
