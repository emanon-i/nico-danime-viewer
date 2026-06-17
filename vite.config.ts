import { defineConfig, type Plugin } from 'vite'
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, 'data')

// GitHub Pages では /nico-danime-viewer/ が base path。ローカル開発は '/'。
const base = process.env.CI ? '/nico-danime-viewer/' : '/'

// ビルド識別子（§92）。CI ではコミット SHA、ローカルではビルド時刻。デプロイ毎に変わる。
// アプリには __BUILD_ID__ として焼き込み、同値を version.json に出力 → 実行中の値と
// version.json の値が食い違えば「新デプロイあり」と判定して更新バナーを出す。
const buildId = (process.env.GITHUB_SHA ?? '').slice(0, 12) || `dev-${Date.now()}`

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
  // version.json をローカルでも配信（§92・キャッシュさせない）
  middlewares.use('/version.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    ;(res as unknown as NodeJS.WritableStream).end(JSON.stringify({ build: buildId }))
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
    // version.json を dist 直下に出力（§92・base path 直下で配信される）。
    writeFileSync(join(__dirname, 'dist', 'version.json'), JSON.stringify({ build: buildId }))
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
  define: {
    // 実行中バンドルの識別子（§92）。version.json と突合して新デプロイを検知する。
    __BUILD_ID__: JSON.stringify(buildId),
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // フォント等を data: URI にインライン化しない（厳格 CSP は font-src(=default-src 'self')
    // で data: を不許可 → インライン woff が全ブロックされるため）。実ファイル配信に統一。
    assetsInlineLimit: 0,
  },
  plugins: [dataPlugin],
})
