/* global document, localStorage */
// page.evaluate / addInitScript のコールバックはブラウザ文脈で実行されるため
// document / localStorage を参照する（Node 側では未定義で正しい）。
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.SHOT_BASE ?? 'http://localhost:4179/'
const OUT = 'preview-shots'
mkdirSync(OUT, { recursive: true })

const shots = [
  { name: 'top_dark_1280', theme: 'dark', width: 1280, height: 900 },
  { name: 'top_dark_390', theme: 'dark', width: 390, height: 844 },
  { name: 'top_light_1280', theme: 'light', width: 1280, height: 900 },
  { name: 'top_light_390', theme: 'light', width: 390, height: 844 },
]

const browser = await chromium.launch()

for (const s of shots) {
  const ctx = await browser.newContext({
    viewport: { width: s.width, height: s.height },
    deviceScaleFactor: 2,
  })
  // theme-init.js が読む localStorage を、ページスクリプト実行前に注入
  await ctx.addInitScript((theme) => {
    localStorage.setItem('nico-danime-theme', theme)
  }, s.theme)

  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: 'networkidle' })

  // TOP10 のカード画像が「実際に」ロード完了するまで待つ（最大の検証点）
  await page.waitForSelector('.top10-rail .series-card .card-img')
  // lazy 画像を起こすためレールを端まで一往復スクロール
  await page.evaluate(async () => {
    const rail = document.querySelector('.top10-rail')
    if (!rail) return
    rail.scrollLeft = rail.scrollWidth
    await new Promise((r) => setTimeout(r, 400))
    rail.scrollLeft = 0
    await new Promise((r) => setTimeout(r, 200))
  })
  await page.waitForFunction(
    () => {
      const imgs = Array.from(document.querySelectorAll('.top10-rail .card-img'))
      if (imgs.length === 0) return false
      const done = imgs.filter((im) => im.complete && im.naturalWidth > 0)
      return done.length >= Math.min(2, imgs.length)
    },
    null,
    { timeout: 15000 }
  )
  await page.waitForTimeout(300)
  const stats = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('.top10-rail .card-img'))
    return {
      total: imgs.length,
      ok: imgs.filter((im) => im.complete && im.naturalWidth > 0).length,
      firstSrc: imgs[0]?.currentSrc || imgs[0]?.src || null,
      firstNatural: imgs[0] ? `${imgs[0].naturalWidth}x${imgs[0].naturalHeight}` : null,
    }
  })
  console.log(
    `[${s.name}] images ${stats.ok}/${stats.total} loaded; first=${stats.firstNatural} ${stats.firstSrc}`
  )

  await page.screenshot({ path: `${OUT}/${s.name}.png`, fullPage: false })
  await ctx.close()
}

await browser.close()
console.log('done')
