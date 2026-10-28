export type ThemeMode = 'system' | 'light' | 'dark'
// v0.6.0 起只保留和纸一套配色；旧的配色名在主进程读取设置时会被视为非法值删除并回退到和纸。
export type Palette = 'washi'
export const palettes = ['washi'] as const satisfies readonly Palette[]
export const paletteNames: Record<Palette, string> = { washi: '和纸' }

export interface ThemeColors {
  bg: string; side: string; panel: string; line: string; control: string
  text: string; muted: string; accent: string; onAccent: string; accentHover: string
  selected: string; hover: string; seal: string
  success: string; warning: string; danger: string
  successSoft: string; warningSoft: string; dangerSoft: string; mark: string; markText: string
}

export const themes: Record<Palette, Record<'light' | 'dark', ThemeColors>> = {
  washi: {
    light: {
      bg: '#fbfaf7', side: '#f6f4ef', panel: '#f8f6f2', line: '#e8e3d9', control: '#8a8378',
      text: '#2b2a28', muted: '#69645b', accent: '#2e4a62', onAccent: '#ffffff', accentHover: '#22394d',
      selected: '#efebe2', hover: '#f1eee7', seal: '#b8412c',
      success: '#2f6b4a', warning: '#875414', danger: '#a8392a',
      successSoft: '#e8f0ea', warningSoft: '#f7eedf', dangerSoft: '#f7e6e2', mark: '#ffe14d', markText: '#1f1a00'
    },
    // 暗版可读性要求高于亮版：正文 ≥12:1，辅助文字 ≥7:1。
    dark: {
      bg: '#1c1b19', side: '#191816', panel: '#211f1d', line: '#3a3631', control: '#8b847a',
      text: '#f1ede6', muted: '#c2bbaf', accent: '#a3bdd6', onAccent: '#13212e', accentHover: '#bccfe2',
      selected: '#2c2a26', hover: '#262421', seal: '#f0907a',
      success: '#8fd3ab', warning: '#efc27a', danger: '#f4a092',
      successSoft: '#1f2e25', warningSoft: '#33291b', dangerSoft: '#36221f', mark: '#f5cf3d', markText: '#1f1a00'
    }
  }
}

export function isPalette(value: unknown): value is Palette { return typeof value === 'string' && (palettes as readonly string[]).includes(value) }
export function themeColors(_palette: unknown, dark: boolean): ThemeColors { return themes.washi[dark ? 'dark' : 'light'] }

const cssNames: Record<keyof ThemeColors, string> = {
  bg: '--bg', side: '--side', panel: '--panel', line: '--line', control: '--control', text: '--text', muted: '--muted',
  accent: '--accent', onAccent: '--on-accent', accentHover: '--accent-hover', selected: '--selected', hover: '--hover', seal: '--seal',
  success: '--success', warning: '--warning', danger: '--danger', successSoft: '--success-soft', warningSoft: '--warning-soft', dangerSoft: '--danger-soft', mark: '--mark', markText: '--mark-text'
}
export function cssVariables(colors: ThemeColors): Record<string, string> {
  return Object.fromEntries(Object.entries(colors).map(([key, value]) => [cssNames[key as keyof ThemeColors], value]))
}

function channel(hex: string, offset: number) {
  const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}
export function luminance(hex: string) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`颜色格式无效：${hex}`)
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5)
}
export function contrast(a: string, b: string) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}
