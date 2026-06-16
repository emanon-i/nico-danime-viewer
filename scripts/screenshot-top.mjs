// トップ画面 4 枚スクショ: dark/light × 1280/390
// 使い方: node scripts/screenshot-top.mjs [baseUrl]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '../preview-shots')
mkdirSync(OUT_DIR, { recursive: true })

const BASE_URL = process.argv[2] ?? 'http://localhost:4173'

const SHOTS = [
  { name: 'top_dark_1280', theme: 'dark', width: 1280, height: 800 },
  { name: 'top_dark_390', theme: 'dark', width: 390, height: 844 },
  { name: 'top_light_1280', theme: 'light', width: 1280, height: 800 },
  { name: 'top_light_390', theme: 'light', width: 390, height: 844 },
]

async function main() {
  const browser = await chromium.launch()
  const saved = []

  for (const s of SHOTS) {
    console.log(`[${s.name}] ...`)
    const ctx = await browser.newContext({
      viewport: { width: s.width, height: s.height },
    })

    // localStorage でテーマをセット
    await ctx.addInitScript(
      ([key, val]) => {
        localStorage.setItem(key, val)
      },
      ['nico-danime-theme', s.theme]
    )

    const page = await ctx.newPage()

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })

    // データ取得 & カード描画を待つ
    await page
      .waitForFunction(() => document.querySelectorAll('.series-card').length > 0, {
        timeout: 20000,
      })
      .catch(() => {})

    // lazy-load 解除: loading 属性を eager に変えてから src を再セット
    await page.evaluate(() => {
      document.querySelectorAll('img[loading="lazy"]').forEach((img) => {
        img.loading = 'eager'
        if (img.src) {
          const src = img.src
          img.src = ''
          img.src = src
        }
      })
    })

    // カードレールをスクロールして lazy img をトリガー
    const rail = page.locator('.top10-rail').first()
    if (await rail.isVisible().catch(() => false)) {
      await rail.evaluate((el) => {
        el.scrollLeft = el.scrollWidth
      })
      await page.waitForTimeout(200)
      await rail.evaluate((el) => {
        el.scrollLeft = 0
      })
    }

    // ネットワーク待機（画像読み込み完了）
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})

    // img.complete を全件確認（最大 5 秒待機）
    await page
      .waitForFunction(
        () => {
          const imgs = Array.from(document.querySelectorAll('.series-card img'))
          return imgs.length > 0 && imgs.every((img) => img.complete)
        },
        { timeout: 8000 }
      )
      .catch(() => {})

    await page.waitForTimeout(300)

    const out = join(OUT_DIR, `${s.name}.png`)
    await page.screenshot({ path: out, fullPage: false })
    console.log(`  saved: ${out}`)

    // サムネ表示件数を確認
    const thumbOk = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('.series-card img'))
      return {
        total: imgs.length,
        loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
        broken: imgs.filter((i) => i.complete && i.naturalWidth === 0 && i.src).length,
      }
    })
    console.log(`  thumbnails: ${thumbOk.loaded}/${thumbOk.total} loaded, ${thumbOk.broken} broken`)

    saved.push(out)
    await ctx.close()
  }

  await browser.close()

  console.log('\n=== スクショ完了 ===')
  saved.forEach((p) => console.log(p))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
