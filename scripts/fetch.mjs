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
  syncSeriesThumbnails,
  getMetaState,
  updateMetaState,
} from './db/db.mjs'

import { fetchAllBranchEpisodes, fetchSnapshotVersion } from './nico/snapshot.mjs'
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
import {
  mapCurrentCours,
  makeCoursLabel,
  parsePeriodHtml,
  matchPeriodEntriesToSeries,
  deriveCoursFromTags,
} from './etl/cours.mjs'
import { fetchPeriodHtml, enumeratePastSeasons } from './nico/period.mjs'
import { recalcSeriesMetrics } from './etl/metrics.mjs'
import { exportAll } from './export/export.mjs'
import { selfHealEmptySeries } from './backfill.mjs'

import { logger } from './lib/logger.mjs'

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../data')
const DB_PATH = join(DATA_DIR, 'build.sqlite')

// CLI 引数解析
const CLI_ARGS = process.argv.slice(2)
const CLI_MODE = CLI_ARGS.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? 'full'
const CLI_CHECK_VERSION = CLI_ARGS.includes('--check-version')

/** 現在の日付から季節を返す */
function currentSeason(date) {
  const m = new Date(date).getMonth() + 1
  if (m <= 3) return 'winter'
  if (m <= 6) return 'spring'
  if (m <= 9) return 'summer'
  return 'autumn'
}

// 過去季クールを遡る下限の年（dアニメ支店の配信開始相当）。環境変数で調整可。
const COURS_FROM_YEAR = Number(process.env.NICO_COURS_FROM_YEAR ?? 2016)
// slug↔series 突合の採用しきい値（タイトル正規化マッチの信頼度）
const COURS_MATCH_MIN = 0.7

/**
 * 過去季クールを period HTML から配線して series.cours を埋める（§10.3）。
 * 現行季（programlist で設定済み）や既に cours を持つシリーズは上書きしない。
 * 新しい季から処理し、ネットワーク/パースのエラーは季単位でスキップ（fail させない）。
 * @returns {Promise<{ seasons: number, assigned: number }>}
 */
async function derivePastCours(db, now) {
  // 既に cours を持つシリーズ（現行季 programlist 由来等）は対象外＝上書きしない
  const assigned = new Set(
    db
      .prepare('SELECT series_id FROM series WHERE cours IS NOT NULL AND is_available = 1')
      .all()
      .map((r) => r.series_id)
  )
  // series_id → title（突合用）
  const seriesMap = new Map(
    db
      .prepare('SELECT series_id, title FROM series WHERE is_available = 1')
      .all()
      .map((r) => [r.series_id, r.title])
  )

  const seasons = enumeratePastSeasons(new Date(now), COURS_FROM_YEAR)
  let assignedCount = 0
  let seasonsWithData = 0

  for (const { year, season } of seasons) {
    let html = null
    try {
      const res = await fetchPeriodHtml(year, season)
      if (res.status !== 200 || !res.body) continue
      html = res.body
    } catch (err) {
      logger.warn('fetch', 'period fetch failed (skip season)', {
        year,
        season,
        error: err.message,
      })
      continue
    }

    let parsed
    try {
      parsed = parsePeriodHtml(html, `${year}-${season}`)
    } catch {
      continue
    }
    // 支店ページの妥当性（変更検知）。崩れていたらこの季はスキップ
    if (!parsed.title.includes('dアニメストア') || parsed.slugs.length < 1) continue
    seasonsWithData++

    const coursLabel = makeCoursLabel(year, season)
    // アンカーの日本語タイトルで突合（slug 突合より高精度・高 recall）
    const matches = matchPeriodEntriesToSeries(parsed.entries, seriesMap)
    let seasonAssigned = 0
    for (const m of matches) {
      if (m.seriesId == null || m.confidence < COURS_MATCH_MIN) continue
      if (assigned.has(m.seriesId)) continue
      updateSeriesFields(db, m.seriesId, { cours: coursLabel, updated_at: now })
      assigned.add(m.seriesId)
      assignedCount++
      seasonAssigned++
    }
    logger.info('fetch', 'period season done', {
      cours: coursLabel,
      entries: parsed.entries.length,
      assigned: seasonAssigned,
    })
  }

  return { seasons: seasonsWithData, assigned: assignedCount }
}

/**
 * クール付与パイプライン（§14）。**主源＝タグ導出**（放送季・追加 fetch 不要・高 recall）、
 * 欠落分を programlist（今季）→ period 日本語タイトル突合で補完する。
 */
async function runCoursPipeline(db, now) {
  // 0. クリア（再生成のたび作り直す）
  db.prepare('UPDATE series SET cours = NULL WHERE is_available = 1').run()

  // 1. 主源＝第1話タグの「YYYY年<季>アニメ」から放送季を導出
  const tagMap = deriveCoursFromTags(db)
  for (const [id, cours] of tagMap) updateSeriesFields(db, id, { cours, updated_at: now })
  logger.info('fetch', 'E3 cours from tags (primary)', { count: tagMap.size })

  // 2. 補完＝今季 programlist（タグに季が無い作品のみ）
  const programlist = await fetchProgramlist()
  const coursLabel = makeCoursLabel(new Date(now).getFullYear(), currentSeason(now))
  const curMap = mapCurrentCours(programlist, coursLabel)
  const fillStmt = db.prepare(
    'UPDATE series SET cours = ?, updated_at = ? WHERE series_id = ? AND cours IS NULL AND is_available = 1'
  )
  let curAdded = 0
  for (const [id] of curMap) curAdded += fillStmt.run(coursLabel, now, id).changes
  logger.info('fetch', 'E3b cours from programlist (fill)', { added: curAdded })

  // 3. 補完＝period 日本語タイトル突合（さらに欠落分・derivePastCours は cours NULL のみ埋める）
  const pastCours = await derivePastCours(db, now)
  logger.info('fetch', 'E3c cours from period (fill)', pastCours)
}

/** --check-version: snapshot/version の last_modified を取得して終了 */
async function checkVersion() {
  mkdirSync(DATA_DIR, { recursive: true })
  const db = openDatabase(DB_PATH)
  createSchema(db)
  const meta = getMetaState(db)
  const remoteVersion = await fetchSnapshotVersion()
  logger.info('check-version', 'snapshot version', {
    stored: meta.snapshot_version_last_modified ?? null,
    remote: remoteVersion,
  })
}

/** --mode=export-only: Phase E/F/G のみ（スクショ確認・部分データ用） */
async function runExportOnly() {
  mkdirSync(DATA_DIR, { recursive: true })
  const db = openDatabase(DB_PATH)
  createSchema(db)
  const now = new Date().toISOString()

  logger.info('fetch', 'phase E: ETL derivation (export-only)')

  const overviews = deriveSeriesOverviews(db)
  for (const { seriesId, descriptionFirst } of overviews) {
    if (descriptionFirst) {
      updateSeriesFields(db, seriesId, { description_first: descriptionFirst, updated_at: now })
    }
  }
  logger.info('fetch', 'E1 overviews done', { count: overviews.length })

  const seriesTags = deriveSeriesTags(db)
  for (const { seriesId, tags } of seriesTags) {
    if (tags.length > 0) replaceSeriesTags(db, seriesId, tags)
  }
  logger.info('fetch', 'E2 tags done', { count: seriesTags.length })

  await runCoursPipeline(db, now)

  const seriesTagsMap = getSeriesTagsMap(db)
  const titleMap = new Map(
    db
      .prepare('SELECT series_id, title FROM series WHERE is_available = 1')
      .all()
      .map((r) => [r.series_id, r.title])
  )
  const franchiseKeys = computeFranchiseKeys(seriesTagsMap, titleMap)
  db.prepare('UPDATE series SET franchise_key = NULL').run()
  for (const [seriesId, franchiseKey] of franchiseKeys) {
    updateSeriesFields(db, seriesId, { franchise_key: franchiseKey, updated_at: now })
  }
  logger.info('fetch', 'E4 franchise keys done', { count: franchiseKeys.size })

  syncSeriesTimestamps(db)
  syncSeriesThumbnails(db)
  logger.info('fetch', 'E6 thumbnails synced')

  logger.info('fetch', 'phase F: metrics')
  recalcSeriesMetrics(db, now)

  createIndexes(db)
  logger.info('fetch', 'phase G: export')
  exportAll(db, DATA_DIR, now)

  logger.info('fetch', 'export-only done', { now })
}

/** --mode=hourly: Phase D (RSS) + export のみ */
async function runHourly() {
  mkdirSync(DATA_DIR, { recursive: true })
  const db = openDatabase(DB_PATH)
  createSchema(db)
  const meta = getMetaState(db)
  const now = new Date().toISOString()

  // ── Phase D: RSS 新着 ────────────────────────────────────────────────────
  logger.info('fetch', 'phase D: RSS (hourly)')
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

  // ── Phase G: Export（new.json のみ） ─────────────────────────────────────
  createIndexes(db)
  logger.info('fetch', 'phase G: export (hourly)')
  exportAll(db, DATA_DIR, now)
  logger.info('fetch', 'hourly done', { now })
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
  await runCoursPipeline(db, now)

  // E4: Franchise keys（共有タグ束ね）
  const seriesTagsMap = getSeriesTagsMap(db)
  const titleMap = new Map(
    db
      .prepare('SELECT series_id, title FROM series WHERE is_available = 1')
      .all()
      .map((r) => [r.series_id, r.title])
  )
  const franchiseKeys = computeFranchiseKeys(seriesTagsMap, titleMap)
  db.prepare('UPDATE series SET franchise_key = NULL').run()
  for (const [seriesId, franchiseKey] of franchiseKeys) {
    updateSeriesFields(db, seriesId, { franchise_key: franchiseKey, updated_at: now })
  }
  logger.info('fetch', 'E4 franchise keys done', { count: franchiseKeys.size })

  // E5: Sync timestamps
  syncSeriesTimestamps(db)

  // E6: Sync series thumbnails from episodes
  syncSeriesThumbnails(db)
  logger.info('fetch', 'E6 thumbnails synced')

  // E7: self-heal（任意・§85）。0話シリーズ（snapshot 取得漏れ）が残っていれば nvapi で
  // reseed を試みる。nvapi 逐次取得で重くなりうるため既定 OFF＝--self-heal / NICO_SELF_HEAL=1
  // で有効、--self-heal-limit= / NICO_SELF_HEAL_LIMIT= で 1 回の件数上限を絞れる。
  if (CLI_ARGS.includes('--self-heal') || process.env.NICO_SELF_HEAL === '1') {
    const limit =
      Number(
        CLI_ARGS.find((a) => a.startsWith('--self-heal-limit='))?.split('=')[1] ??
          process.env.NICO_SELF_HEAL_LIMIT ??
          0
      ) || undefined
    logger.info('fetch', 'E7 self-heal empty series', { limit: limit ?? 'all' })
    await selfHealEmptySeries(db, { limit })
  }

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

const runner = CLI_CHECK_VERSION
  ? checkVersion()
  : CLI_MODE === 'hourly'
    ? runHourly()
    : CLI_MODE === 'export-only'
      ? runExportOnly()
      : main()
runner.catch((err) => {
  logger.error('fetch', err.message, err.assertFields ?? {})
  process.exit(1)
})
