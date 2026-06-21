/**
 * 再プロジェクション（ネットワーク取得なし）。
 *
 * data/state + data/series から Store を再構築し、修正後の chronoSort / firstAt 定義で
 *   - series/*.json（各話を新しい話順で並べ直す）
 *   - descriptionFirst（chronoSort 最古話＝真の第1話のあらすじ）
 *   - works.json / ranking.json / tags.json / cours.json / kana.json / new.json
 * を再生成する。state/prev-views.json 等の delta 基準は触らない（次回 fetch の delta を保全）。
 *
 * 使い方: node scripts/reproject.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  loadStore,
  writeSeriesFiles,
  updateSeries,
  chronoSort,
} from './store/store.mjs'
import { deriveSeriesOverviewsFromStore } from './etl/series.mjs'
import { projectAll } from './store/project.mjs'

const DATA_DIR = process.env.DATA_DIR ?? 'data'

function readLastUpdated() {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, 'works.json'), 'utf-8')).lastUpdated
  } catch {
    return new Date().toISOString()
  }
}

async function main() {
  const lastUpdated = readLastUpdated()
  console.log('[reproject] loadStore...')
  const store = await loadStore(DATA_DIR)
  console.log(`[reproject] series=${store.series.size} episodes=${store.episodes.size}`)

  // descriptionFirst を新 chronoSort（真の第1話）で再導出
  const overviews = deriveSeriesOverviewsFromStore(store, chronoSort)
  for (const { seriesId, descriptionFirst } of overviews) {
    if (descriptionFirst) updateSeries(store, seriesId, { descriptionFirst })
  }
  console.log(`[reproject] overviews re-derived: ${overviews.length}`)

  // 全 series/*.json を新しい話順で書き直す
  await writeSeriesFiles(store, DATA_DIR, [...store.series.keys()])
  console.log('[reproject] series files rewritten')

  // 配信 JSON を再生成（firstAt = MIN(startTime) で works.json 更新）
  await projectAll(store, DATA_DIR, lastUpdated, lastUpdated)
  console.log('[reproject] projection JSON regenerated; lastUpdated=' + lastUpdated)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
