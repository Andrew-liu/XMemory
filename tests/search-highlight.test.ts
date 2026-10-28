import { describe, expect, it } from 'vitest'
import { findAllSearchMatches, findSearchMatch } from '../src/shared/search-location'
import { matchSnippet, splitMatches, stableOrder } from '../src/renderer/highlight'
import { memoryAuthorQuery, memoryHighlightQuery } from '../src/renderer/Memory'

const item = (id: string) => ({ id })

describe('搜索结果顺序稳定', () => {
  it('同一查询下内容刷新（如点开后自动保存改了修改时间）不改变已显示顺序', () => {
    const shown = ['a', 'b', 'c']
    const refreshed = [item('b'), item('a'), item('c')]
    expect(stableOrder(shown, refreshed).map(n => n.id)).toEqual(['a', 'b', 'c'])
  })
  it('新出现的结果放在最前，消失的结果移除', () => {
    expect(stableOrder(['a', 'b', 'c'], [item('c'), item('new'), item('a')]).map(n => n.id)).toEqual(['new', 'a', 'c'])
  })
  it('没有历史顺序时保持原始顺序', () => {
    expect(stableOrder([], [item('x'), item('y')]).map(n => n.id)).toEqual(['x', 'y'])
  })
})

describe('关键词高亮', () => {
  it('所有关键词的所有出现位置都高亮，大小写与全角半角不敏感', () => {
    const segments = splitMatches('Agent 设计：agent 与 ＡＧＥＮＴ，记忆 Agent', 'agent 记忆')
    expect(segments.filter(s => s.highlighted).map(s => s.text)).toEqual(['Agent', 'agent', 'ＡＧＥＮＴ', '记忆', 'Agent'])
    expect(segments.map(s => s.text).join('')).toBe('Agent 设计：agent 与 ＡＧＥＮＴ，记忆 Agent')
  })
  it('引号短语整体匹配，重叠的词合并为一段', () => {
    expect(findAllSearchMatches('长期记忆系统', '"长期记忆" 记忆系统')).toEqual([{ from: 0, to: 6 }])
    expect(splitMatches('无匹配', 'xyz')).toEqual([{ text: '无匹配', highlighted: false }])
  })
  it('正则特殊字符按字面匹配', () => {
    expect(splitMatches('a+b (c) a+b', 'a+b (c)').filter(s => s.highlighted).map(s => s.text)).toEqual(['a+b', '(c)', 'a+b'])
  })
  it('定位仍返回第一个匹配', () => {
    expect(findSearchMatch('前缀 beta 然后 alpha', 'alpha beta')).toEqual({ from: 3, to: 7 })
  })
  it('匹配在正文后部时摘要从匹配附近开始', () => {
    const body = `${'无关内容'.repeat(60)}关键结论在这里`
    expect(matchSnippet(body, '关键结论')).toContain('关键结论')
    expect(matchSnippet('开头就有关键结论', '关键结论')).toBe('开头就有关键结论')
  })
  it('记忆搜索：@作者 与"不完整"不当作正文高亮词', () => {
    expect(memoryHighlightQuery('@ElonMusk 星舰 不完整')).toBe('星舰')
    expect(memoryAuthorQuery('@ElonMusk 星舰')).toBe('elonmusk')
  })
})
