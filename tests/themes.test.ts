import { describe, expect, it } from 'vitest'
import { contrast, cssVariables, palettes, themeColors, themes } from '../src/shared/themes'

const combos = palettes.flatMap(palette => (['light', 'dark'] as const).map(mode => ({ palette, mode, c: themes[palette][mode] })))
const surfaces = ['bg', 'side', 'panel'] as const

describe('主题配色对比度', () => {
  it.each(combos)('$palette/$mode 正文与次要文字可读', ({ c }) => {
    for (const s of surfaces) {
      expect(contrast(c.text, c[s]), `正文 on ${s}`).toBeGreaterThanOrEqual(7)
      expect(contrast(c.muted, c[s]), `次要文字 on ${s}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(c.muted, c.selected), '次要文字 on 选中底').toBeGreaterThanOrEqual(3)
  })

  it.each(combos)('$palette/$mode 主按钮与背景、按钮文字有足够对比', ({ c }) => {
    for (const s of surfaces) {
      expect(contrast(c.accent, c[s]), `主按钮 on ${s}`).toBeGreaterThanOrEqual(3)
      expect(contrast(c.accentHover, c[s]), `主按钮悬停 on ${s}`).toBeGreaterThanOrEqual(3)
    }
    expect(contrast(c.onAccent, c.accent), '按钮文字 on 主按钮').toBeGreaterThanOrEqual(4.5)
    expect(contrast(c.onAccent, c.accentHover), '按钮文字 on 主按钮悬停').toBeGreaterThanOrEqual(4.5)
  })

  it.each(combos)('$palette/$mode 次级按钮边框与强调文字可见', ({ c }) => {
    for (const s of surfaces) expect(contrast(c.control, c[s]), `按钮边框 on ${s}`).toBeGreaterThanOrEqual(3)
    expect(contrast(c.accent, c.selected), '选中项强调文字').toBeGreaterThanOrEqual(4.5)
    expect(contrast(c.text, c.mark), '搜索高亮').toBeGreaterThanOrEqual(4.5)
    for (const [fg, bg] of [['success', 'successSoft'], ['warning', 'warningSoft'], ['danger', 'dangerSoft']] as const) {
      expect(contrast(c[fg], c[bg]), `${fg} 状态条`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(c[fg], c.bg), `${fg} on bg`).toBeGreaterThanOrEqual(3)
    }
  })

  it('未知配色回退雾蓝，变量名完整', () => {
    expect(themeColors('unknown', false)).toBe(themes.mist.light)
    expect(themeColors(undefined, true)).toBe(themes.mist.dark)
    const vars = cssVariables(themes.jade.dark)
    expect(vars['--on-accent']).toBe(themes.jade.dark.onAccent)
    expect(Object.keys(vars)).toHaveLength(19)
  })
})
