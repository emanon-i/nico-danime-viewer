import { defineConfig, type Plugin } from 'vite'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, 'data')

// GitHub Pages では /nico-danime-viewer/ が base path。ローカル開発は '/'。
const base = process.env.CI ? '/nico-danime-viewer/' : '/'

function addDataMiddleware(middlewares: {
  use: (
    path: string,
    fn: (
      req: { url?: string },
      res: { setHeader: (k: string, v: string) => void },
      next: () => void
    ) => void
  ) => void
}) {
  middlewares.use('/data', (req, res, next) => {
    const url = req.url ?? ''
    if (!url.endsWith('.json')) return next()
    const file = join(DATA_DIR, url.replace(/^\//, ''))
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    createReadStream(file)
      .on('error', () => next())
      .pipe(res as unknown as NodeJS.WritableStream)
  })
}

const dataPlugin: Plugin = {
  name: 'serve-and-copy-data',
  configureServer(server) {
    addDataMiddleware(server.middlewares)
  },
  configurePreviewServer(server) {
    addDataMiddleware(server.middlewares)
  },
  closeBundle() {
    const dest = join(__dirname, 'dist', 'data')
    mkdirSync(dest, { recursive: true })
    for (const f of readdirSync(DATA_DIR)) {
      if (f.endsWith('.json')) copyFileSync(join(DATA_DIR, f), join(dest, f))
    }
    const srcSeriesDir = join(DATA_DIR, 'series')
    if (existsSync(srcSeriesDir)) {
      const destSeriesDir = join(dest, 'series')
      mkdirSync(destSeriesDir, { recursive: true })
      for (const f of readdirSync(srcSeriesDir)) {
        if (f.endsWith('.json')) copyFileSync(join(srcSeriesDir, f), join(destSeriesDir, f))
      }
    }
  },
}

export default defineConfig({
  root: 'web',
  base,
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  plugins: [dataPlugin],
})
