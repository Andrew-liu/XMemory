export const X_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
export const X_PUBLIC_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
const BUNDLE_BASE = 'https://abs.twimg.com/responsive-web/client-web/'

export function browserHeaders(extra: Record<string, string> = {}) {
  return { 'user-agent': X_USER_AGENT, accept: '*/*', referer: 'https://x.com/i/bookmarks', ...extra }
}
export function imageHeaders() {
  return { 'user-agent': X_USER_AGENT, accept: 'image/jpeg,image/png,image/webp,image/gif,*/*;q=0.1', referer: 'https://x.com/' }
}

export function isLoggedOutLanding(html: string) {
  return /entry-client-logged-out|x-web\/x-web\//.test(html) && !/client-web(?:-legacy)?\/main\./.test(html)
}

export function scriptUrlsFromHtml(html: string) {
  const text = html.replace(/\\\//g, '/')
  const urls = [...text.matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web(?:-legacy)?\/[^"'<\s]+\.js/g)].map(m => m[0])
  return [...new Set(urls)]
}

export function extractOperations(js: string) {
  const ids: Record<string, string> = {}
  for (const match of js.matchAll(/queryId:"([\w-]+)",operationName:"([^"]+)"/g)) ids[match[2]] = match[1]
  for (const match of js.matchAll(/operationName:"([^"]+)",queryId:"([\w-]+)"/g)) ids[match[1]] ??= match[2]
  return ids
}

export function extractBearer(js: string) {
  return js.match(/AAAAA[A-Za-z0-9%]{50,}/)?.[0] || X_PUBLIC_BEARER
}

export function bookmarksChunkFromHtml(html: string) {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1])
  const runtime = scripts.find(s => s.includes('bundle.Bookmarks') && (s.includes('__SCRIPTS_LOADED__') || /\.u\s*=/.test(s))) || scripts.find(s => s.includes('bundle.Bookmarks'))
  if (!runtime) return
  const named = runtime.match(/(\d+):"(shared~bundle\.BookmarkFolders~bundle\.Bookmarks)"/) || runtime.match(/(\d+):"(bundle\.Bookmarks)"/)
  if (!named) return
  const hashes = [...runtime.matchAll(new RegExp(`${named[1]}:"([a-f0-9]{8,})"`, 'g'))].map(m => m[1])
  const hash = hashes.at(-1)
  if (!hash) return
  return { name: named[2], hash }
}

export function chunkUrls(chunk: { name: string; hash: string }) {
  return ['a', '', 'b'].map(suffix => `${BUNDLE_BASE}${chunk.name}.${chunk.hash}${suffix}.js`)
}
