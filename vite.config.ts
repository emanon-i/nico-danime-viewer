import { defineConfig } from 'vite'

// GitHub Pages では /nico-danime-viewer/ が base path。ローカル開発は '/'。
const base = process.env.CI ? '/nico-danime-viewer/' : '/'

export default defineConfig({
  root: 'web',
  base,
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
})
