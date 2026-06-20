// scripts/fetch.mjs
// pnpm fetch エントリポイント: 全データソース取得 → ETL → 静的 JSON export
//
// 環境変数:
//   NICO_USER_AGENT  問い合わせ先を含む UA 文字列（省略可・デフォルト値あり）

import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs'
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
import { fetchListJson } from './nico/list.mjs'
import { fetchSeriesData, seedAllSeries, mapNvapiItems, mapNvapiEpisodes } from './nico/nvapi.mjs'
import {
  fetchRss,
  fetchRssMultiPage,
  parseRssXml,
  filterNewRssItems,
  assertRssOk,
  extractWatchId,
  resolveRssItems,
} from './nico/rss.mjs'
import { fetchWatchSeriesInfo } from './nico/watch.mjs'

import { deriveSeriesTags } from './etl/tags.mjs'
import { deriveSeriesTagsFromStore } from './etl/tags.mjs'
import {
  extractSeriesIdFromUrl,
  deriveSeriesOverviews,
  getSeriesTagsMap,
  computeFranchiseKeys,
  deriveSeriesOverviewsFromStore,
  getSeriesTagsMapFromStore,
} from './etl/series.mjs'
import {
  makeCoursLabel,
  parsePeriodHtml,
  matchPeriodEntriesToSeries,
  deriveCoursFromTags,
  deriveCoursFromTagsFromStore,
} from './etl/cours.mjs'
import { fetchPeriodHtml, enumeratePastSeasons } from './nico/period.mjs'
import { recalcSeriesMetrics } from './etl/metrics.mjs'
import { exportAll } from './export/export.mjs'
import { selfHealEmptySeries } from './backfill.mjs'

import { logger } from './lib/logger.mjs'

// ── Store ベース（M3/M4）─────────────────────────────────────────────────────
import {
  loadStore,
  loadPartialStore,
  writeBackStore,
  writeSeriesFiles,
  upsertEpisodes as storeUpsertEps,
  upsertSeries as storeUpsertSeries,
  updateSeries as storeUpdateSeries,
  syncSeriesThumbnails as storeSyncThumbs,
  syncSeriesTimestamps as storeSyncTimestamps,
  updateMetaState as storeUpdateMeta,
  upsertRssItems as storeUpsertRss,
  updateRssResolution as storeUpdateRssResolution,
  replaceSeriesTags as storeReplaceSeriesTags,
  countSeriesWithEpisodes,
  chronoSort,
} from './store/store.mjs'
import { projectAll, exportNew as exportNewStore } from './store/project.mjs'

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../data')
const DB_PATH = join(DATA_DIR, 'build.sqlite')

// CLI 引数解析
const CLI_ARGS = process.argv.slice(2)
const CLI_MODE = CLI_ARGS.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? 'full'
const CLI_CHECK_VERSION = CLI_ARGS.includes('--check-version')

// 過去季クールを遡る下限の年（dアニメ支店の配信開始相当）。環境変数で調整可。
const COURS_FROM_YEAR = Number(process.env.NICO_COURS_FROM_YEAR ?? 2016)

/**
 * 回帰ガード（§G）：export 前に「DB の各話あり series 数」が、既存 works.json（＝直近の
 * 完全データ baseline）より大きく減っていないか検査する。部分的/不完全な build.sqlite
 * （cache の取りこぼし・nvapi 未紐付けで各話が孤児化 等）から痩せた JSON を生成して
 * deploy/state 上書きする回帰を防ぐ。閾値以上減るなら export/deploy を中止すべき＝true。
 * @returns {{ dbEp0:number, baseline:number, shrink:boolean }}
 */
function detectShrink(db, dataDir, threshold = 0.9) {
  const dbEp0 = db
    .prepare('SELECT COUNT(DISTINCT series_id) AS c FROM episodes WHERE series_id IS NOT NULL')
    .get().c
  let baseline = 0
  try {
    const w = JSON.parse(readFileSync(join(dataDir, 'works.json'), 'utf-8'))
    baseline = (w.works ?? []).filter((x) => (x.episodeCount ?? 0) > 0).length
  } catch {
    /* works.json が無ければ baseline 0＝比較しない（初回） */
  }
  return { dbEp0, baseline, shrink: baseline > 0 && dbEp0 < Math.floor(baseline * threshold) }
}
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

  // 2. 補完＝今季 programlist（廃止 → スキップ）

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

  // 空DBガード（§D 修正）：build.sqlite の cache miss 等で series が空なら、新着解決も
  // export もできない（exportAll で空 JSON を state に上書きしてしまう）。何もせず即終了し、
  // 復元済みの state JSON を保全する。次回 daily が cache を再生成すれば回復する。
  const seriesCount = db.prepare('SELECT COUNT(*) AS c FROM series').get().c
  if (seriesCount === 0) {
    logger.warn('fetch', 'hourly: empty DB (sqlite cache miss?) → skip export/deploy', {})
    db.close()
    return
  }

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

  // ── Phase D2: 新規動画の即時解決（§D・新着の毎時ライブ反映）────────────────
  // まだ episode に解決できていない新着(rss_only)を、既存シリーズに title 前方一致で
  // 対応付け → そのシリーズだけ nvapi v2/series を取得して各話を挿入（§85 backfillSeries 流用）。
  // ＝新規話が再生数/投稿時間/サムネ/シリーズ紐付き付きで DB に入る。新規シリーズや舞台等で
  // 対応シリーズが無いものは rss_only 据え置き（日次 full の snapshot で回収）。
  // Phase D2: matchRssOnlyToSeries は廃止（JS 版に移行済み）
  let insertedEpisodes = 0

  // ── 回帰ガード（§G）：痩せたDBから export して state/live を縮小しないよう検査 ──
  // 既存 works.json（復元済みの完全データ）より各話あり series が大きく減るなら、export
  // 自体を行わず（＝復元済み完全データを保全）deploy もしない。cache 不完全/孤児化時の保険。
  const guard = detectShrink(db, DATA_DIR)
  if (guard.shrink) {
    logger.error(
      'fetch',
      'REGRESSION GUARD: hourly export would shrink → skip export/deploy',
      guard
    )
    db.close()
    return
  }

  // ── Phase G: Export ──────────────────────────────────────────────────────
  createIndexes(db)
  logger.info('fetch', 'phase G: export (hourly)')
  exportAll(db, DATA_DIR, now)

  // デプロイ判定フラグ（§D churn 対策）：新規話を挿入したときだけライブへ反映する。
  // 新規が無い時間は state 保存のみ＝デプロイ skip。ワークフローがこのファイル有無で分岐。
  if (insertedEpisodes > 0) {
    writeFileSync(join(DATA_DIR, '.deploy-needed'), `${insertedEpisodes}\n`)
  }
  logger.info('fetch', 'hourly done', { now, insertedEpisodes })
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
  // NICO_FORCE_SEED=1 で 7日ガードを無視して seed を強制（部分 cache を即フル紐付けに戻す用・§G）
  const forceSeed = process.env.NICO_FORCE_SEED === '1'

  if (forceSeed || daysSinceRefresh >= 7) {
    logger.info('fetch', 'phase C: nvapi seed', { total: colKeyUpdates.length, daysSinceRefresh })
    const seriesIds = colKeyUpdates.map((u) => u.seriesId)

    await seedAllSeries(seriesIds, async (seriesId, data) => {
      const updates = mapNvapiItems(seriesId, data.items)
      if (updates.length > 0) updateEpisodeOrderBatch(db, updates)
    })
    // seed が走ったときだけ最終実行時刻を更新する（§G 修正）。
    // 以前は main 末尾で毎回更新していたため daysSinceRefresh が常に ~0 となり、
    // seed が初回以降ずっと skip され各話が孤児化（→ep>0 series が痩せる）原因になっていた。
    updateMetaState(db, { last_full_refresh_at: now })
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

  // ── 回帰ガード（§G）：痩せたDBから export して live/state を縮小しないか検査 ──
  // nvapi 未紐付け（孤児化）等で各話あり series が既存 works.json より大きく減るなら、
  // export せず復元済み完全データを保全（deploy も実質フルのまま）。安全側に倒す。
  const guard = detectShrink(db, DATA_DIR)
  if (guard.shrink) {
    logger.error(
      'fetch',
      'REGRESSION GUARD: daily export would shrink → skip export (preserve full)',
      guard
    )
    logger.info('fetch', 'all done (guarded)', { now })
    return
  }

  // ── Phase F: Metrics（Hot score 再計算）────────────────────────────────────
  logger.info('fetch', 'phase F: metrics')
  recalcSeriesMetrics(db, now)

  // ── Phase G: Indexes + Export ──────────────────────────────────────────────
  createIndexes(db)
  logger.info('fetch', 'phase G: export')
  exportAll(db, DATA_DIR, now)
  logger.info('fetch', 'all done', { now })
}

// ────────────────────────────────────────────────────────────────────────────
// Store ベース shrink 検出
// ────────────────────────────────────────────────────────────────────────────

function detectShrinkFromStore(store, dataDir, threshold = 0.9) {
  const ep0 = countSeriesWithEpisodes(store)
  let baseline = 0
  try {
    const w = JSON.parse(readFileSync(join(dataDir, 'works.json'), 'utf-8'))
    baseline = (w.works ?? []).filter((x) => (x.episodeCount ?? 0) > 0).length
  } catch {
    /* works.json が無ければ baseline 0 = 比較しない（初回） */
  }
  return { ep0, baseline, shrink: baseline > 0 && ep0 < Math.floor(baseline * threshold) }
}

// ────────────────────────────────────────────────────────────────────────────
// Store ベース E3 クール（タグ主源のみ・programlist/period は廃止）
// ────────────────────────────────────────────────────────────────────────────

function runCoursFromTagsOnly(store) {
  // クリア（全シリーズの cours を null に）
  for (const s of store.series.values()) {
    if (s.cours !== null) {
      s.cours = null
      store._dirtySeries.add(s.seriesId)
    }
  }
  // 主源 = 第1話タグの「YYYY年<季>アニメ」から放送季を導出
  const tagMap = deriveCoursFromTagsFromStore(store, chronoSort)
  for (const [id, cours] of tagMap) {
    const s = store.series.get(id)
    if (s) {
      s.cours = cours
      store._dirtySeries.add(id)
    }
  }
  logger.info('fetch', '[JS] E3 cours from tags (primary)', { count: tagMap.size })
}

// ────────────────────────────────────────────────────────────────────────────
// Phase E7: isAvailable grace（snapshot 由来）
// ────────────────────────────────────────────────────────────────────────────

/**
 * lastSeenAt ＋ snapshotFetchedAt ＋ 2日猶予で isAvailable を評価する。
 * snapshotFetchedAt が 3日以上前の場合は評価しない（連続 version gate skip 保護）。
 */
function applyIsAvailableGrace(store) {
  const fetched = store.meta.snapshotFetchedAt
  if (!fetched) return
  const fetchedMs = new Date(fetched).getTime()
  const staleMs = 3 * 24 * 60 * 60 * 1000 // 3日
  const graceMs = 2 * 24 * 60 * 60 * 1000 // 2日猶予

  if (Date.now() - fetchedMs > staleMs) {
    logger.info('fetch', '[JS] E7 isAvailable grace: snapshotFetchedAt too old → skip', {
      snapshotFetchedAt: fetched,
    })
    return
  }

  const cutoff = new Date(fetchedMs - graceMs).toISOString()
  let toFalse = 0
  let toTrue = 0
  for (const s of store.series.values()) {
    const seen = s.lastSeenAt
    const shouldBeAvailable = seen != null && seen >= cutoff
    if (!shouldBeAvailable && s.isAvailable) {
      s.isAvailable = false
      store._dirtySeries.add(s.seriesId)
      toFalse++
    } else if (shouldBeAvailable && !s.isAvailable) {
      s.isAvailable = true
      store._dirtySeries.add(s.seriesId)
      toTrue++
    }
  }
  logger.info('fetch', '[JS] E7 isAvailable grace applied', { toFalse, toTrue, cutoff })
}

// ────────────────────────────────────────────────────────────────────────────
// Phase A2: 取得漏れ救出ループ
// ────────────────────────────────────────────────────────────────────────────

/**
 * snapshot で seriesId=null になった ep を最小 watch 数で救出する。
 * @param {import('./store/store.mjs').Store} store
 * @param {Set<string>} missedContentIds  救出対象 contentId（変更される）
 * @param {Map<string,number>} contentToSeries  既知の contentId→seriesId インデックス（更新される）
 */
async function rescueMissingEps(store, missedContentIds, contentToSeries) {
  if (missedContentIds.size === 0) return

  // ① series-index に既にある contentId → 直接解決（watch 不要）
  for (const cid of [...missedContentIds]) {
    const sid = contentToSeries.get(cid)
    if (sid != null) {
      const ep = store.episodes.get(cid)
      if (ep && ep.seriesId == null) {
        ep.seriesId = sid
        store._dirtySeries.add(sid)
      }
      missedContentIds.delete(cid)
    }
  }
  logger.info('fetch', '[JS] A2 direct resolve', {
    directResolved: contentToSeries.size,
    remaining: missedContentIds.size,
  })

  // ② 残りを最小 watch 数ループ: 1watch → seriesId → nvapi → Set 交差
  let watchCount = 0
  while (missedContentIds.size > 0) {
    const cid = [...missedContentIds][0]
    const info = await fetchWatchSeriesInfo(cid)
    watchCount++

    if (info === null) {
      // bot block / fetch 失敗 → スキップ（無限ループ防止のため Set から除去）
      logger.warn('fetch', '[JS] A2 watch: null (bot block?) → skip', { cid })
      missedContentIds.delete(cid)
      continue
    }

    if (!info.seriesId || info.channelId !== 'ch2632720') {
      // 本物の非シリーズ or 別チャンネル → スキップ
      logger.info('fetch', '[JS] A2 watch: no series or non-branch → skip', {
        cid,
        channelId: info.channelId,
      })
      missedContentIds.delete(cid)
      continue
    }

    const { seriesId, seriesTitle } = info

    // 新規シリーズなら Store に追加
    if (!store.series.has(seriesId)) {
      storeUpsertSeries(store, [{ seriesId, title: seriesTitle ?? '', isAvailable: true }])
    }

    // nvapi v2/series → 全話 contentId 一覧
    let nvapiData
    try {
      nvapiData = await fetchSeriesData(seriesId)
    } catch (err) {
      logger.warn('fetch', '[JS] A2 nvapi failed', { seriesId, err: err.message })
      missedContentIds.delete(cid)
      continue
    }

    const eps = mapNvapiEpisodes(seriesId, nvapiData?.items ?? [])
    storeUpsertEps(store, eps)

    const allContentIds = new Set(eps.map((e) => e.contentId))
    // 交差で同一シリーズの取得漏れを一括解決
    for (const missed of [...missedContentIds]) {
      if (allContentIds.has(missed)) {
        const ep = store.episodes.get(missed)
        if (ep && ep.seriesId == null) {
          ep.seriesId = seriesId
          store._dirtySeries.add(seriesId)
        }
        contentToSeries.set(missed, seriesId)
        missedContentIds.delete(missed)
      }
    }
    contentToSeries.set(cid, seriesId)
    // cid が nvapi の episode 一覧にない場合（削除済み等）も Set から除去して無限ループ防止
    missedContentIds.delete(cid)
  }
  logger.info('fetch', '[JS] A2 rescue done', { watchCount })
}

// ────────────────────────────────────────────────────────────────────────────
// rss.json trim（200件・oldest/resolved優先削除）
// ────────────────────────────────────────────────────────────────────────────

function _trimRss(store, maxItems = 200) {
  const all = [...store.rss.values()]
  if (all.length <= maxItems) return

  const byDate = (a, b) => {
    if (!a.pubDate && !b.pubDate) return 0
    if (!a.pubDate) return -1 // pubDate なし = 古い扱い
    if (!b.pubDate) return 1
    return a.pubDate < b.pubDate ? -1 : a.pubDate > b.pubDate ? 1 : 0
  }

  // resolved を先に削除候補に（oldest first）、続いて rss_only / unresolved（oldest first）
  const resolved = all.filter((r) => r.resolutionStatus === 'resolved').sort(byDate)
  const unresolved = all.filter((r) => r.resolutionStatus !== 'resolved').sort(byDate)
  const toDelete = [...resolved, ...unresolved].slice(0, all.length - maxItems)
  for (const r of toDelete) {
    store.rss.delete(r.watchId)
  }
  if (toDelete.length > 0) {
    logger.info('fetch', '[JS] rss trim', { deleted: toDelete.length, remaining: store.rss.size })
  }
}

// ────────────────────────────────────────────────────────────────────────────
// M3: --mode=full-js  Store ベース フルパイプライン（新設計）
// ────────────────────────────────────────────────────────────────────────────

async function runFullJS() {
  mkdirSync(DATA_DIR, { recursive: true })
  const now = new Date().toISOString()
  const stateDir = join(DATA_DIR, 'state')

  logger.info('fetch', '[JS] loadStore start')
  const store = await loadStore(DATA_DIR)
  logger.info('fetch', '[JS] loadStore done', {
    series: store.series.size,
    episodes: store.episodes.size,
    rss: store.rss.size,
  })

  // ── version gate ──────────────────────────────────────────────────────────
  const forceSnapshot = process.env.NICO_FORCE_SNAPSHOT === '1'
  if (forceSnapshot) logger.info('fetch', '[JS] NICO_FORCE_SNAPSHOT=1: version gate bypassed', {})
  const storedVersion = forceSnapshot ? null : (store.meta.snapshotVersionLastModified ?? null)
  const snapResult = await fetchAllBranchEpisodes(storedVersion)

  if (snapResult.skipped) {
    logger.info('fetch', '[JS] snapshot version unchanged → immediate exit', {
      version: storedVersion,
    })
    return
  }

  // ── prev-views.json 保存（Phase A 前・hot delta 用）───────────────────────
  {
    const prevViews = {}
    for (const ep of store.episodes.values()) {
      if (ep.prevViewCounter != null) prevViews[ep.contentId] = ep.prevViewCounter
    }
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'prev-views.json') + '.tmp', JSON.stringify(prevViews), 'utf-8')
    renameSync(join(stateDir, 'prev-views.json') + '.tmp', join(stateDir, 'prev-views.json'))
    logger.info('fetch', '[JS] prev-views.json saved', { count: Object.keys(prevViews).length })
  }

  // ── Phase A: Snapshot ─────────────────────────────────────────────────────
  logger.info('fetch', '[JS] phase A: snapshot')
  const { episodes: snapEps, newVersion } = snapResult
  assertSnapshotOk({ meta: { status: 200, totalCount: snapEps.length }, data: snapEps }, null)

  const { processEpisodeTags } = await import('./etl/tags.mjs')
  const mappedEps = snapEps.map((ep) => {
    const processedTags = processEpisodeTags(ep.tags ?? '', null)
    return {
      ...ep,
      tags: processedTags.map((t) => t.name),
      tagsCurated: processedTags.filter((t) => t.isCurated).map((t) => t.name),
    }
  })
  storeUpsertEps(store, mappedEps)

  // lastSeenAt 収集 + missedContentIds（seriesId=null の ep）
  const snapshotContentIds = new Set(mappedEps.map((ep) => ep.contentId))
  const missedContentIds = new Set()
  for (const ep of mappedEps) {
    if (store.episodes.get(ep.contentId)?.seriesId == null) {
      missedContentIds.add(ep.contentId)
    }
  }

  storeUpdateMeta(store, { snapshotVersionLastModified: newVersion, snapshotFetchedAt: now })
  logger.info('fetch', '[JS] snapshot done', {
    count: snapEps.length,
    missed: missedContentIds.size,
  })

  // ── Phase A2: 取得漏れ救出 ────────────────────────────────────────────────
  if (missedContentIds.size > 0) {
    logger.info('fetch', '[JS] phase A2: rescue missing eps', { count: missedContentIds.size })
    const contentToSeries = new Map()
    for (const ep of store.episodes.values()) {
      if (ep.seriesId != null) contentToSeries.set(ep.contentId, ep.seriesId)
    }
    await rescueMissingEps(store, missedContentIds, contentToSeries)
    logger.info('fetch', '[JS] phase A2: done', { remaining: missedContentIds.size })
  }

  // Phase A/A2 完了後: 今回の snapshot に含まれた ep の series に lastSeenAt を記録
  for (const cid of snapshotContentIds) {
    const ep = store.episodes.get(cid)
    if (ep?.seriesId != null) {
      const s = store.series.get(ep.seriesId)
      if (s && s.lastSeenAt !== now) {
        s.lastSeenAt = now
        store._dirtySeries.add(ep.seriesId)
      }
    }
  }

  // ── Phase B: list.json → col_key パッチのみ ──────────────────────────────
  logger.info('fetch', '[JS] phase B: list.json (col_key patch only)')
  const listJson = await fetchListJson()
  for (const item of listJson) {
    const seriesId = extractSeriesIdFromUrl(item.url)
    if (!seriesId || !item.col_key) continue
    const s = store.series.get(seriesId)
    if (s && s.colKey !== item.col_key) {
      s.colKey = item.col_key
      store._dirtySeries.add(seriesId)
    }
  }
  logger.info('fetch', '[JS] phase B done', { count: listJson.length })

  // ── Phase E: ETL 派生 ─────────────────────────────────────────────────────
  logger.info('fetch', '[JS] phase E: ETL derivation')

  // E1: Series overviews
  const overviews = deriveSeriesOverviewsFromStore(store, chronoSort)
  for (const { seriesId, descriptionFirst } of overviews) {
    if (descriptionFirst) storeUpdateSeries(store, seriesId, { descriptionFirst })
  }
  logger.info('fetch', '[JS] E1 overviews done', { count: overviews.length })

  // E2: Tags
  const seriesTags = deriveSeriesTagsFromStore(store)
  for (const { seriesId, tags } of seriesTags) {
    if (tags.length > 0) storeReplaceSeriesTags(store, seriesId, tags)
  }
  logger.info('fetch', '[JS] E2 series tags done', { count: seriesTags.length })

  // E3: Cours（タグ主源のみ）
  runCoursFromTagsOnly(store)

  // E4: Franchise keys
  const seriesTagsMap = getSeriesTagsMapFromStore(store)
  const titleMap = new Map()
  for (const s of store.series.values()) {
    if (s.isAvailable) titleMap.set(s.seriesId, s.title)
  }
  const franchiseKeys = computeFranchiseKeys(seriesTagsMap, titleMap)
  for (const s of store.series.values()) {
    if (s.franchiseKey !== null) {
      s.franchiseKey = null
      store._dirtySeries.add(s.seriesId)
    }
  }
  for (const [seriesId, franchiseKey] of franchiseKeys) {
    storeUpdateSeries(store, seriesId, { franchiseKey })
  }
  const byFranchise = new Map()
  for (const s of store.series.values()) {
    if (!s.franchiseKey) continue
    if (!byFranchise.has(s.franchiseKey)) byFranchise.set(s.franchiseKey, [])
    byFranchise.get(s.franchiseKey).push(s)
  }
  for (const members of byFranchise.values()) {
    for (const s of members) {
      s.relatedSeries = members
        .filter((m) => m.seriesId !== s.seriesId && m.isAvailable)
        .map((m) => ({ seriesId: m.seriesId, title: m.title, thumbnailUrl: m.thumbnailUrl }))
      store._dirtySeries.add(s.seriesId)
    }
  }
  logger.info('fetch', '[JS] E4 franchise keys done', { count: franchiseKeys.size })

  // E5: Timestamps
  storeSyncTimestamps(store)

  // E6: Thumbnails
  storeSyncThumbs(store)
  logger.info('fetch', '[JS] E6 thumbnails synced')

  // E7: isAvailable grace（snapshot 由来・lastSeenAt + snapshotFetchedAt + 2日猶予）
  applyIsAvailableGrace(store)

  // ── 回帰ガード ────────────────────────────────────────────────────────────
  const guard = detectShrinkFromStore(store, DATA_DIR)
  if (guard.shrink) {
    logger.error('fetch', '[JS] REGRESSION GUARD: full-js would shrink → skip export', guard)
    // snapshotFetchedAt / snapshotVersionLastModified だけは保全する
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'meta.json') + '.tmp', JSON.stringify(store.meta), 'utf-8')
    renameSync(join(stateDir, 'meta.json') + '.tmp', join(stateDir, 'meta.json'))
    logger.info('fetch', '[JS] all done (guarded)', { now })
    return
  }

  // ── Phase F+G: write-back + export ───────────────────────────────────────
  logger.info('fetch', '[JS] phase F+G: project all')
  await writeBackStore(store, DATA_DIR, { now })
  await projectAll(store, DATA_DIR, now)

  // 日次は常にデプロイ
  writeFileSync(join(DATA_DIR, '.deploy-needed'), 'daily\n')
  logger.info('fetch', '[JS] all done', { now, ep0: guard.ep0 })
}

// ────────────────────────────────────────────────────────────────────────────
// M4: --mode=hourly-js  Store ベース 毎時 RSS パイプライン（新設計）
// ────────────────────────────────────────────────────────────────────────────

async function runHourlyJS() {
  mkdirSync(DATA_DIR, { recursive: true })
  const now = new Date().toISOString()
  const stateDir = join(DATA_DIR, 'state')

  logger.info('fetch', '[JS] phase D: RSS (hourly)')
  const { store, contentToSeries } = await loadPartialStore(DATA_DIR, [])

  // series-index が空 = 初回 or 壊れた状態 → 日次 full に委ねる
  if (contentToSeries.size === 0) {
    logger.warn('fetch', '[JS] hourly: no series-index (first run?) → skip', {})
    return
  }

  // ── Phase D: RSS 複数ページ取得（maxPages=5 ≈ 100件・約120h窓）─────────────
  const lastGuid = store.meta.rssLastGuid ?? null
  const { items: newRssItems, newLastGuid } = await fetchRssMultiPage(lastGuid, 5)

  if (newRssItems.length === 0) {
    logger.info('fetch', '[JS] hourly: RSS no new items → exit', {})
    // meta + rss の state だけ保存（rssLastGuid 確認のため）
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'meta.json') + '.tmp', JSON.stringify(store.meta), 'utf-8')
    renameSync(join(stateDir, 'meta.json') + '.tmp', join(stateDir, 'meta.json'))
    return
  }

  // 新着アイテムを description 付きで upsert
  const rssRows = newRssItems
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
        description: item.description ?? null,
      }
    })
    .filter(Boolean)

  if (rssRows.length > 0) {
    storeUpsertRss(store, rssRows)
    logger.info('fetch', '[JS] hourly: new RSS items upserted', { count: rssRows.length })
  }
  if (newLastGuid) storeUpdateMeta(store, { rssLastGuid: newLastGuid })

  // ── Phase D2: 未解決 RSS → watch → seriesId 解決 ─────────────────────────
  // unresolved のみ対象。rss_only = 確定非シリーズ（再試行不要）
  const toWatch = new Map() // watchId → rssEntry
  for (const r of store.rss.values()) {
    if (r.resolutionStatus === 'unresolved') {
      toWatch.set(r.watchId, r)
    }
  }

  // D2 前のインデックスを保存（D2 で追加した watchItem の contentId を新規カウントから除外するため）
  const preD2Index = new Set(contentToSeries.keys())

  const resolvedSeriesIds = new Set()
  const resolvedSeriesTitles = new Map() // seriesId → title（新規シリーズ upsert 用）
  logger.info('fetch', '[JS] hourly D2: watch resolution', { candidates: toWatch.size })

  for (const [watchId] of toWatch) {
    const info = await fetchWatchSeriesInfo(watchId)
    if (info === null) {
      // null = bot block / fetch 失敗 → unresolved 維持してリトライ（rss_only にしない）
      continue
    }
    if (!info.seriesId || info.channelId !== 'ch2632720') {
      // 本物の非シリーズ (PV 等) or 別チャンネル → rss_only 確定
      storeUpdateRssResolution(store, watchId, null, 'rss_only')
      continue
    }
    storeUpdateRssResolution(store, watchId, info.contentId, 'resolved')
    resolvedSeriesIds.add(info.seriesId)
    contentToSeries.set(info.contentId, info.seriesId)
    if (!resolvedSeriesTitles.has(info.seriesId)) {
      resolvedSeriesTitles.set(info.seriesId, info.seriesTitle ?? '')
    }
  }

  logger.info('fetch', '[JS] hourly D2: watch done', { resolved: resolvedSeriesIds.size })

  // ── Phase D3: nvapi → 全話 upsert ────────────────────────────────────────
  let insertedEpisodes = 0
  if (resolvedSeriesIds.size > 0) {
    logger.info('fetch', '[JS] hourly D3: nvapi seed', { series: resolvedSeriesIds.size })

    // writeSeriesFiles のためにシリーズデータをロード（loadPartialStore は RSS/meta のみ保持のため）
    const { store: seriesStore } = await loadPartialStore(DATA_DIR, [...resolvedSeriesIds])
    for (const [k, v] of seriesStore.series) store.series.set(k, v)
    for (const [k, v] of seriesStore.episodes) store.episodes.set(k, v)

    // ファイル未存在の新規シリーズを watch 情報から upsert（_buildSeriesJson が null を返さないよう）
    for (const [seriesId, title] of resolvedSeriesTitles) {
      if (!store.series.has(seriesId)) {
        storeUpsertSeries(store, [{ seriesId, title, isAvailable: true }])
      }
    }

    for (const seriesId of resolvedSeriesIds) {
      let data
      try {
        data = await fetchSeriesData(seriesId)
      } catch (err) {
        logger.warn('fetch', '[JS] hourly D3: nvapi failed', { seriesId, err: err.message })
        continue
      }
      const eps = mapNvapiEpisodes(seriesId, data?.items ?? [])
      // preD2Index にない contentId = 本当に新規のエピソード（D2 で追加分も除外）
      for (const ep of eps) {
        if (!preD2Index.has(ep.contentId)) insertedEpisodes++
      }
      storeUpsertEps(store, eps)
      store._dirtySeries.add(seriesId)
    }
    logger.info('fetch', '[JS] hourly D3: done', {
      insertedEpisodes,
      series: resolvedSeriesIds.size,
    })
  }

  // ── rss.json trim（200件・oldest/resolved優先削除）────────────────────────
  _trimRss(store, 200)

  // ── 影響シリーズ書き戻し + series-index 更新 ─────────────────────────────
  if (store._dirtySeries.size > 0) {
    storeSyncThumbs(store)
    storeSyncTimestamps(store)
    await writeSeriesFiles(store, DATA_DIR, [...store._dirtySeries])

    const idxPath = join(stateDir, 'series-index.json')
    let existingIdx = {}
    try {
      existingIdx = JSON.parse(readFileSync(idxPath, 'utf-8'))
    } catch {
      /* 初回 */
    }
    for (const ep of store.episodes.values()) {
      if (ep.seriesId != null) existingIdx[ep.contentId] = ep.seriesId
    }
    writeFileSync(idxPath + '.tmp', JSON.stringify(existingIdx), 'utf-8')
    renameSync(idxPath + '.tmp', idxPath)
  }

  // ── new.json ─────────────────────────────────────────────────────────────
  await exportNewStore(store, DATA_DIR, now)

  // ── state 書き戻し（meta + rss のみ）────────────────────────────────────
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'meta.json') + '.tmp', JSON.stringify(store.meta), 'utf-8')
  renameSync(join(stateDir, 'meta.json') + '.tmp', join(stateDir, 'meta.json'))
  const rssData = { lastGuid: store.meta.rssLastGuid, items: [...store.rss.values()] }
  writeFileSync(join(stateDir, 'rss.json') + '.tmp', JSON.stringify(rssData), 'utf-8')
  renameSync(join(stateDir, 'rss.json') + '.tmp', join(stateDir, 'rss.json'))

  if (insertedEpisodes > 0) {
    writeFileSync(join(DATA_DIR, '.deploy-needed'), `${insertedEpisodes}\n`)
  }
  logger.info('fetch', '[JS] hourly done', { now, insertedEpisodes })
}

// ────────────────────────────────────────────────────────────────────────────

// M6: --mode=full / デフォルト → runFullJS()（SQLite 廃止）
//     --mode=full-db  → main()（旧 SQLite 版・後方互換フォールバック）
//     --mode=hourly   → runHourlyJS()
//     --mode=hourly-db → runHourly()（旧 SQLite 版）
const runner = CLI_CHECK_VERSION
  ? checkVersion()
  : CLI_MODE === 'hourly' || CLI_MODE === 'hourly-js'
    ? runHourlyJS()
    : CLI_MODE === 'hourly-db'
      ? runHourly()
      : CLI_MODE === 'full-db'
        ? main()
        : CLI_MODE === 'export-only'
          ? runExportOnly()
          : runFullJS() // default: full / full-js / 引数なし
runner.catch((err) => {
  logger.error('fetch', err.message, err.assertFields ?? {})
  process.exit(1)
})
