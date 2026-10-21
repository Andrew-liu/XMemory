import { expect, it } from 'vitest'
import { articleFromContentState, bookmarkEntries, captureFromPayload, dedupeImages, imageCandidates, memoryTitle, normalizePostUrl, parseTweetResult, type ArchivedPost } from '../src/main/x-parse'

it('规范各种合法推文与长文链接', () => {
  const target = { url: 'https://x.com/alice/status/1234567890123456789', id: '1234567890123456789', user: 'alice' }
  expect(normalizePostUrl('https://x.com/alice/status/1234567890123456789')).toEqual(target)
  expect(normalizePostUrl('https://www.x.com/alice/status/1234567890123456789')).toEqual(target)
  expect(normalizePostUrl('https://twitter.com/alice/status/1234567890123456789')).toEqual(target)
  expect(normalizePostUrl('https://www.twitter.com/alice/status/1234567890123456789')).toEqual(target)
  expect(normalizePostUrl('https://mobile.twitter.com/alice/status/1234567890123456789')).toEqual(target)
  expect(normalizePostUrl('https://mobile.x.com/alice/status/1234567890123456789')).toEqual(target)
  expect(normalizePostUrl('  https://x.com/alice/status/1234567890123456789?s=20&t=abc#frag  ')).toEqual(target)
  expect(normalizePostUrl('https://x.com/alice/status/1234567890123456789/')).toEqual(target)
  expect(normalizePostUrl('https://x.com/alice/article/456')).toEqual({ url: 'https://x.com/alice/status/456', id: '456', user: 'alice' })
  expect(normalizePostUrl('https://x.com/i/web/status/789')).toEqual({ url: 'https://x.com/i/web/status/789', id: '789', user: undefined })
})

it('拒绝非推文链接，不发出任何请求', () => {
  for (const input of [
    '',
    '   ',
    'not a url',
    'http://x.com/alice/status/123',
    'https://example.com/alice/status/123',
    'https://x.com/i/article/123',
    'https://x.com/i/status/123',
    'https://x.com/alice/status/abc',
    'https://x.com/alice/status/123/extra',
    'https://x.com/alice/status/123/photo/1',
    'https://x.com/alice/status/123/analytics',
    'https://user:pw@x.com/alice/status/123',
    'https://x.com:8443/alice/status/123',
    `https://x.com/alice/status/${'1'.repeat(26)}`,
    'https://x.com/toolongusername12/status/123',
    'https://x.com/alice',
    'https://x.com/'
  ]) expect(normalizePostUrl(input), input).toBeUndefined()
})

const block = (key: string, type: string, text: string, extra: Record<string, unknown> = {}) => ({ key, type, text, data: {}, inlineStyleRanges: [], entityRanges: [], ...extra })
const mediaEntity = (id: string, url: string) => ({ media_id: id, media_key: `key_${id}`, media_info: { __typename: 'ApiImage', original_img_url: url, original_img_width: 800, original_img_height: 600 } })

it('content_state 解析标题、封面、块类型，entityMap 按键名而非下标匹配', () => {
  const article = {
    title: '  长文标题  ',
    preview_text: '预览',
    cover_media: { media_id: 'cover', media_info: { original_img_url: 'https://pbs.twimg.com/media/COVER.jpg' } },
    content_state: {
      entityMap: [
        { key: '12', value: { type: 'MEDIA', mutability: 'IMMUTABLE', data: { mediaItems: [{ mediaId: '211' }] } } },
        { key: '0', value: { type: 'DIVIDER', mutability: 'IMMUTABLE', data: {} } },
        { key: '7', value: { type: 'MARKDOWN', mutability: 'IMMUTABLE', data: { markdown: '```ts\nconst a = 1\n```' } } }
      ],
      blocks: [
        block('h1', 'header-one', '一级标题'),
        block('h2', 'header-two', '二级标题'),
        block('h3', 'header-three', '三级标题'),
        block('p1', 'unstyled', '正文段落'),
        block('a1', 'atomic', ' ', { entityRanges: [{ key: 12, offset: 0, length: 1 }] }),
        block('a2', 'atomic', ' ', { entityRanges: [{ key: 0, offset: 0, length: 1 }] }),
        block('a3', 'atomic', ' ', { entityRanges: [{ key: 7, offset: 0, length: 1 }] })
      ]
    },
    media_entities: [mediaEntity('211', 'https://pbs.twimg.com/media/BODY.jpg')]
  }
  const result = articleFromContentState(article)!
  expect(result.title).toBe('长文标题')
  expect(result.coverUrl).toBe('https://pbs.twimg.com/media/COVER.jpg')
  expect(result.markdown).toContain('# 长文标题')
  expect(result.markdown).toContain('![X 封面](https://pbs.twimg.com/media/COVER.jpg)')
  expect(result.markdown).toContain('## 一级标题')
  expect(result.markdown).toContain('## 二级标题')
  expect(result.markdown).toContain('### 三级标题')
  expect(result.markdown).toContain('正文段落')
  expect(result.markdown).toContain('![X 图片](https://pbs.twimg.com/media/BODY.jpg)')
  expect(result.markdown).toContain('\n\n---\n\n')
  expect(result.markdown).toContain('```ts\nconst a = 1\n```')
  expect(result.images).toEqual(['https://pbs.twimg.com/media/COVER.jpg', 'https://pbs.twimg.com/media/BODY.jpg'])
  expect(result.partialReasons).toEqual([])
  expect(result.blockCount).toBe(7)
})

it('行内粗体、斜体、链接与 emoji 的 UTF-16 偏移正确', () => {
  const article = {
    title: '行内',
    content_state: {
      entityMap: [{ key: '5', value: { type: 'LINK', mutability: 'MUTABLE', data: { url: 'https://help.x.com/example' } } }],
      blocks: [
        block('b1', 'unstyled', '前缀 加粗 后缀', { inlineStyleRanges: [{ offset: 3, length: 2, style: 'Bold' }] }),
        block('b2', 'unstyled', 'aabbcc', { inlineStyleRanges: [{ offset: 0, length: 4, style: 'Bold' }, { offset: 2, length: 4, style: 'Italic' }] }),
        block('b3', 'unstyled', '加粗 收尾', { inlineStyleRanges: [{ offset: 0, length: 3, style: 'Bold' }] }),
        block('b4', 'unstyled', '😀 加粗尾', { inlineStyleRanges: [{ offset: 3, length: 2, style: 'Bold' }] }),
        block('b5', 'unstyled', '请看 文档 结尾', { entityRanges: [{ key: 5, offset: 3, length: 2 }] })
      ]
    }
  }
  const markdown = articleFromContentState(article)!.markdown
  expect(markdown).toContain('前缀 **加粗** 后缀')
  expect(markdown).toContain('**aa*bb**cc*')
  expect(markdown).toContain('**加粗** 收尾')
  expect(markdown).not.toContain('**加粗 **')
  expect(markdown).toContain('😀 **加粗**尾')
  expect(markdown).toContain('请看 [文档](https://help.x.com/example) 结尾')
})

it('有序列表连续编号、遇其他块重新计数，无序列表紧凑连接', () => {
  const article = {
    title: '列表',
    content_state: {
      entityMap: [],
      blocks: [
        block('o1', 'ordered-list-item', '第一'),
        block('o2', 'ordered-list-item', '第二'),
        block('o3', 'ordered-list-item', '第三'),
        block('p', 'unstyled', '普通段落'),
        block('o4', 'ordered-list-item', '重新一'),
        block('u1', 'unordered-list-item', '甲'),
        block('u2', 'unordered-list-item', '乙'),
        block('q', 'blockquote', '引用\n第二行'),
        block('c', 'code-block', 'const x = 1')
      ]
    }
  }
  const markdown = articleFromContentState(article)!.markdown
  expect(markdown).toContain('1. 第一\n2. 第二\n3. 第三')
  expect(markdown).toContain('3. 第三\n\n普通段落')
  expect(markdown).toContain('普通段落\n\n1. 重新一')
  expect(markdown).toContain('1. 重新一\n\n- 甲\n- 乙')
  expect(markdown).toContain('> 引用\n> 第二行')
  expect(markdown).toContain('```\nconst x = 1\n```')
})

it('无法映射的媒体与未知块记入 partialReasons', () => {
  const article = {
    title: '缺失',
    content_state: {
      entityMap: [
        { key: '1', value: { type: 'MEDIA', mutability: 'IMMUTABLE', data: { mediaItems: [{ mediaId: 'missing' }] } } },
        { key: '2', value: { type: 'TWEET', mutability: 'IMMUTABLE', data: { tweetId: '333' } } },
        { key: '3', value: { type: 'EMBED', mutability: 'IMMUTABLE', data: {} } }
      ],
      blocks: [
        block('p', 'unstyled', '正文'),
        block('m', 'atomic', ' ', { entityRanges: [{ key: 1, offset: 0, length: 1 }] }),
        block('t', 'atomic', ' ', { entityRanges: [{ key: 2, offset: 0, length: 1 }] }),
        block('e', 'atomic', ' ', { entityRanges: [{ key: 3, offset: 0, length: 1 }] }),
        block('u', 'table-cell', '表格单元')
      ]
    }
  }
  const result = articleFromContentState(article)!
  expect(result.markdown).toContain('<https://x.com/i/web/status/333>')
  expect(result.markdown).toContain('表格单元')
  expect(result.markdown).not.toContain('missing')
  expect(result.partialReasons).toContain('media-unresolved')
  expect(result.partialReasons).toContain('unknown-entity:EMBED')
  expect(result.partialReasons).toContain('unknown-block:table-cell')
})

it('缺少 content_state 或没有有效正文块时回退 DOM', () => {
  expect(articleFromContentState(undefined)).toBeUndefined()
  expect(articleFromContentState({ title: '只有标题' })).toBeUndefined()
  expect(articleFromContentState({ title: '空', content_state: { entityMap: [], blocks: [block('a', 'atomic', ' ', {}), block('b', 'unstyled', '   ')] } })).toBeUndefined()
})

it('对象形态的 entityMap 也能解析', () => {
  const article = {
    title: '旧版结构',
    content_state: {
      entityMap: { '0': { type: 'MEDIA', mutability: 'IMMUTABLE', data: { mediaItems: [{ mediaId: '9' }] } } },
      blocks: [
        block('p', 'unstyled', '正文'),
        block('m', 'atomic', ' ', { entityRanges: [{ key: 0, offset: 0, length: 1 }] })
      ]
    },
    media_entities: [mediaEntity('9', 'https://pbs.twimg.com/media/OBJ.jpg')]
  }
  const result = articleFromContentState(article)!
  expect(result.markdown).toContain('![X 图片](https://pbs.twimg.com/media/OBJ.jpg)')
  expect(result.partialReasons).toEqual([])
})

it('短推展开 t.co、删除媒体链接并还原 HTML 实体', () => {
  const post = parseTweetResult({
    rest_id: '100',
    legacy: {
      full_text: '看看 &amp;lt;代码&amp;gt; https://t.co/link https://t.co/pic',
      truncated: false,
      entities: { urls: [{ url: 'https://t.co/link', expanded_url: 'https://example.com/article?a=1&b=2' }], media: [{ type: 'photo', url: 'https://t.co/pic', media_url_https: 'https://pbs.twimg.com/media/P.jpg' }] }
    },
    core: { user_results: { result: { legacy: { screen_name: 'someuser' } } } }
  })!
  expect(post.text).toBe('看看 &lt;代码&gt; https://example.com/article?a=1&b=2')
  expect(post.images).toEqual(['https://pbs.twimg.com/media/P.jpg'])
  expect(post.links).toEqual(['https://example.com/article?a=1&b=2'])
  expect(post.author).toBe('someuser')
  expect(post.partial).toBe(false)
})

it('Note Tweet 优先并使用其链接实体', () => {
  const post = parseTweetResult({
    rest_id: '100',
    legacy: { full_text: '截断的摘要 https://t.co/short', truncated: true, entities: { urls: [] } },
    note_tweet: { note_tweet_results: { result: { text: '完整长文本 https://t.co/full', entity_set: { urls: [{ url: 'https://t.co/full', expanded_url: 'https://example.com/full' }] } } } },
    core: { user_results: { result: { legacy: { screen_name: 'someuser' } } } }
  })!
  expect(post.text).toBe('完整长文本 https://example.com/full')
  expect(post.links).toEqual(['https://example.com/full'])
  expect(post.partial).toBe(false)
})

it('作者缺失时使用链接中的用户名兜底', () => {
  const input = { rest_id: '5', legacy: { full_text: '正文', entities: { urls: [] } } }
  expect(parseTweetResult(input, 'linkuser')!.author).toBe('linkuser')
  expect(parseTweetResult(input)!.author).toBe('unknown')
  expect(parseTweetResult({ ...input, core: { user_results: { result: { legacy: { screen_name: 'realuser' } } } } }, 'linkuser')!.author).toBe('realuser')
})

it('图片候选尺寸按 orig、large、medium 降级，最后保留原链接', () => {
  expect(imageCandidates('https://pbs.twimg.com/media/X.jpg')).toEqual([
    'https://pbs.twimg.com/media/X.jpg?format=jpg&name=orig',
    'https://pbs.twimg.com/media/X.jpg?format=jpg&name=large',
    'https://pbs.twimg.com/media/X.jpg?format=jpg&name=medium',
    'https://pbs.twimg.com/media/X.jpg'
  ])
  expect(imageCandidates('https://pbs.twimg.com/media/X?format=jpg&name=small')).toEqual([
    'https://pbs.twimg.com/media/X?format=jpg&name=orig',
    'https://pbs.twimg.com/media/X?format=jpg&name=large',
    'https://pbs.twimg.com/media/X?format=jpg&name=medium',
    'https://pbs.twimg.com/media/X?format=jpg&name=small'
  ])
  expect(imageCandidates('https://example.com/a.jpg')).toEqual(['https://example.com/a.jpg'])
})

it('同一图片的不同尺寸与格式只保留一张，优先 orig', () => {
  const base = 'https://pbs.twimg.com/card_img/2110402504814940166/A7g6S_Ma'
  expect(dedupeImages([
    `${base}?format=jpg&name=800x419`,
    `${base}?format=jpg&name=400x400`,
    `${base}?format=jpg&name=600x600`,
    `${base}?format=jpg&name=386x202`,
    `${base}?format=jpg&name=orig`,
    `${base}?format=jpg&name=144x144`,
    `${base}?format=png&name=2048x2048_2_exp`,
    `${base}?format=jpg&name=600x314`
  ])).toEqual([`${base}?format=jpg&name=orig`])
  expect(dedupeImages(['https://pbs.twimg.com/media/A.jpg', 'https://pbs.twimg.com/media/B.jpg'])).toEqual(['https://pbs.twimg.com/media/A.jpg', 'https://pbs.twimg.com/media/B.jpg'])
  expect(dedupeImages(['https://pbs.twimg.com/media/A.jpg', 'https://pbs.twimg.com/media/A?format=jpg&name=large'])).toEqual(['https://pbs.twimg.com/media/A.jpg'])
})

it('卡片图片多尺寸绑定值与媒体实体去重', () => {
  const post = parseTweetResult({
    rest_id: '100',
    legacy: {
      full_text: '正文 https://t.co/card https://t.co/pic',
      truncated: false,
      entities: {
        urls: [],
        media: [{ type: 'photo', url: 'https://t.co/pic', media_url_https: 'https://pbs.twimg.com/media/P.jpg' }]
      }
    },
    card: { legacy: { binding_values: [
      { key: 'photo_image_full_size_original', value: { image_value: { url: 'https://pbs.twimg.com/card_img/1/AB?format=jpg&name=800x419' } } },
      { key: 'photo_image_full_size_large', value: { image_value: { url: 'https://pbs.twimg.com/card_img/1/AB?format=jpg&name=orig' } } },
      { key: 'photo_image_full_size_small', value: { image_value: { url: 'https://pbs.twimg.com/card_img/1/AB?format=png&name=360x360' } } }
    ] } }
  })!
  expect(post.images).toEqual(['https://pbs.twimg.com/media/P.jpg', 'https://pbs.twimg.com/card_img/1/AB?format=jpg&name=orig'])
})

const post = (text: string): ArchivedPost => ({ id: '42', text, author: 'a', url: 'https://x.com/a/status/42', images: [], links: [], partial: false, videoCover: false })

it('记忆标题优先文章标题，普通推文取首行并去除标记', () => {
  expect(memoryTitle(post('正文'), '文章标题')).toBe('文章标题')
  expect(memoryTitle(post('## 标题行\n\n正文'))).toBe('标题行')
  expect(memoryTitle(post('> 引用内容\n\n第二段'))).toBe('引用内容')
  expect(memoryTitle(post('- 列表项'))).toBe('列表项')
  expect(memoryTitle(post('[链接文字](https://example.com/x) 后续'))).toBe('链接文字 后续')
  expect(memoryTitle(post('**加粗**开头'))).toBe('加粗开头')
  expect(memoryTitle(post('   \n\n  '))).toBe('X 内容 42')
  expect(memoryTitle(post('x'.repeat(100)))).toHaveLength(80)
})

const tweet = (core?: unknown) => ({ rest_id: '123', legacy: { full_text: '正文', truncated: false, entities: { urls: [] } }, ...(core === undefined ? {} : { core }) })

it('i/web 链接在已知作者时存规范化原文链接，未知作者保留 i/web', () => {
  const withAuthor = { user_results: { result: { legacy: { screen_name: 'realuser' } } } }
  const known = captureFromPayload(tweet(withAuthor), '123', undefined, 'https://x.com/i/web/status/123')!
  expect(known.post.url).toBe('https://x.com/realuser/status/123')
  expect(known.structured.source).toBe('https://x.com/realuser/status/123')
  const unknown = captureFromPayload(tweet(), '123', undefined, 'https://x.com/i/web/status/123')!
  expect(unknown.post.url).toBe('https://x.com/i/web/status/123')
  const normal = captureFromPayload(tweet(withAuthor), '123', undefined, 'https://x.com/PastedUser/status/123')!
  expect(normal.post.url).toBe('https://x.com/PastedUser/status/123')
})

it('结构化记录保留长文原始结构便于重渲染', () => {
  const article = {
    title: '结构',
    content_state: { entityMap: [], blocks: [block('b', 'unstyled', '正文')] },
    media_entities: [mediaEntity('9', 'https://pbs.twimg.com/media/M.jpg')],
    cover_media: { media_id: 'c', media_info: { original_img_url: 'https://pbs.twimg.com/media/C.jpg' } }
  }
  const captured = captureFromPayload({ ...tweet(), article: { article_results: { result: article } } }, '123')!
  const stored = captured.structured.article as { title: string; contentState: unknown; mediaEntities: unknown; coverMedia: unknown }
  expect(stored.title).toBe('结构')
  expect(stored.contentState).toEqual(article.content_state)
  expect(stored.mediaEntities).toEqual(article.media_entities)
  expect(stored.coverMedia).toEqual(article.cover_media)
})

const bookmarkTweetResult = (id: string, extra: Record<string, unknown> = {}) => ({ __typename: 'Tweet', rest_id: id, legacy: { full_text: `合成书签 ${id}`, truncated: false, entities: { urls: [] } }, core: { user_results: { result: { legacy: { screen_name: `user${id}` } } } }, ...extra })
const bookmarkEntry = (id: string, result: unknown = bookmarkTweetResult(id), itemExtra: Record<string, unknown> = {}) => ({ entryId: `tweet-${id}`, content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweet_results: { result }, ...itemExtra } } })
const bookmarkCursor = (kind: 'Top' | 'Bottom', value = `cursor-${kind}`) => ({ entryId: `cursor-${kind.toLowerCase()}-1`, content: { entryType: 'TimelineTimelineCursor', cursorType: kind, value } })
const bookmarksPayload = (entries: unknown[], root: Record<string, unknown> = {}) => ({ data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } }, ...root })

it('书签响应按顺序取出推文、底部游标，包装条目被解包', () => {
  const payload = bookmarksPayload([
    bookmarkCursor('Top'),
    bookmarkEntry('101'),
    bookmarkEntry('102', { __typename: 'TweetWithVisibilityResults', tweet: bookmarkTweetResult('102') }),
    bookmarkEntry('103', bookmarkTweetResult('103'), { promotedMetadata: { promoted: true } }),
    bookmarkCursor('Bottom', 'bottom-value')
  ])
  const parsed = bookmarkEntries(payload)
  expect(parsed.found).toBe(true)
  expect(parsed.tweets.map(t => String(t.rest_id))).toEqual(['101', '102'])
  expect(parsed.unavailable).toBe(0)
  expect(parsed.bottomCursor).toBe('bottom-value')
  expect(parsed.errors).toEqual([])
})

it('书签响应中的墓碑与不可用条目只计数不入队，错误被收集', () => {
  const payload = bookmarksPayload([
    bookmarkEntry('201'),
    bookmarkEntry('tomb', { __typename: 'TweetTombstone', tombstone: { text: { text: '不可用' } } }),
    bookmarkEntry('gone', { __typename: 'TweetUnavailable' }),
    bookmarkEntry('bad', { __typename: 'Tweet', rest_id: 'x', legacy: {} })
  ], { errors: [{ message: '合成接口错误', code: 88 }] })
  const parsed = bookmarkEntries(payload)
  expect(parsed.found).toBe(true)
  expect(parsed.tweets.map(t => String(t.rest_id))).toEqual(['201'])
  expect(parsed.unavailable).toBe(3)
  expect(parsed.errors).toEqual(['合成接口错误'])
})

it('缺少书签时间线时返回 found=false，仅有游标视为到底', () => {
  expect(bookmarkEntries({}).found).toBe(false)
  expect(bookmarkEntries({ data: { other: {} } }).found).toBe(false)
  const empty = bookmarkEntries(bookmarksPayload([bookmarkCursor('Top'), bookmarkCursor('Bottom', 'tail')]))
  expect(empty.found).toBe(true)
  expect(empty.tweets).toEqual([])
  expect(empty.unavailable).toBe(0)
  expect(empty.bottomCursor).toBe('tail')
  const captured = captureFromPayload(bookmarkEntries(bookmarksPayload([bookmarkEntry('301')])).tweets[0], '301')!
  expect(captured.post.id).toBe('301')
  expect(captured.post.partial).toBe(false)
})

it('长文视频与 GIF 媒体只保留封面并提示未下载，不标记不完整', () => {
  const article = {
    title: '含视频长文',
    content_state: {
      entityMap: [
        { key: '0', value: { type: 'MEDIA', mutability: 'IMMUTABLE', data: { mediaItems: [{ mediaId: 'v1' }] } } },
        { key: '1', value: { type: 'MEDIA', mutability: 'IMMUTABLE', data: { mediaItems: [{ mediaId: 'g1' }] } } }
      ],
      blocks: [
        block('p', 'unstyled', '正文段落'),
        block('v', 'atomic', ' ', { entityRanges: [{ key: 0, offset: 0, length: 1 }] }),
        block('g', 'atomic', ' ', { entityRanges: [{ key: 1, offset: 0, length: 1 }] })
      ]
    },
    media_entities: [
      { media_id: 'v1', media_key: 'kv', media_info: { __typename: 'ApiVideo', preview_image: { original_img_url: 'https://pbs.twimg.com/amplify_video_thumb/1/img/v.jpg' }, duration_millis: 9000, variants: [{ bitrate: 832000, content_type: 'video/mp4', url: 'https://video.twimg.com/amplify_video/1/v.mp4' }] } },
      { media_id: 'g1', media_key: 'kg', media_info: { __typename: 'ApiGif', preview_image: { original_img_url: 'https://pbs.twimg.com/tweet_video_thumb/g.jpg' }, variants: [{ bitrate: 0, content_type: 'video/mp4', url: 'https://video.twimg.com/tweet_video/g.mp4' }] } }
    ]
  }
  const result = articleFromContentState(article)!
  expect(result.markdown).toContain('![X 视频封面](https://pbs.twimg.com/amplify_video_thumb/1/img/v.jpg)')
  expect(result.markdown).toContain('![X 视频封面](https://pbs.twimg.com/tweet_video_thumb/g.jpg)')
  expect(result.markdown.match(/视频未下载，仅保留封面/g)).toHaveLength(2)
  expect(result.markdown).not.toContain('video.twimg.com')
  expect(result.markdown).not.toContain('.mp4')
  expect(result.images).toEqual(expect.arrayContaining([
    'https://pbs.twimg.com/amplify_video_thumb/1/img/v.jpg',
    'https://pbs.twimg.com/tweet_video_thumb/g.jpg'
  ]))
  expect(result.images.every(u => !u.includes('video.twimg.com'))).toBe(true)
  expect(result.partialReasons).toEqual([])
  const captured = captureFromPayload({ ...tweet(), article: { article_results: { result: article } } }, '123')!
  expect(captured.post.partial).toBe(false)
})

it('无法映射的媒体仍记 media-unresolved，TWEMOJI 实体不产生标记', () => {
  const article = {
    title: '表情',
    content_state: {
      entityMap: [
        { key: '0', value: { type: 'MEDIA', mutability: 'IMMUTABLE', data: { mediaItems: [{ mediaId: 'gone' }] } } },
        { key: '5', value: { type: 'TWEMOJI', mutability: 'IMMUTABLE', data: { emoji: '😀', url: 'https://abs.twimg.com/emoji/v2/svg/1f600.svg' } } }
      ],
      blocks: [
        block('p', 'unstyled', '带表情 😀 的正文', { entityRanges: [{ key: 5, offset: 4, length: 2 }] }),
        block('m', 'atomic', ' ', { entityRanges: [{ key: 0, offset: 0, length: 1 }] })
      ]
    },
    media_entities: []
  }
  const result = articleFromContentState(article)!
  expect(result.markdown).toContain('带表情 😀 的正文')
  expect(result.markdown).not.toContain('abs.twimg.com')
  expect(result.partialReasons).toEqual(['media-unresolved'])
})

it('LINK 实体为 t.co 且锚文本是 https 链接时改用锚文本地址', () => {
  const real = 'https://sg.starryblu.com/x/demo'
  const make = (text: string, url: string) => ({
    title: '链接',
    content_state: {
      entityMap: [{ key: '0', value: { type: 'LINK', mutability: 'MUTABLE', data: { url } } }],
      blocks: [block('p', 'unstyled', text, { entityRanges: [{ key: 0, offset: 2, length: text.indexOf(' ', 2) - 2 }] })]
    }
  })
  const resolved = articleFromContentState(make(`见 ${real} 详情`, 'https://t.co/hB4Z0adyUC'))!
  expect(resolved.markdown).toContain(`[${real}](${real})`)
  expect(resolved.markdown).not.toContain('t.co')
  const plain = articleFromContentState(make('见 短链接 详情', 'https://t.co/hB4Z0adyUC'))!
  expect(plain.markdown).toContain('[短链接](https://t.co/hB4Z0adyUC)')
})


