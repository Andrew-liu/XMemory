import { describe, expect, it } from 'vitest'
import { contrast, cssVariables, isPalette, palettes, themeColors, themes } from '../src/shared/themes'

const combos = palettes.flatMap(palette => (['light', 'dark'] as const).map(mode => ({ palette, mode, c: themes[palette][mode] })))
const surfaces = ['bg', 'side', 'panel', 'hover'] as const

describe('主题配色对比度', () => {
  it('只保留和纸一套配色', () => {
    expect(palettes).toEqual(['washi'])
  })

  it.each(combos)('$palette/$mode 正文与次要文字可读', ({ mode, c }) => {
    const [textMin, mutedMin] = mode === 'dark' ? [12, 7] : [7, 4.5]
    for (const s of surfaces) {
      expect(contrast(c.text, c[s]), `正文 on ${s}`).toBeGreaterThanOrEqual(textMin)
      expect(contrast(c.muted, c[s]), `次要文字 on ${s}`).toBeGreaterThanOrEqual(mutedMin)
    }
    expect(contrast(c.text, c.selected), '正文 on 选中底').toBeGreaterThanOrEqual(textMin)
    expect(contrast(c.muted, c.selected), '次要文字 on 选中底').toBeGreaterThanOrEqual(4.5)
  })

  it.each(combos)('$palette/$mode 主按钮与背景、按钮文字有足够对比', ({ c }) => {
    for (const s of surfaces) {
      expect(contrast(c.accent, c[s]), `主按钮 on ${s}`).toBeGreaterThanOrEqual(3)
      expect(contrast(c.accentHover, c[s]), `主按钮悬停 on ${s}`).toBeGreaterThanOrEqual(3)
    }
    expect(contrast(c.onAccent, c.accent), '按钮文字 on 主按钮').toBeGreaterThanOrEqual(4.5)
    expect(contrast(c.onAccent, c.accentHover), '按钮文字 on 主按钮悬停').toBeGreaterThanOrEqual(4.5)
  })

  it.each(combos)('$palette/$mode 次级按钮边框、强调文字与标记可见', ({ c }) => {
    for (const s of surfaces) {
      expect(contrast(c.control, c[s]), `按钮边框 on ${s}`).toBeGreaterThanOrEqual(3)
      expect(contrast(c.seal, c[s]), `朱红标记 on ${s}`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(c.accent, c[s]), `强调文字 on ${s}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(c.accent, c.selected), '选中项强调文字').toBeGreaterThanOrEqual(4.5)
    expect(contrast(c.markText, c.mark), '搜索高亮').toBeGreaterThanOrEqual(4.5)
    expect(c.mark, '搜索高亮为黄色').toMatch(/^#f[0-9a-f]{3}[0-6][0-9a-f]$/i)
    for (const [fg, bg] of [['success', 'successSoft'], ['warning', 'warningSoft'], ['danger', 'dangerSoft']] as const) {
      expect(contrast(c[fg], c[bg]), `${fg} 状态条`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(c[fg], c.bg), `${fg} on bg`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('旧配色、未知配色和缺省值都回退和纸，变量名完整', () => {
    for (const legacy of ['mist', 'jade', 'paper', 'rose', 'wisteria', 'graphite', 'unknown', undefined]) {
      expect(isPalette(legacy)).toBe(false)
      expect(themeColors(legacy, false)).toBe(themes.washi.light)
      expect(themeColors(legacy, true)).toBe(themes.washi.dark)
    }
    const vars = cssVariables(themes.washi.dark)
    expect(vars['--on-accent']).toBe(themes.washi.dark.onAccent)
    expect(vars['--seal']).toBe(themes.washi.dark.seal)
    expect(Object.keys(vars)).toHaveLength(21)
  })
})
