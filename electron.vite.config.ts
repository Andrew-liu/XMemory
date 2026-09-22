import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: { build: { outDir: 'dist/main', rollupOptions: { input: 'src/main/index.ts', external: ['node:sqlite', 'playwright', 'playwright-core'] } } },
  preload: { build: { outDir: 'dist/preload', rollupOptions: { input: 'src/preload/index.ts', output: { format: 'cjs', entryFileNames: 'index.cjs' } } } },
  renderer: { root: 'src/renderer', plugins: [react()], build: { outDir: resolve('dist/renderer'), rollupOptions: { input: resolve('src/renderer/index.html') } } }
})
