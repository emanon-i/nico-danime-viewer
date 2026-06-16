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

    const dataReadyP = page.waitForResponse(
      (r) => r.url().includes('works.json') || r.url().includes('ranking.json'),
      { timeout: 30000 }
    )
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await dataReadyP.catch(() => {})

    await page
      .waitForFunction(() => document.querySelectorAll('.series-card').length > 0, {
        timeout: 15000,
      })
      .catch(() => {})

    await page.waitForTimeout(500)

    const out = join(OUT_DIR, `${s.name}.png`)
    await page.screenshot({ path: out, fullPage: false })
    console.log(`  saved: ${out}`)
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
