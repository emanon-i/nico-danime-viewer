// scripts/screenshot.mjs
// ローカルプレビューの主要画面をスクショ（確認用）
// 使い方: node scripts/screenshot.mjs <baseUrl>

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '../preview-shots')
mkdirSync(OUT_DIR, { recursive: true })

const BASE_URL = process.argv[2] ?? 'http://localhost:4173'

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
]

async function shot(page, name) {
  const out = join(OUT_DIR, `${name}.png`)
  await page.screenshot({ path: out, fullPage: false })
  console.log(`saved: ${out}`)
  return out
}

async function main() {
  const browser = await chromium.launch()
  const saved = []

  // ranking.json から最初の popular seriesId を取得
  let firstSeriesId = null
  try {
    const res = await fetch(`${BASE_URL}/data/ranking.json`)
    const json = await res.json()
    firstSeriesId = json?.popular?.[0]?.seriesId ?? json?.hot?.[0]?.seriesId ?? null
    console.log(`詳細に使う seriesId: ${firstSeriesId}`)
  } catch (e) {
    console.warn('ranking.json 取得失敗:', e.message)
  }

  // cours.json から最初のクール
  let firstCours = null
  try {
    const res = await fetch(`${BASE_URL}/data/cours.json`)
    const json = await res.json()
    firstCours = json?.cours?.[0]?.cours ?? null
    console.log(`一覧絞り込みクール: ${firstCours}`)
  } catch (e) {
    console.warn('cours.json 取得失敗:', e.message)
  }

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
    })
    const page = await ctx.newPage()

    // ── トップ画面 ──────────────────────────────────────────
    console.log(`[${vp.name}] トップ画面...`)
    const topResponseP = page.waitForResponse((r) => r.url().includes('works.json'), {
      timeout: 30000,
    })
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await topResponseP.catch(() => {})
    // カードが出るまで待つ
    await page
      .waitForFunction(() => document.querySelectorAll('.series-card').length > 0, {
        timeout: 10000,
      })
      .catch(() => {})
    await page.waitForTimeout(300)
    saved.push(await shot(page, `01_top_${vp.name}`))

    // ── 一覧画面（クール絞り込み） ────────────────────────
    console.log(`[${vp.name}] 一覧画面 (${firstCours ?? 'all'})...`)
    const listResponseP = page.waitForResponse((r) => r.url().includes('works.json'), {
      timeout: 30000,
    })
    const listUrl = firstCours
      ? `${BASE_URL}?screen=list&cours=${encodeURIComponent(firstCours)}`
      : `${BASE_URL}?screen=list`
    await page.goto(listUrl, { waitUntil: 'domcontentloaded' })
    await listResponseP.catch(() => {})
    await page
      .waitForFunction(() => document.querySelectorAll('.series-card').length > 0, {
        timeout: 15000,
      })
      .catch(() => {})
    // グリッドが画面外の場合はスクロール
    await page.evaluate(() => {
      const grid = document.querySelector('.list-grid')
      if (grid) grid.scrollIntoView({ block: 'start' })
    })
    await page.waitForTimeout(300)
    saved.push(await shot(page, `02_list_${vp.name}`))

    // ── 作品詳細（series/{id}.json を待つ） ────────────────
    console.log(`[${vp.name}] 詳細画面 (series=${firstSeriesId})...`)
    const detailUrl = firstSeriesId
      ? `${BASE_URL}?screen=detail&series=${firstSeriesId}`
      : `${BASE_URL}?screen=detail&series=555661`
    // series/{id}.json のロード完了を待ってからページへ遷移
    const seriesResponseP = page.waitForResponse(
      (r) => r.url().includes('/data/series/') && r.url().endsWith('.json'),
      { timeout: 30000 }
    )
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded' })
    await seriesResponseP.catch((e) => console.warn('series/{id}.json タイムアウト:', e.message))
    // データ反映を待つ
    await page
      .waitForFunction(
        () =>
          document.querySelector('[data-section="episodes"]') !== null ||
          document.querySelector('.detail-unavailable') !== null,
        { timeout: 10000 }
      )
      .catch(() => {})
    await page.waitForTimeout(300)
    saved.push(await shot(page, `03_detail_${vp.name}`))

    await ctx.close()
  }

  await browser.close()

  console.log('\n=== スクショ完了 ===')
  for (const p of saved) console.log(p)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
