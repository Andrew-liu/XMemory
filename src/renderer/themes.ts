import { cssVariables, isPalette, themeColors, type Palette, type ThemeMode } from '../shared/themes'

const cacheKey = 'xmemeory.appearance'
const darkQuery = () => matchMedia('(prefers-color-scheme: dark)')

export function resolveDark(mode: ThemeMode) { return mode === 'dark' || (mode === 'system' && darkQuery().matches) }

export function applyTheme(mode: ThemeMode, palette: Palette | undefined) {
  const dark = resolveDark(mode)
  const name = isPalette(palette) ? palette : 'mist'
  const root = document.documentElement
  root.dataset.theme = dark ? 'dark' : 'light'
  root.dataset.palette = name
  for (const [key, value] of Object.entries(cssVariables(themeColors(name, dark)))) root.style.setProperty(key, value)
  try { localStorage.setItem(cacheKey, JSON.stringify({ mode, palette: name })) } catch { /* 缓存仅用于首帧，失败时等待设置加载。 */ }
  return dark
}

export function applyCachedTheme() {
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || '{}') as { mode?: unknown; palette?: unknown }
    const mode: ThemeMode = cached.mode === 'light' || cached.mode === 'dark' ? cached.mode : 'system'
    applyTheme(mode, isPalette(cached.palette) ? cached.palette : undefined)
  } catch { applyTheme('system', undefined) }
}

export function watchSystemTheme(onChange: () => void) {
  const query = darkQuery()
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
