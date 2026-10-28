import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// @fontsource 的 CSS 同时列出 woff2 和 woff；Electron 只需要 woff2，去掉 woff 备用源避免把两份字体都打进包里。
const woff2Only = (): Plugin => ({
  name: 'xmemeory-woff2-only',
  enforce: 'pre',
  transform(code, id) {
    if (!/[\\/]@fontsource[\\/][^?]+\.css(\?|$)/.test(id)) return
    return { code: code.replace(/,\s*url\([^)]+\.woff\)\s*format\(['"]woff['"]\)/g, ''), map: null }
  }
})

export default defineConfig({
  main: { build: { outDir: 'dist/main', rollupOptions: { input: 'src/main/index.ts', external: ['node:sqlite', 'playwright', 'playwright-core'] } } },
  preload: { build: { outDir: 'dist/preload', rollupOptions: { input: 'src/preload/index.ts', output: { format: 'cjs', entryFileNames: 'index.cjs' } } } },
  // 字体切片不内联成 data: 地址：index.html 的 CSP 只允许同源字体，内联会被拦截。
  renderer: { root: 'src/renderer', plugins: [woff2Only(), react()], build: { outDir: resolve('dist/renderer'), assetsInlineLimit: (file: string) => /\.woff2?$/.test(file) ? false : undefined, rollupOptions: { input: resolve('src/renderer/index.html') } } }
})
