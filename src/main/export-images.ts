import { MarkdownManager } from '@tiptap/markdown'

/** Parse rendered images, excluding fenced/inline code and ordinary links. */
export function referencedImages(body: string): string[] {
  const parser = new MarkdownManager().instance
  const images = new Set<string>()
  parser.use({ extensions: [{ name: 'wikiImage', level: 'inline',
    start: text => text.indexOf('![['),
    tokenizer(text) {
      const match = /^!\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/.exec(text)
      if (match) return { type: 'wikiImage', raw: match[0], href: match[1] }
    }
  }] })
  parser.walkTokens(parser.lexer(body), token => {
    if (token.type === 'image' || token.type === 'wikiImage') {
      const href = String(token.href)
      if (!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) images.add(href)
    }
  })
  return [...images]
}
