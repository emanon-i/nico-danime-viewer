// scripts/fetch.mjs
// pnpm fetch エントリポイント: 全データソース取得 → ETL → 静的 JSON export
//
// 環境変数:
//   NICO_USER_AGENT  問い合わせ先を含む UA 文字列（省略可・デフォルト値あり）

import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  openDatabase,
  createSchema,
  createIndexes,
  bulkUpsertEpisodes,
  bulkUpsertSeries,
  bulkUpsertRssItems,
  updateSeriesFields,
  updateEpisodeOrderBatch,
  replaceSeriesTags,
  syncSeriesTimestamps,
  getMetaState,
  updateMetaState,
} from './db/db.mjs'

import { fetchAllBranchEpisodes } from './nico/snapshot.mjs'
import { assertSnapshotOk } from './nico/assert.mjs'
import { fetchListJson, fetchProgramlist } from './nico/list.mjs'
import { seedAllSeries, mapNvapiItems } from './nico/nvapi.mjs'
import {
  fetchRss,
  parseRssXml,
  filterNewRssItems,
  assertRssOk,
  extractWatchId,
  resolveRssItems,
} from './nico/rss.mjs'

import { deriveSeriesTags } from './etl/tags.mjs'
import {
  extractSeriesIdFromUrl,
  deriveSeriesOverviews,
  getSeriesTagsMap,
  computeFranchiseKeys,
} from './etl/series.mjs'
import { mapCurrentCours, makeCoursLabel } from './etl/cours.mjs'
import { recalcSeriesMetrics } from './etl/metrics.mjs'
import { exportAll } from './export/export.mjs'

import { logger } from './lib/logger.mjs'

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../data')
const DB_PATH = join(DATA_DIR, 'build.sqlite')

/** 現在の日付から季節を返す */
function currentSeason(date) {
  const m = new Date(date).getMonth() + 1
  if (m <= 3) return 'winter'
  if (m <= 6) return 'spring'
  if (m <= 9) return 'summer'
  return 'autumn'
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true })

  const db = openDatabase(DB_PATH)
  createSchema(db)
  const meta = getMetaState(db)
  const now = new Date().toISOString()

  // ── Phase A: Snapshot ──────────────────────────────────────────────────────
  logger.info('fetch', 'phase A: snapshot')
  const storedVersion = meta.snapshot_version_last_modified ?? null
  const snapResult = await fetchAllBranchEpisodes(storedVersion)

  if (!snapResult.skipped) {
    const { episodes, newVersion } = snapResult
    assertSnapshotOk({ meta: { status: 200, totalCount: episodes.length }, data: episodes }, null)
    bulkUpsertEpisodes(db, episodes, now)
    updateMetaState(db, { snapshot_version_last_modified: newVersion })
    logger.info('fetch', 'snapshot done', { count: episodes.length })
  } else {
    logger.info('fetch', 'snapshot version unchanged, skipping')
  }

  // ── Phase B: list.json → col_key + series 登録 + is_available 同期 ──────
  logger.info('fetch', 'phase B: list.json')
  const listJson = await fetchListJson()
  const seriesFromList = []
  const colKeyUpdates = []

  for (const item of listJson) {
    const seriesId = extractSeriesIdFromUrl(item.url)
    if (!seriesId) continue
    seriesFromList.push({ seriesId, title: item.title })
    colKeyUpdates.push({ seriesId, col_key: item.col_key })
  }

  // list.json 外のシリーズ（配信終了）を一旦 is_available=0 に
  db.prepare('UPDATE series SET is_available = 0').run()
  // 現行リストのシリーズを upsert（ON CONFLICT で is_available=1 に戻す）
  bulkUpsertSeries(db, seriesFromList, now)
  for (const { seriesId, col_key } of colKeyUpdates) {
    if (col_key) updateSeriesFields(db, seriesId, { col_key, updated_at: now })
  }
  logger.info('fetch', 'list.json done', { count: seriesFromList.length })

  // ── Phase C: nvapi seed（初回 or 週次）────────────────────────────────────
  // 初回または前回から7日以上経過したら全シリーズ再シード（ToS: 逐次・最小500ms待機）
  const daysSinceRefresh = meta.last_full_refresh_at
    ? (Date.now() - new Date(meta.last_full_refresh_at).getTime()) / 86400000
    : Infinity

  if (daysSinceRefresh >= 7) {
    logger.info('fetch', 'phase C: nvapi seed', { total: colKeyUpdates.length, daysSinceRefresh })
    const seriesIds = colKeyUpdates.map((u) => u.seriesId)

    await seedAllSeries(seriesIds, async (seriesId, data) => {
      const updates = mapNvapiItems(seriesId, data.items)
      if (updates.length > 0) updateEpisodeOrderBatch(db, updates)
    })
  } else {
    logger.info('fetch', 'phase C: nvapi seed skipped', {
      daysSinceRefresh: Math.round(daysSinceRefresh),
    })
  }

  // ── Phase D: RSS 新着 ──────────────────────────────────────────────────────
  logger.info('fetch', 'phase D: RSS')
  const rssResult = await fetchRss()

  if (rssResult.status === 200 && rssResult.body) {
    const { channelTitle, items } = parseRssXml(rssResult.body)
    assertRssOk(items, channelTitle)

    const newItems = filterNewRssItems(items, meta.rss_last_guid ?? null)
    const rssRows = newItems
      .map((item) => {
        const watchId = extractWatchId(item.link)
        if (!watchId) return null
        return {
          watchId,
          guid: item.guid ?? null,
          pubDate: item.pubDate ?? null,
          title: item.title ?? null,
          titleNorm: null,
          link: item.link ?? null,
        }
      })
      .filter(Boolean)

    if (rssRows.length > 0) {
      bulkUpsertRssItems(db, rssRows)
      resolveRssItems(db)
      logger.info('fetch', 'RSS new items inserted', { count: rssRows.length })
    }

    const newLastGuid = items[0]?.guid ?? meta.rss_last_guid
    if (newLastGuid) updateMetaState(db, { rss_last_guid: newLastGuid })
  } else if (rssResult.status === 304) {
    logger.info('fetch', 'RSS 304 not modified, skipping')
  }

  // ── Phase E: ETL 派生 ──────────────────────────────────────────────────────
  logger.info('fetch', 'phase E: ETL derivation')

  // E1: Series overviews (第1話あらすじ)
  const overviews = deriveSeriesOverviews(db)
  for (const { seriesId, descriptionFirst } of overviews) {
    if (descriptionFirst) {
      updateSeriesFields(db, seriesId, { description_first: descriptionFirst, updated_at: now })
    }
  }
  logger.info('fetch', 'E1 series overviews done', { count: overviews.length })

  // E2: Tags（第1話からシリーズ代表タグを導出）
  const seriesTags = deriveSeriesTags(db)
  for (const { seriesId, tags } of seriesTags) {
    if (tags.length > 0) replaceSeriesTags(db, seriesId, tags)
  }
  logger.info('fetch', 'E2 series tags done', { count: seriesTags.length })

  // E3: Cours（今季は programlist.json）
  const programlist = await fetchProgramlist()
  const season = currentSeason(now)
  const year = new Date(now).getFullYear()
  const coursLabel = makeCoursLabel(year, season)
  const coursMap = mapCurrentCours(programlist, coursLabel)
  for (const [seriesId, cours] of coursMap) {
    updateSeriesFields(db, seriesId, { cours, updated_at: now })
  }
  logger.info('fetch', 'E3 cours done', { label: coursLabel, count: coursMap.size })

  // E4: Franchise keys（共有タグ束ね）
  const seriesTagsMap = getSeriesTagsMap(db)
  const franchiseKeys = computeFranchiseKeys(seriesTagsMap)
  for (const [seriesId, franchiseKey] of franchiseKeys) {
    updateSeriesFields(db, seriesId, { franchise_key: franchiseKey, updated_at: now })
  }
  logger.info('fetch', 'E4 franchise keys done', { count: franchiseKeys.size })

  // E5: Sync timestamps
  syncSeriesTimestamps(db)

  // ── Phase F: Metrics（Hot score 再計算）────────────────────────────────────
  logger.info('fetch', 'phase F: metrics')
  recalcSeriesMetrics(db, now)

  // ── Phase G: Indexes + Export ──────────────────────────────────────────────
  createIndexes(db)
  logger.info('fetch', 'phase G: export')
  exportAll(db, DATA_DIR, now)

  // 最終状態を保存
  updateMetaState(db, { last_full_refresh_at: now })
  logger.info('fetch', 'all done', { now })
}

main().catch((err) => {
  logger.error('fetch', err.message, err.assertFields ?? {})
  process.exit(1)
})
