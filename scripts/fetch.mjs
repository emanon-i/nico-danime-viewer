// scripts/fetch.mjs
// pnpm fetch エントリポイント: 全データソース取得 → ETL → 静的 JSON export
//
// 環境変数:
//   NICO_USER_AGENT  問い合わせ先を含む UA 文字列（省略可・デフォルト値あり）

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
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
  resolveRssItemsFromStore,
} from './nico/rss.mjs'

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
  mapCurrentCours,
  makeCoursLabel,
  parsePeriodHtml,
  matchPeriodEntriesToSeries,
  deriveCoursFromTags,
  deriveCoursFromTagsFromStore,
} from './etl/cours.mjs'
import { fetchPeriodHtml, enumeratePastSeasons } from './nico/period.mjs'
import { recalcSeriesMetrics } from './etl/metrics.mjs'
import { exportAll } from './export/export.mjs'
import { selfHealEmptySeries, backfillSeries } from './backfill.mjs'

import { logger } from './lib/logger.mjs'

// ── Store ベース（M3/M4）─────────────────────────────────────────────────────
import {
  loadStore,
  loadPartialStore,
  writeBackStore,
  upsertEpisodes as storeUpsertEps,
  upsertSeries as storeUpsertSeries,
  linkEpisodes as storeLinkEps,
  updateSeries as storeUpdateSeries,
  syncSeriesThumbnails as storeSyncThumbs,
  syncSeriesTimestamps as storeSyncTimestamps,
  updateMetaState as storeUpdateMeta,
  upsertRssItems as storeUpsertRss,
  replaceSeriesTags as storeReplaceSeriesTags,
  countOrphanEpisodes,
  selectSeedTargets,
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
  let insertedEpisodes = 0
  const targetSeries = matchRssOnlyToSeries(db)
  if (targetSeries.length > 0) {
    logger.info('fetch', 'phase D2: resolve new episodes via nvapi', {
      series: targetSeries.length,
    })
    const stats = await backfillSeries(db, targetSeries, { dryRun: false })
    insertedEpisodes = stats.episodes
    if (insertedEpisodes > 0) {
      syncSeriesThumbnails(db)
      syncSeriesTimestamps(db)
      resolveRssItems(db) // 挿入後に再解決＝rss_only→resolved（サムネ/再生数付き新着に）
    }
    logger.info('fetch', 'phase D2 done', { ...stats })
  }

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

/**
 * 未解決(rss_only)の新着 RSS を、既存シリーズに title 前方一致（最長一致）で対応付ける（§D）。
 * RSS title は「<シリーズ名> 第N話 <サブタイトル>」形式。先頭がどの series.title で始まるかで判定。
 * @param {import('better-sqlite3').Database} db
 * @returns {number[]} 重複除去した対応シリーズ id
 */
function matchRssOnlyToSeries(db) {
  const norm = (s) => (s ?? '').replace(/\s+/gu, ' ').trim()
  const rssOnly = db
    .prepare(
      "SELECT title FROM rss_items WHERE resolution_status = 'rss_only' AND title IS NOT NULL"
    )
    .all()
  if (rssOnly.length === 0) return []
  const series = db
    .prepare('SELECT series_id, title FROM series WHERE is_available = 1 AND title IS NOT NULL')
    .all()
    .map((s) => ({ id: s.series_id, t: norm(s.title) }))
    .filter((s) => s.t.length > 0)
  const ids = new Set()
  for (const r of rssOnly) {
    const t = norm(r.title)
    let best = null
    for (const s of series) {
      if (t.startsWith(s.t) && (!best || s.t.length > best.len))
        best = { id: s.id, len: s.t.length }
    }
    if (best) ids.add(best.id)
  }
  return [...ids]
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
// Store ベース クールパイプライン（M3）
// ────────────────────────────────────────────────────────────────────────────

async function runCoursPipelineFromStore(store, now) {
  // 0. クリア（is_available シリーズのみ）
  for (const s of store.series.values()) {
    if (s.isAvailable) s.cours = null
  }

  // 1. 主源 = 第1話タグの「YYYY年<季>アニメ」から放送季を導出
  const tagMap = deriveCoursFromTagsFromStore(store, chronoSort)
  for (const [id, cours] of tagMap) {
    const s = store.series.get(id)
    if (s) s.cours = cours
  }
  logger.info('fetch', 'E3 cours from tags (primary)', { count: tagMap.size })

  // 2. 補完 = 今季 programlist
  const programlist = await fetchProgramlist()
  const coursLabel = makeCoursLabel(new Date(now).getFullYear(), currentSeason(now))
  const curMap = mapCurrentCours(programlist, coursLabel)
  let curAdded = 0
  for (const [id] of curMap) {
    const s = store.series.get(id)
    if (s && s.isAvailable && s.cours == null) {
      s.cours = coursLabel
      curAdded++
    }
  }
  logger.info('fetch', 'E3b cours from programlist (fill)', { added: curAdded })

  // 3. 補完 = period 日本語タイトル突合（cours IS NULL のみ）
  const pastCours = await derivePastCoursFromStore(store, now)
  logger.info('fetch', 'E3c cours from period (fill)', pastCours)
}

async function derivePastCoursFromStore(store, now) {
  const assigned = new Set()
  for (const s of store.series.values()) {
    if (s.isAvailable && s.cours != null) assigned.add(s.seriesId)
  }
  const seriesMap = new Map()
  for (const s of store.series.values()) {
    if (s.isAvailable) seriesMap.set(s.seriesId, s.title)
  }

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
    if (!parsed.title.includes('dアニメストア') || parsed.slugs.length < 1) continue
    seasonsWithData++

    const coursLabel = makeCoursLabel(year, season)
    const matches = matchPeriodEntriesToSeries(parsed.entries, seriesMap)
    let seasonAssigned = 0
    for (const m of matches) {
      if (m.seriesId == null || m.confidence < COURS_MATCH_MIN) continue
      if (assigned.has(m.seriesId)) continue
      const s = store.series.get(m.seriesId)
      if (!s || !s.isAvailable) continue
      s.cours = coursLabel
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

// ────────────────────────────────────────────────────────────────────────────
// M3: --mode=full-js  Store ベース フルパイプライン
// ────────────────────────────────────────────────────────────────────────────

async function runFullJS() {
  mkdirSync(DATA_DIR, { recursive: true })
  const now = new Date().toISOString()

  logger.info('fetch', '[JS] loadStore start')
  const store = await loadStore(DATA_DIR)
  logger.info('fetch', '[JS] loadStore done', {
    series: store.series.size,
    episodes: store.episodes.size,
    rss: store.rss.size,
  })

  // ── Phase A: Snapshot ──────────────────────────────────────────────────────
  logger.info('fetch', '[JS] phase A: snapshot')
  const storedVersion = store.meta.snapshotVersionLastModified ?? null
  const snapResult = await fetchAllBranchEpisodes(storedVersion)

  if (!snapResult.skipped) {
    const { episodes, newVersion } = snapResult
    assertSnapshotOk({ meta: { status: 200, totalCount: episodes.length }, data: episodes }, null)
    // snapshot の生タグ文字列 → processEpisodeTags でタグ配列化
    // （fetch.mjs では tags は space-separated string → Store は string[]）
    const { processEpisodeTags } = await import('./etl/tags.mjs')
    const mappedEps = episodes.map((ep) => {
      const processedTags = processEpisodeTags(ep.tags ?? '', null)
      return {
        ...ep,
        tags: processedTags.map((t) => t.name),
        tagsCurated: processedTags.filter((t) => t.isCurated).map((t) => t.name),
        lastUpdated: now,
      }
    })
    storeUpsertEps(store, mappedEps)
    storeUpdateMeta(store, { snapshotVersionLastModified: newVersion })
    logger.info('fetch', '[JS] snapshot done', { count: episodes.length })
  } else {
    logger.info('fetch', '[JS] snapshot version unchanged, skipping')
  }

  // ── Phase B: list.json → col_key + series 登録 + is_available 同期 ──────
  logger.info('fetch', '[JS] phase B: list.json')
  const listJson = await fetchListJson()
  const listSeriesIds = new Set()
  const seriesFromList = []

  for (const item of listJson) {
    const seriesId = extractSeriesIdFromUrl(item.url)
    if (!seriesId) continue
    listSeriesIds.add(seriesId)
    seriesFromList.push({
      seriesId,
      title: item.title,
      colKey: item.col_key ?? null,
      isAvailable: true,
    })
  }

  // list.json 外のシリーズを unavailable にマーク
  for (const s of store.series.values()) {
    if (!listSeriesIds.has(s.seriesId)) s.isAvailable = false
  }
  // list.json 収録シリーズを upsert（新規は追加、既存は title/colKey 更新）
  storeUpsertSeries(store, seriesFromList)
  // colKey を明示的に設定（upsertSeries は colKey を保護しないので直接更新）
  for (const item of seriesFromList) {
    if (item.colKey)
      storeUpdateSeries(store, item.seriesId, { colKey: item.colKey, isAvailable: true })
  }
  logger.info('fetch', '[JS] list.json done', { count: seriesFromList.length })

  // ── Phase C: nvapi seed（orphan-driven）────────────────────────────────────
  const orphans = countOrphanEpisodes(store)
  const daysSinceRefresh = store.meta.lastSeedAt
    ? (Date.now() - new Date(store.meta.lastSeedAt).getTime()) / 86400000
    : Infinity
  const forceSeed = process.env.NICO_FORCE_SEED === '1'
  const needSeed = forceSeed || orphans > 0 || daysSinceRefresh >= 7

  if (needSeed) {
    const seedTargets = selectSeedTargets(store, { allIfOrphans: true })
    logger.info('fetch', '[JS] phase C: nvapi seed', {
      total: seedTargets.length,
      orphans,
      daysSinceRefresh: Math.round(daysSinceRefresh),
      forceSeed,
    })
    await seedAllSeries(seedTargets, async (seriesId, data) => {
      const updates = mapNvapiItems(seriesId, data.items ?? [])
      if (updates.length > 0) storeLinkEps(store, updates)
    })
    storeUpdateMeta(store, { lastSeedAt: now })
  } else {
    logger.info('fetch', '[JS] phase C: nvapi seed skipped', {
      orphans,
      daysSinceRefresh: Math.round(daysSinceRefresh),
    })
  }

  // ── Phase D: RSS 新着 ──────────────────────────────────────────────────────
  logger.info('fetch', '[JS] phase D: RSS')
  const rssResult = await fetchRss()
  if (rssResult.status === 200 && rssResult.body) {
    const { channelTitle, items } = parseRssXml(rssResult.body)
    assertRssOk(items, channelTitle)
    const newItems = filterNewRssItems(items, store.meta.rssLastGuid ?? null)
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
      storeUpsertRss(store, rssRows)
      resolveRssItemsFromStore(store)
      logger.info('fetch', '[JS] RSS new items inserted', { count: rssRows.length })
    }
    const newLastGuid = items[0]?.guid ?? store.meta.rssLastGuid
    if (newLastGuid) storeUpdateMeta(store, { rssLastGuid: newLastGuid })
  } else if (rssResult.status === 304) {
    logger.info('fetch', '[JS] RSS 304 not modified, skipping')
  }

  // ── Phase E: ETL 派生 ──────────────────────────────────────────────────────
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

  // E3: Cours
  await runCoursPipelineFromStore(store, now)

  // E4: Franchise keys
  const seriesTagsMap = getSeriesTagsMapFromStore(store)
  const titleMap = new Map()
  for (const s of store.series.values()) {
    if (s.isAvailable) titleMap.set(s.seriesId, s.title)
  }
  const franchiseKeys = computeFranchiseKeys(seriesTagsMap, titleMap)
  for (const s of store.series.values()) s.franchiseKey = null
  for (const [seriesId, franchiseKey] of franchiseKeys) {
    storeUpdateSeries(store, seriesId, { franchiseKey })
  }
  // franchise = Store の relatedSeries を再計算
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
    }
  }
  logger.info('fetch', '[JS] E4 franchise keys done', { count: franchiseKeys.size })

  // E5: Timestamps
  storeSyncTimestamps(store)

  // E6: Thumbnails
  storeSyncThumbs(store)
  logger.info('fetch', '[JS] E6 thumbnails synced')

  // ── 回帰ガード ───────────────────────────────────────────────────────────
  const guard = detectShrinkFromStore(store, DATA_DIR)
  if (guard.shrink) {
    logger.error('fetch', '[JS] REGRESSION GUARD: full-js would shrink → skip export', guard)
    logger.info('fetch', '[JS] all done (guarded)', { now })
    return
  }

  // ── Phase F + G: metrics + export ─────────────────────────────────────────
  logger.info('fetch', '[JS] phase F+G: project all')
  await writeBackStore(store, DATA_DIR, { now })
  await projectAll(store, DATA_DIR, now)
  logger.info('fetch', '[JS] all done', { now, ep0: guard.ep0 })
}

// ────────────────────────────────────────────────────────────────────────────
// M4: --mode=hourly-js  Store ベース 毎時 RSS パイプライン
// ────────────────────────────────────────────────────────────────────────────

async function runHourlyJS() {
  mkdirSync(DATA_DIR, { recursive: true })
  const now = new Date().toISOString()
  const stateDir = join(DATA_DIR, 'state')

  // ── Phase D: RSS 新着取得（series-index + state だけロード）────────────────
  logger.info('fetch', '[JS] phase D: RSS (hourly)')

  // まず state/meta.json と rss.json だけ読んで lightweight な Store を作る
  // （series/episodes は RSS 処理後に必要分だけ読む）
  const { store: partialStore, contentToSeries } = await loadPartialStore(DATA_DIR, [])

  // 空 Store ガード（series-index.json が存在しない = 初回 or 壊れた状態）
  if (contentToSeries.size === 0) {
    // series-index がないと rss_only 解決もできない → skip してガードする
    logger.warn('fetch', '[JS] hourly: no series-index (first run?) → skip', {})
    return
  }

  const rssResult = await fetchRss()
  if (rssResult.status === 304) {
    logger.info('fetch', '[JS] RSS 304 not modified, skipping')
    return
  }

  let insertedEpisodes = 0

  if (rssResult.status === 200 && rssResult.body) {
    const { channelTitle, items } = parseRssXml(rssResult.body)
    assertRssOk(items, channelTitle)
    const newItems = filterNewRssItems(items, partialStore.meta.rssLastGuid ?? null)
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
      storeUpsertRss(partialStore, rssRows)
      logger.info('fetch', '[JS] hourly: new RSS items', { count: rssRows.length })
    }
    const newLastGuid = items[0]?.guid ?? partialStore.meta.rssLastGuid
    if (newLastGuid) storeUpdateMeta(partialStore, { rssLastGuid: newLastGuid })

    // ── Phase D2: rss_only → 対応シリーズ nvapi backfill ──────────────────
    // contentToSeries インデックスから rss_only タイトルに対応するシリーズを特定。
    // 軽量なシリーズ情報だけロードして backfill し、series/*.json と new.json のみ更新する。
    //
    // §0-4: hourly は works.json を書かない（全量 projection を避ける）。
    const rssOnlyTitles = [...partialStore.rss.values()]
      .filter((r) => r.resolutionStatus === 'rss_only' && r.title)
      .map((r) => r.title)

    if (rssOnlyTitles.length > 0) {
      // タイトル前方一致でシリーズ特定（series title が必要）。
      // 必要なシリーズ情報を series-index から逆引きして該当 series JSON を読む。
      // ただし、rss_only 解決のためには series タイトルが必要。
      // シリーズ JSON をすべて読むのは重い（6352件）ので、まず rss title から候補 seriesId を
      // contentToSeries + heuristic で絞る。
      //
      // 簡略化: rss_only タイトルの prefix が seriesId に対応するか探すには series タイトルが必要。
      // ここでは「全シリーズタイトルインデックス」を state に持つ必要がある → series-titles.json
      // （M4 段階ではまだ存在しないため、この step は skip して rss_only は日次 full で回収する）
      logger.info('fetch', '[JS] hourly: rss_only items will be resolved by next daily', {
        count: rssOnlyTitles.length,
      })
    }
  }

  // ── new.json のみ書き出し（§0-4: works.json は書かない）──────────────────
  // partialStore.rss には更新済みの全 RSS アイテムが入っている（state/rss.json から）
  await exportNewStore(partialStore, DATA_DIR, now)

  // ── state 書き戻し（touched series なし・meta + rss + series-index のみ）────
  // prev-views.json は変化なし（viewCounter 更新なし）→ 既存ファイルを保持
  const rssData = { lastGuid: partialStore.meta.rssLastGuid, items: [...partialStore.rss.values()] }
  const { writeFile } = await import('node:fs/promises')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(stateDir, { recursive: true })
  const tmpMeta = join(stateDir, 'meta.json.tmp')
  await writeFile(tmpMeta, JSON.stringify(partialStore.meta, null, 2), 'utf-8')
  const { rename } = await import('node:fs/promises')
  await rename(tmpMeta, join(stateDir, 'meta.json'))
  const tmpRss = join(stateDir, 'rss.json.tmp')
  await writeFile(tmpRss, JSON.stringify(rssData, null, 2), 'utf-8')
  await rename(tmpRss, join(stateDir, 'rss.json'))

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
