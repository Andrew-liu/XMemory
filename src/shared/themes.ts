export type ThemeMode = 'system' | 'light' | 'dark'
export type Palette = 'mist' | 'jade' | 'paper' | 'rose' | 'wisteria' | 'graphite'
export const palettes = ['mist', 'jade', 'paper', 'rose', 'wisteria', 'graphite'] as const satisfies readonly Palette[]
export const paletteNames: Record<Palette, string> = { mist: '雾蓝', jade: '青瓷', paper: '暖纸', rose: '樱粉', wisteria: '紫藤', graphite: '石墨' }

export interface ThemeColors {
  bg: string; side: string; panel: string; line: string; control: string
  text: string; muted: string; accent: string; onAccent: string; accentHover: string
  selected: string; hover: string
  success: string; warning: string; danger: string
  successSoft: string; warningSoft: string; dangerSoft: string; mark: string
}

const lightStatus = { success: '#23784f', warning: '#8a5410', danger: '#b4382b', successSoft: '#e4f3ea', warningSoft: '#fcf0dd', dangerSoft: '#fbe7e4', mark: '#ffe08a' }
const darkStatus = { success: '#74cfa0', warning: '#f0bb6a', danger: '#f4968c', successSoft: '#1e3328', warningSoft: '#3a2f1b', dangerSoft: '#3d2424', mark: '#6e5a1c' }

export const themes: Record<Palette, Record<'light' | 'dark', ThemeColors>> = {
  mist: {
    light: { bg: '#ffffff', side: '#f2f4f7', panel: '#fafbfc', line: '#e3e7ee', control: '#7d8698', text: '#232d40', muted: '#5f6a7d', accent: '#4565be', onAccent: '#ffffff', accentHover: '#3a57a8', selected: '#e6ecfa', hover: '#eceff4', ...lightStatus },
    dark: { bg: '#202329', side: '#191c22', panel: '#23272e', line: '#333943', control: '#6b7484', text: '#e1e6f0', muted: '#a3acbc', accent: '#91abfa', onAccent: '#0f1730', accentHover: '#a9befc', selected: '#2c3753', hover: '#2b3039', ...darkStatus }
  },
  jade: {
    light: { bg: '#fbfcfb', side: '#edf3f0', panel: '#f6f9f7', line: '#dde7e2', control: '#73867d', text: '#1f2d28', muted: '#58695f', accent: '#22715c', onAccent: '#ffffff', accentHover: '#1a5e4c', selected: '#dff0e9', hover: '#e7efeb', ...lightStatus },
    dark: { bg: '#1c2321', side: '#161c1a', panel: '#1f2725', line: '#2f3a37', control: '#647571', text: '#dfe9e5', muted: '#9fb1aa', accent: '#6fc6a9', onAccent: '#0b2620', accentHover: '#8ad4bb', selected: '#253a33', hover: '#26302d', ...darkStatus }
  },
  paper: {
    light: { bg: '#fbf8f2', side: '#f1ebdf', panel: '#f8f4ec', line: '#e6dece', control: '#8a7d67', text: '#2f2a22', muted: '#6c6152', accent: '#9a531d', onAccent: '#ffffff', accentHover: '#844616', selected: '#f3e4d2', hover: '#efe8da', ...lightStatus },
    dark: { bg: '#241f1a', side: '#1d1915', panel: '#28231d', line: '#3a332b', control: '#7a6e60', text: '#ece3d6', muted: '#b4a794', accent: '#e3a46a', onAccent: '#2a1606', accentHover: '#ebb684', selected: '#3d3022', hover: '#302921', ...darkStatus }
  },
  rose: {
    light: { bg: '#fffbfc', side: '#f8eff3', panel: '#fdf6f8', line: '#efdfe6', control: '#917a84', text: '#33242b', muted: '#6f5a64', accent: '#b2416a', onAccent: '#ffffff', accentHover: '#9a3559', selected: '#f9e7ee', hover: '#f4e9ee', ...lightStatus },
    dark: { bg: '#251e22', side: '#1d181b', panel: '#291f24', line: '#3c2f35', control: '#7c6a72', text: '#f0e2e8', muted: '#b9a2ac', accent: '#f293b4', onAccent: '#2e0b19', accentHover: '#f6abc5', selected: '#422a35', hover: '#31262b', ...darkStatus }
  },
  wisteria: {
    light: { bg: '#fcfbff', side: '#f1eff9', panel: '#f8f7fd', line: '#e2def0', control: '#827d96', text: '#28243a', muted: '#625d77', accent: '#6c4cba', onAccent: '#ffffff', accentHover: '#5b3ea2', selected: '#ebe5fa', hover: '#ece9f6', ...lightStatus },
    dark: { bg: '#211f2a', side: '#1a1822', panel: '#25222f', line: '#363244', control: '#716b86', text: '#e6e2f2', muted: '#aaa4c0', accent: '#b5a0f6', onAccent: '#1b1036', accentHover: '#c6b5f8', selected: '#352e52', hover: '#2b2836', ...darkStatus }
  },
  graphite: {
    light: { bg: '#ffffff', side: '#f2f2f3', panel: '#f9f9fa', line: '#e2e3e5', control: '#7d8087', text: '#1f2126', muted: '#5f636b', accent: '#2a2e38', onAccent: '#ffffff', accentHover: '#3d4250', selected: '#e6e7ea', hover: '#ececee', ...lightStatus },
    dark: { bg: '#1b1c1e', side: '#141516', panel: '#202123', line: '#323438', control: '#6d7078', text: '#e6e7ea', muted: '#a6a9b0', accent: '#e6e8ed', onAccent: '#16181c', accentHover: '#ffffff', selected: '#33353a', hover: '#28292c', ...darkStatus }
  }
}

export function isPalette(value: unknown): value is Palette { return typeof value === 'string' && (palettes as readonly string[]).includes(value) }
export function themeColors(palette: unknown, dark: boolean): ThemeColors { return themes[isPalette(palette) ? palette : 'mist'][dark ? 'dark' : 'light'] }

const cssNames: Record<keyof ThemeColors, string> = {
  bg: '--bg', side: '--side', panel: '--panel', line: '--line', control: '--control', text: '--text', muted: '--muted',
  accent: '--accent', onAccent: '--on-accent', accentHover: '--accent-hover', selected: '--selected', hover: '--hover',
  success: '--success', warning: '--warning', danger: '--danger', successSoft: '--success-soft', warningSoft: '--warning-soft', dangerSoft: '--danger-soft', mark: '--mark'
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
