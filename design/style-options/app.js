/* XMemeory 风格预览：所有风格共用同一份结构与合成数据，只换样式表。
 * 用安全 DOM API 生成内容；搜索框可输入，关键词在列表和正文中全部标黄，点击条目不改变顺序。 */
(function () {
  'use strict'

  const memories = [
    {
      id: 'm1', author: 'karpathy', date: '10-26', tag: '长文', title: '给 AI Agent 设计长期记忆的三层结构',
      snippet: '短期上下文、情节记忆和语义记忆各自承担不同职责，Agent 在长任务中需要把情节压缩成可检索的事实……',
      body: [
        ['p', '多数 Agent 失败不是因为模型不够聪明，而是因为它记不住三小时前做过的决定。我们把记忆拆成三层，分别解决“现在”“发生过什么”和“我知道什么”。'],
        ['h2', '一、短期上下文'],
        ['p', '上下文窗口是 Agent 的工作台。它昂贵、易失，只放当前步骤必需的信息；超过阈值时先压缩成摘要再写入情节记忆。'],
        ['h2', '二、情节记忆'],
        ['p', '每次交互保存为带时间戳的事件。检索时按时间和实体过滤，Agent 可以回答“上次我们为什么放弃方案 A”。'],
        ['quote', '记忆的价值不在存得多，而在下一次需要时能被准确地找回来。'],
        ['h2', '三、语义记忆'],
        ['ul', ['从多个事件中提炼稳定事实与偏好', '有冲突时以较新的用户表态为准', '定期淘汰过期的状态快照']],
        ['note', '我的笔记：可以对照 XMemory 自己的“原文 / 我的笔记”分区，Agent 记忆也需要区分“采集来的”和“自己写的”。']
      ]
    },
    { id: 'm2', author: 'simonw', date: '10-25', tag: '短推', title: '用 SQLite FTS5 给本地笔记做全文搜索', snippet: '中文分词是关键：trigram 分词器对 Agent 生成的混合中英文笔记效果很稳，召回率比 unicode61 高很多。' },
    { id: 'm3', author: 'swyx', date: '10-24', tag: '长文', title: 'AI Engineer 的一年：从 Prompt 到 Agent 工作流', snippet: '今年最大的变化是评测先行。没有 eval 的 Agent 就像没有测试的代码，上线后只能靠用户报 bug。' },
    { id: 'm4', author: 'lilianweng', date: '10-22', tag: '长文', title: 'LLM Powered Autonomous Agents 再读笔记', snippet: '规划、记忆、工具使用三件套依然成立；新的变化在于反思（reflection）被做进了训练而不只是提示词。' },
    { id: 'm5', author: 'naval', date: '10-20', tag: '短推', title: '读书不是为了记住，而是为了改变你看问题的方式', snippet: '收藏一千条推文不会让你变聪明，把其中三条变成自己的判断才会。' },
    { id: 'm6', author: 'dotey', date: '10-18', tag: '正文不完整', title: 'Claude Code 的 Subagent 实践：拆任务的边界在哪', snippet: '主 Agent 负责计划和验收，子 Agent 只拿到完成单一任务所需的最小上下文，避免上下文污染……' },
    { id: 'm7', author: 'paulg', date: '10-15', tag: '短推', title: 'The best ideas look like toys at first', snippet: 'If you want to know what will matter in ten years, look at what smart people are playing with on weekends.' }
  ]
  for (const m of memories) if (!m.body) m.body = [['p', m.snippet], ['p', '（预览用合成内容，正文仅展示一段。）']]

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n }

  function terms(query) {
    return [...new Set(query.normalize('NFKC').toLowerCase().split(/\s+/).filter(t => t && !t.startsWith('@') && t !== '不完整'))]
  }
  /** Append `text` to `parent`, wrapping every case-insensitive match of any term in <mark>. */
  function appendMarked(parent, text, ts) {
    const lower = text.normalize('NFKC').toLowerCase()
    const ranges = []
    for (const t of ts) for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + t.length)) ranges.push([i, i + t.length])
    ranges.sort((a, b) => a[0] - b[0])
    let cursor = 0
    for (const [from, to] of ranges) {
      if (from < cursor) continue
      if (from > cursor) parent.appendChild(document.createTextNode(text.slice(cursor, from)))
      parent.appendChild(el('mark', '', text.slice(from, to)))
      cursor = to
    }
    if (cursor < text.length) parent.appendChild(document.createTextNode(text.slice(cursor)))
    return parent
  }
  const matches = (m, ts, author) => (!author || m.author.toLowerCase().includes(author)) &&
    ts.every(t => `${m.title}\n${m.snippet}\n${m.body.map(b => [].concat(b[1]).join(' ')).join(' ')}`.normalize('NFKC').toLowerCase().includes(t))

  let selected = 'm1'
  let query = 'agent'

  function build() {
    const app = el('div', 'app')
    const side = el('aside', 'side')
    const brand = el('div', 'brand'); brand.append(el('span', 'brand-mark', 'Xm'), el('strong', 'brand-name', 'XMemeory'))
    const all = el('button', 'search-all'); all.append(el('span', '', '搜索所有内容'), el('kbd', '', 'Ctrl K'))
    const nav = el('nav', 'nav')
    for (const [name, count, on] of [['灵感', 126, false], ['记忆', 388, true], ['选题', 7, false]]) {
      const b = el('button', on ? 'nav-item on' : 'nav-item'); b.append(el('span', 'nav-name', name), el('small', 'nav-count', String(count))); nav.appendChild(b)
    }
    const motto = el('p', 'motto', '捕捉一闪而过的想法，让值得留下的内容成为下一次创作的起点。')
    const foot = el('div', 'side-foot'); foot.append(el('button', 'nav-item', '回收站'), el('button', 'nav-item', '设置'), el('span', 'local', '本地优先 · 私人工作区'))
    side.append(brand, all, nav, motto, foot)

    const main = el('main', 'main')
    const top = el('header', 'top')
    const pageTitle = el('h1', 'page-title'); pageTitle.append(el('span', '', '记忆'), el('small', 'page-count', '388'))
    const searchBox = el('label', 'search')
    const input = el('input'); input.type = 'search'; input.value = query; input.placeholder = '搜索正文或链接，@作者 按作者搜索'; input.setAttribute('aria-label', '搜索记忆')
    searchBox.append(el('span', 'search-icon', '⌕'), input)
    top.append(pageTitle, el('button', 'partial-link', '1 条不完整'), searchBox)

    const status = el('div', 'status')
    const statusText = el('span', 'status-text', '自动采集中 · 下次约 14:32 · 今日 12/200 · 历史已回溯完')
    status.append(el('i', 'status-dot'), statusText, el('button', 'btn', '暂停'))
    const bar = el('div', 'progress'); bar.appendChild(el('i'))
    status.appendChild(bar)

    const body = el('div', 'body')
    const list = el('section', 'list')
    const detail = el('article', 'detail')
    body.append(list, detail)
    main.append(top, status, body)
    app.append(side, main)
    document.body.appendChild(app)

    const renderList = () => {
      const ts = terms(query)
      const author = (query.split(/\s+/).find(t => t.startsWith('@') && t.length > 1) || '').slice(1).toLowerCase()
      list.replaceChildren()
      const head = el('div', 'list-head'); head.append(el('span', 'eyebrow', '从收藏到积累'))
      list.appendChild(head)
      const shown = memories.filter(m => matches(m, ts, author))
      head.appendChild(el('span', 'list-count', `${shown.length} 条匹配`))
      for (const m of shown) {
        const card = el('button', m.id === selected ? 'card on' : 'card')
        const meta = el('div', 'card-meta'); meta.append(el('span', 'card-author', `@${m.author}`), el('time', 'card-date', m.date))
        const tag = el('span', m.tag === '正文不完整' ? 'card-tag warn' : 'card-tag', m.tag)
        card.append(meta, appendMarked(el('h3', 'card-title'), m.title, ts), appendMarked(el('p', 'card-snippet'), m.snippet, ts), tag)
        card.addEventListener('click', () => { selected = m.id; renderList(); renderDetail() })
        list.appendChild(card)
      }
      if (!shown.length) list.appendChild(el('p', 'empty', '没有匹配的记忆，试试其他关键词。'))
    }
    const renderDetail = () => {
      const ts = terms(query)
      const m = memories.find(x => x.id === selected) || memories[0]
      detail.replaceChildren()
      const actions = el('div', 'actions'); actions.append(el('button', 'btn ghost', '← 返回记忆'), el('button', 'btn', '打开原文'), el('button', 'btn', '复制链接'), el('span', 'saved', '已保存到本地'))
      const eyebrow = el('span', 'eyebrow', '记忆档案')
      const title = appendMarked(el('h1', 'doc-title'), m.title, ts)
      const meta = el('p', 'doc-meta', `@${m.author} · 发布于 2026-${m.date} · ${m.tag}`)
      const content = el('div', 'doc-body')
      content.appendChild(el('h2', 'section-label', 'X 原文'))
      for (const [type, value] of m.body) {
        if (type === 'ul') { const ul = el('ul'); for (const v of value) ul.appendChild(appendMarked(el('li'), v, ts)); content.appendChild(ul) }
        else if (type === 'quote') content.appendChild(appendMarked(el('blockquote'), value, ts))
        else if (type === 'note') { content.appendChild(el('h2', 'section-label', '我的笔记')); content.appendChild(appendMarked(el('p', 'my-note'), value, ts)) }
        else content.appendChild(appendMarked(el(type), value, ts))
      }
      const foot = el('footer', 'doc-foot'); foot.append(el('span', '', '1,284 字符 · Markdown'), el('span', '', `memories/${m.author}/${m.id}.md`))
      detail.append(actions, eyebrow, title, meta, content, foot)
    }
    input.addEventListener('input', () => { query = input.value; renderList(); renderDetail() })
    renderList(); renderDetail()
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', build) : build()
})()
