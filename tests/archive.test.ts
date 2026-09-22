import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Library } from '../src/main/library'
import { parseBookmarkPage, parseTweetResult, memoryMarkdown, allowedImage, imageCandidates, extractArticleText, extractArticleImages, isArticleLink, XArchive } from '../src/main/x-source'
import { bookmarksChunkFromHtml, chunkUrls, extractOperations, isLoggedOutLanding, scriptUrlsFromHtml } from '../src/main/x-client'
import type { CookieRecord } from '../src/main/cookies'

const temporary = path.resolve(process.cwd(), '../../trash/xmemeory-dev/tests')
mkdirSync(temporary, { recursive: true })
const libraries: Library[] = []
const library = () => { const item = new Library(mkdtempSync(path.join(temporary, 'archive-'))); libraries.push(item); return item }
afterEach(async () => { for (const item of libraries.splice(0)) await item.close() })

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const cookies: CookieRecord[] = [
  { name: 'auth_token', value: 'synthetic-auth', domain: '.x.com', path: '/', secure: true },
  { name: 'ct0', value: 'synthetic-csrf', domain: '.x.com', path: '/', secure: true }
]
function tweet(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    content: {
      itemContent: {
        tweet_results: {
          result: {
            rest_id: id,
            legacy: {
              full_text: text,
              truncated: extra.truncated,
              favorite_count: 99,
              reply_count: 12,
              extended_entities: extra.media,
              entities: { urls: extra.urls || [], media: extra.media }
            },
            core: { user_results: { result: { legacy: { screen_name: extra.author || 'alice' } } } },
            note_tweet: extra.note,
            article: extra.article,
            card: extra.card
          }
        }
      }
    }
  }
}
function page(entries: unknown[], cursor?: string, terminated = false) {
  const instructions: unknown[] = [{ type: 'TimelineAddEntries', entries }]
  if (cursor) instructions.push({ type: 'TimelineAddEntries', entries: [{ content: { cursorType: 'Bottom', value: cursor } }] })
  if (terminated) instructions.push({ type: 'TimelineTerminateTimeline' })
  return { data: { bookmark_timeline_v2: { timeline: { instructions } } } }
}
function jsonResponse(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(data), json: async () => data, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response
}
function textResponse(body: string): Response {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => body, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response
}
const landingHtml = '<script type="module" src="https://abs.twimg.com/x-web/x-web/entry-client-logged-out-DlmjxI8L.js"></script>'
const bookmarksHtml = '<script>window.__SCRIPTS_LOADED__={};34778:"shared~bundle.BookmarkFolders~bundle.Bookmarks";69742:"bundle.Bookmarks";34778:"42881d01aa4e5708";69742:"b7ff499a771b960f";</script><script src="https://abs.twimg.com/responsive-web/client-web/main.abc.js"></script>'
function clientFetch(extra: (url: string) => Response | undefined = () => undefined): typeof fetch {
  return async input => {
    const url = String(input)
    if (url === 'https://x.com') return textResponse(landingHtml)
    if (url.includes('/i/bookmarks') || url.includes('/home')) return textResponse(bookmarksHtml)
    if (url.includes('BookmarkFolders~bundle.Bookmarks') || url.includes('bundle.Bookmarks.')) return textResponse('queryId:"LiveBookmarksId",operationName:"Bookmarks"')
    if (url.includes('main.abc.js')) return textResponse('queryId:"BookmarkQueryId",operationName:"Bookmarks" queryId:"TweetDetailId",operationName:"TweetResultByRestId" AAAAABBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')
    const extraResponse = extra(url)
    if (extraResponse) return extraResponse
    throw new Error(`unexpected ${url}`)
  }
}

it('从书签页 webpack 分包识别 Bookmarks，而不是未登录落地页', () => {
  expect(isLoggedOutLanding(landingHtml)).toBe(true)
  expect(isLoggedOutLanding(bookmarksHtml)).toBe(false)
  expect(scriptUrlsFromHtml(bookmarksHtml)[0]).toContain('main.abc.js')
  const chunk = bookmarksChunkFromHtml(bookmarksHtml)!
  expect(chunk.name).toBe('shared~bundle.BookmarkFolders~bundle.Bookmarks')
  expect(chunkUrls(chunk)[0]).toContain('42881d01aa4e5708a.js')
  expect(extractOperations('queryId:"tF6KOjmZM0WGcB2Q0mfwhw",operationName:"Bookmarks"').Bookmarks).toBe('tF6KOjmZM0WGcB2Q0mfwhw')
})

function imageResponse(bytes = png, status = 200, location?: string): Response {
  return { ok: status >= 200 && status < 300, status, headers: { get: (name: string) => name.toLowerCase() === 'location' ? location || null : name === 'content-length' ? String(bytes.length) : null }, text: async () => '', json: async () => ({}), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } as unknown as Response
}

const articleResult = {
  rest_id: '2099446491094175744',
  legacy: { full_text: 'https://t.co/qcc6BLVXUv', truncated: false, entities: { urls: [{ expanded_url: 'https://x.com/i/article/2099421537489100800' }] } },
  core: { user_results: { result: { legacy: { screen_name: 'xueyu1125' } } } },
  article: { article_results: { result: {
    title: '新规把回复曝光作废后，我从 8 万做到 50 万 Timeline 曝光，中间做了什么？',
    preview_text: '我来X最初的目标就是希望等我被裁之前能有个稳定的副业。',
    cover_media: { media_info: { original_img_url: 'https://pbs.twimg.com/media/HSKk1VaasAA8HOf.jpg' } },
    media_entities: [{ media_info: { original_img_url: 'https://pbs.twimg.com/media/HSKkxgybwAAWhTO.png' } }],
    content: { blocks: [
      { text: '我来X最初的目标就是希望等我被裁之前能有个稳定的副业。但是看到 8月7号看到 X 的新规，我感觉天塌了。', type: 'unstyled' },
      { text: '没想到，8月到9月一个月左右，我又成功完成了 50 万 timeline 浏览量这道门槛。', type: 'unstyled' }
    ] }
  } } }
}

it('X Article 从 content.blocks 取长文，并从 cover_media 取封面', () => {
  expect(isArticleLink('https://x.com/i/article/2099421537489100800')).toBe(true)
  const post = parseTweetResult(articleResult)!
  expect(post.partial).toBe(false)
  expect(post.text).toContain('新规把回复曝光作废后')
  expect(post.text).toContain('50 万 timeline')
  expect(post.images).toContain('https://pbs.twimg.com/media/HSKk1VaasAA8HOf.jpg')
  expect(post.images).toContain('https://pbs.twimg.com/media/HSKkxgybwAAWhTO.png')
  expect(extractArticleText(articleResult.article.article_results.result).length).toBeGreaterThan(80)
  expect(extractArticleImages(articleResult.article.article_results.result)[0]).toContain('HSKk1VaasAA8HOf.jpg')
})

it('书签时间线只有 t.co 时会补取 TweetResultByRestId 长文和封面', async () => {
  const lib = library()
  const slim = { ...articleResult, article: { article_results: { result: { title: '新规把回复曝光作废后，我从 8 万做到 50 万 Timeline 曝光，中间做了什么？', preview_text: '预览', cover_media: {} } } } }
  const request = clientFetch(url => {
    if (url.includes('verify_credentials')) return jsonResponse({ id_str: '1', screen_name: 'xueyu1125' })
    if (url.includes('/Bookmarks')) return jsonResponse(page([{ content: { itemContent: { tweet_results: { result: slim } } } }], undefined, true))
    if (url.includes('TweetResultByRestId')) return jsonResponse({ data: { tweetResult: { result: articleResult } } })
    if (url.includes('HSKk1VaasAA8HOf.jpg') || url.includes('HSKkxgybwAAWhTO.png')) return imageResponse()
  })
  const archive = new XArchive(lib, () => cookies, () => {}, request, { fast: true })
  await archive.scan()
  const note = lib.get('x-1-2099446491094175744')
  expect(note.body).toContain('50 万 timeline')
  expect(note.body).toContain('assets/')
  expect(note.partial).not.toBe(true)
  expect(archive.progress.imagesFailed).toBe(0)
})

it('短推不是 X Article，不误标为长文缺失', () => {
  const post = parseTweetResult({
    rest_id: '2097877140268356021',
    legacy: { full_text: '很想知道大家都是怎么把英文听力练好的， 我现在的目标不就是无障碍的听懂英文科技播客。', truncated: false, entities: { urls: [] } },
    core: { user_results: { result: { legacy: { screen_name: 'PandaTalk8' } } } }
  })!
  expect(post.partial).toBe(false)
  expect(post.text).toContain('英文听力')
  expect(post.images).toEqual([])
  expect(new XArchive(library(), () => cookies, () => {}, async () => textResponse(''), { fast: true }).needsEnrich(post)).toBe(false)
})

it('解析长正文、封面、外链，忽略视频流和互动计数', () => {
  const parsed = parseBookmarkPage(page([
    tweet('11', '短正文 https://t.co/x', {
      urls: [{ expanded_url: 'https://example.com/read' }],
      media: [{ type: 'video', media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/11/pu/img/cover.jpg', video_info: { variants: [{ url: 'https://video.twimg.com/ext_tw_video/11/pu/vid/720x720/secret.mp4' }] } }]
    }),
    tweet('12', '被截断', { truncated: true, note: { note_tweet_results: { result: { text: '完整长推正文，超过普通限制。' } } } }),
    tweet('13', '卡片', { card: { legacy: { binding_values: [{ key: 'photo_image_full_size_original', value: { image_value: { url: 'https://pbs.twimg.com/card_img/cover.png' } } }] } } })
  ], 'cursor-2'))
  expect(parsed.posts).toHaveLength(3)
  expect(parsed.posts[0].images).toEqual(['https://pbs.twimg.com/ext_tw_video_thumb/11/pu/img/cover.jpg'])
  expect(parsed.posts[0].videoCover).toBe(true)
  expect(parsed.posts[0].links).toEqual(['https://example.com/read'])
  expect(parsed.posts[1].text).toBe('完整长推正文，超过普通限制。')
  expect(parsed.posts[1].partial).toBe(false)
  const markdown = memoryMarkdown(parsed.posts[0])
  expect(markdown.body).toContain('短正文')
  expect(markdown.body).toContain('https://example.com/read')
  expect(markdown.body).toContain('视频未下载')
  expect(markdown.body).not.toContain('.mp4')
  expect(markdown.body).not.toContain('99')
  expect(markdown.body).not.toContain('favorite')
  expect(allowedImage('https://video.twimg.com/ext_tw_video/11/pu/vid/720x720/secret.mp4')).toBe(false)
})

it('截断且无长正文时标记不完整，未知空页不当作结束', () => {
  const truncated = parseBookmarkPage(page([tweet('21', '半句…', { truncated: true })]))
  expect(truncated.posts[0].partial).toBe(true)
  expect(() => parseBookmarkPage({ data: { bookmark_timeline_v2: { timeline: { instructions: [] } } } })).toThrow('未知空页')
  expect(parseBookmarkPage(page([], undefined, true)).terminated).toBe(true)
})

it('扫描分页、中断后从游标恢复，且不覆盖用户修改', async () => {
  const lib = library()
  const pages: Record<string, unknown> = {
    '': page([tweet('1', '第一页甲'), tweet('2', '第一页乙')], 'c1'),
    c1: page([tweet('3', '第二页丙'), tweet('4', '第二页丁')], 'c2'),
    c2: page([], undefined, true)
  }
  let bookmarkCalls = 0
  const request = clientFetch(url => {
    if (url.includes('verify_credentials')) return jsonResponse({ id_str: '1', screen_name: 'tester' })
    if (url.includes('/Bookmarks')) {
      bookmarkCalls++
      const variables = JSON.parse(new URL(url).searchParams.get('variables') || '{}')
      return jsonResponse(pages[variables.cursor || ''])
    }
  })
  const archive = new XArchive(lib, () => cookies, () => { if (lib.notes.size >= 3) archive.pause() }, request, { fast: true })
  await archive.scan()
  expect([...lib.notes.keys()].sort()).toEqual(['x-1-1', 'x-1-2', 'x-1-3'])
  expect(JSON.parse(readFileSync(path.join(lib.root, 'local/x-1.json'), 'utf8')).cursor).toBe('c1')
  const file = path.join(lib.root, lib.get('x-1-1').path)
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll('第一页甲', '我改过的正文'))
  lib.refresh()
  expect(lib.get('x-1-1').userEdited).toBe(true)
  const resumed = new XArchive(lib, () => cookies, () => {}, request, { fast: true })
  await resumed.scan()
  expect([...lib.notes.keys()].sort()).toEqual(['x-1-1', 'x-1-2', 'x-1-3', 'x-1-4'])
  expect(lib.get('x-1-1').body).toContain('我改过的正文')
  expect(lib.get('x-1-1').userEdited).toBe(true)
  expect(lib.get('x-1-4').body).toContain('第二页丁')
  expect(lib.get('x-1-1').path).toBe('memories/1/1.md')
  expect(readFileSync(file, 'utf8')).toContain('author: alice')
  expect(bookmarkCalls).toBeGreaterThan(2)
})

it('pbs 图片地址会补 name=large，并跟随 302', () => {
  const urls = imageCandidates('https://pbs.twimg.com/media/ABC.jpg:large')
  expect(urls.some(url => url.includes('name=large') && !url.includes(':large'))).toBe(true)
  expect(imageCandidates('https://pbs.twimg.com/media/ABC?format=jpg&name=small').some(url => url.includes('name=large'))).toBe(true)
  expect(allowedImage('https://pbs.twimg.com/media/ABC.jpg?format=jpg&name=large')).toBe(true)
})

it('图片 302 后跟随并保存，不记入失败', async () => {
  const lib = library()
  const request = clientFetch(url => {
    if (url.includes('verify_credentials')) return jsonResponse({ id_str: '8', screen_name: 'hop' })
    if (url.includes('/Bookmarks')) return jsonResponse(page([tweet('9', '跳转图', { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/REDIR.jpg' }] })], undefined, true))
    if (url === 'https://pbs.twimg.com/media/REDIR.jpg') return imageResponse(png, 302, 'https://pbs.twimg.com/media/REDIR.jpg?format=jpg&name=large')
    if (url.includes('REDIR.jpg')) return imageResponse()
  })
  const archive = new XArchive(lib, () => cookies, () => {}, request, { fast: true })
  await archive.scan()
  expect(lib.get('x-8-9').body).toContain('assets/')
  expect(archive.progress.imagesFailed).toBe(0)
})

it('图片失败保留正文并进入补抓队列，视频地址不会下载', async () => {
  const lib = library()
  let fail = true
  const request = clientFetch(url => {
    if (url.includes('verify_credentials')) return jsonResponse({ id_str: '9', screen_name: 'pix' })
    if (url.includes('/Bookmarks')) return jsonResponse(page([
      tweet('5', '有图', { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/FAIL.png' }] }),
      tweet('6', '视频', { media: [{ type: 'video', media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/6/pu/img/cover.jpg', video_info: { variants: [{ url: 'https://video.twimg.com/x.mp4' }] } }] })
    ], undefined, true))
    if (url.includes('FAIL.png')) return fail ? imageResponse(png, 404) : imageResponse()
    if (url.includes('cover.jpg')) return imageResponse()
    if (url.includes('video.twimg.com')) throw new Error('should not download video')
  })
  const archive = new XArchive(lib, () => cookies, () => {}, request, { fast: true })
  await archive.scan()
  expect(lib.get('x-9-5').body).toContain('有图')
  expect(lib.get('x-9-5').body).not.toContain('assets/')
  expect(archive.progress.imagesFailed).toBe(1)
  expect(lib.get('x-9-6').body).toContain('视频未下载')
  expect(lib.get('x-9-6').body).toContain('assets/')
  expect(lib.get('x-9-6').body).toContain('../../assets/')
  fail = false
  await archive.retryFailed()
  expect(lib.get('x-9-5').body).toContain('../../assets/')
  expect(archive.progress.imagesFailed).toBe(0)
})

it('完成后再次扫描能发现新增的旧推文，不因已有记录提前结束', async () => {
  const lib = library()
  let extra = false
  const request = clientFetch(url => {
    if (url.includes('verify_credentials')) return jsonResponse({ id_str: '3', screen_name: 'old' })
    if (url.includes('/Bookmarks')) {
      const variables = JSON.parse(new URL(url).searchParams.get('variables') || '{}')
      if (!variables.cursor) return jsonResponse(page([...(extra ? [tweet('99', '很早发布的新收藏')] : []), tweet('7', '已有')], 'd1'))
      return jsonResponse(page([tweet('8', '更早')], undefined, true))
    }
  })
  const archive = new XArchive(lib, () => cookies, () => {}, request, { fast: true })
  await archive.scan()
  expect(lib.notes.has('x-3-7')).toBe(true)
  extra = true
  await archive.scan()
  expect(lib.get('x-3-99').body).toContain('很早发布的新收藏')
  expect(lib.notes.has('x-3-8')).toBe(true)
})
