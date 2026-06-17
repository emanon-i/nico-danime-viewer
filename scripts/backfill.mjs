// scripts/backfill.mjs
// nvapi v2/series 経由の「各話 reseed/backfill」再利用可能ルーチン（§85）。
//
// snapshot(tagsExact) で各話が取れていないシリーズ（episodeCount==0 の空シェル等）を、
// nvapi v2/series から各話を取得して DB に埋める。冪等（再実行で重複せず既存話は更新）。
// 将来の取得漏れの self-heal にも転用できるよう、対象選択をパラメータ化している。
//
// 使い方:
//   pnpm backfill                      # 既定 --target=empty（episodeCount==0 のみ）
//   pnpm backfill --target=empty       # 0話シリーズだけ
//   pnpm backfill --target=all         # 全 is_available シリーズ
//   pnpm backfill --series=67945,95552 # 明示リスト
//   pnpm backfill --limit=20           # 先頭 N 件だけ
//   pnpm backfill --dry-run            # 取得して件数だけ報告（書き込まない）
//   pnpm backfill --no-export          # JSON 再生成をしない（DB のみ更新）
//
// ToS: fetchWithToS が UA・前回応答ぶん待機(>=500ms)・503バックオフを担う＝低頻度・逐次。
// nvapi は非公式のため、isBranchSeries(ch2632720) で支店判定し、失敗シリーズは skip して続行。

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openDatabase, createSchema } from './db/db.mjs'
import {
  bulkUpsertEpisodes,
  updateEpisodeOrderBatch,
  syncSeriesThumbnails,
  syncSeriesTimestamps,
} from './db/db.mjs'
import { seedAllSeries, mapNvapiEpisodes } from './nico/nvapi.mjs'
import { exportAll } from './export/export.mjs'
import { logger } from './lib/logger.mjs'

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../data')
const DB_PATH = join(DATA_DIR, 'build.sqlite')

/**
 * backfill 対象の seriesId を選ぶ（再利用可能）。
 * @param {import('better-sqlite3').Database} db
 * @param {{ target?: 'empty'|'all', series?: number[], limit?: number }} opts
 * @returns {number[]}
 */
export function selectBackfillTargets(db, opts = {}) {
  const { target = 'empty', series, limit } = opts
  let ids
  if (series && series.length > 0) {
    ids = series
  } else if (target === 'all') {
    ids = db
      .prepare('SELECT series_id FROM series WHERE is_available = 1 ORDER BY series_id')
      .all()
      .map((r) => r.series_id)
  } else {
    // empty: 各話が 1 件も無い is_available シリーズ（＝空シェル・§59）
    ids = db
      .prepare(
        `SELECT s.series_id FROM series s
         WHERE s.is_available = 1
           AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.series_id = s.series_id)
         ORDER BY s.series_id`
      )
      .all()
      .map((r) => r.series_id)
  }
  return typeof limit === 'number' && limit > 0 ? ids.slice(0, limit) : ids
}

/**
 * 指定 seriesId 群を nvapi v2/series から backfill（各話を冪等 upsert）。再利用可能。
 * - 支店判定（owner.channel.id==ch2632720）を通ったものだけ取り込む。
 * - dryRun 時は取得・件数集計のみで DB を変更しない。
 * - サムネ/タイムスタンプの series 同期は呼び出し側で行う（複数回呼びの効率のため）。
 * @param {import('better-sqlite3').Database} db
 * @param {number[]} seriesIds
 * @param {{ dryRun?: boolean }} opts
 * @returns {Promise<{ processed:number, skipped:number, backfilled:number, episodes:number,
 *   perSeries: {seriesId:number, episodes:number}[], emptyResults:number[] }>}
 */
export async function backfillSeries(db, seriesIds, opts = {}) {
  const { dryRun = false } = opts
  const now = new Date().toISOString()
  let backfilled = 0
  let episodes = 0
  const perSeries = []
  const emptyResults = []

  const { processed, skipped } = await seedAllSeries(seriesIds, async (seriesId, data) => {
    const eps = mapNvapiEpisodes(seriesId, data.items ?? [])
    if (eps.length === 0) {
      emptyResults.push(seriesId)
      return
    }
    if (!dryRun) {
      bulkUpsertEpisodes(db, eps, now)
      // 既存の孤児話（snapshot 由来で series_id=NULL）にも series_id/episode_no を紐付ける。
      // bulkUpsertEpisodes の ON CONFLICT は series_id/episode_no を更新しないため、
      // この紐付けが無いと既存話のシリーズは 0 話のまま残る（§85 の要修正点）。
      updateEpisodeOrderBatch(
        db,
        eps.map((e) => ({ contentId: e.contentId, seriesId, episodeNo: e.episodeNo }))
      )
    }
    backfilled++
    episodes += eps.length
    perSeries.push({ seriesId, episodes: eps.length })
  })

  return { processed, skipped, backfilled, episodes, perSeries, emptyResults }
}

/**
 * 日次 fetch 末尾などから呼べる軽量 self-heal（§85）。0話シリーズがあれば nvapi で reseed を試みる。
 * 重い場合に備え limit でガード可能。書き込み後のサムネ/タイムスタンプ同期まで行う。
 * @param {import('better-sqlite3').Database} db
 * @param {{ limit?: number }} opts
 */
export async function selfHealEmptySeries(db, opts = {}) {
  const targets = selectBackfillTargets(db, { target: 'empty', limit: opts.limit })
  if (targets.length === 0) return { processed: 0, skipped: 0, backfilled: 0, episodes: 0 }
  logger.info('backfill', 'self-heal: empty series found', { count: targets.length })
  const stats = await backfillSeries(db, targets, { dryRun: false })
  syncSeriesThumbnails(db)
  syncSeriesTimestamps(db)
  logger.info('backfill', 'self-heal done', stats)
  return stats
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const get = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
  const has = (name) => argv.includes(`--${name}`)
  const seriesRaw = get('series')
  return {
    target: get('target') ?? 'empty',
    series: seriesRaw
      ? seriesRaw
          .split(',')
          .map((s) => Number(s.trim()))
          .filter(Boolean)
      : undefined,
    limit: get('limit') ? Number(get('limit')) : undefined,
    dryRun: has('dry-run'),
    noExport: has('no-export'),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const db = openDatabase(DB_PATH)
  createSchema(db)

  const targets = selectBackfillTargets(db, args)
  logger.info('backfill', 'start', {
    target: args.series ? 'series-list' : args.target,
    count: targets.length,
    dryRun: args.dryRun,
  })
  if (targets.length === 0) {
    logger.info('backfill', 'no targets, nothing to do')
    db.close()
    return
  }

  const stats = await backfillSeries(db, targets, { dryRun: args.dryRun })

  if (!args.dryRun) {
    syncSeriesThumbnails(db)
    syncSeriesTimestamps(db)
    if (!args.noExport) {
      exportAll(db, DATA_DIR, new Date().toISOString())
    }
  }

  // 取れなかった対象（支店外 or items 0 or 失敗）の内訳
  const couldNot = targets.length - stats.backfilled
  logger.info('backfill', 'complete', {
    targets: targets.length,
    backfilled: stats.backfilled,
    episodesInserted: stats.episodes,
    skippedNonBranch: stats.skipped,
    emptyItemResults: stats.emptyResults.length,
    couldNotBackfill: couldNot,
    dryRun: args.dryRun,
    exported: !args.dryRun && !args.noExport,
  })

  db.close()
}

// 直接実行時のみ main を走らせる（import 時は関数だけ提供＝再利用可能）
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    logger.error('backfill', 'fatal', { error: err.message })
    process.exitCode = 1
  })
}
