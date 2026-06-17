/**
 * M-pre: SQLite → series JSON 移行前エンリッチ
 *
 * 実行: node scripts/migrate/m-pre-enrich.mjs
 *
 * やること:
 * 1. data/series/<id>.json に isAvailable + episodes[].tagsCurated を追記
 * 2. data/state/meta.json      ← meta_state テーブル
 * 3. data/state/prev-views.json ← episodes.prev_view_counter
 * 4. data/state/rss.json       ← rss_items テーブル
 *
 * 冪等: 再実行しても同じ結果。既存フィールドは上書き。
 */

import Database from 'better-sqlite3'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { processEpisodeTags } from '../etl/tags.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../')
const DATA_DIR = path.join(ROOT, 'data')
const SERIES_DIR = path.join(DATA_DIR, 'series')
const STATE_DIR = path.join(DATA_DIR, 'state')
const DB_PATH = path.join(DATA_DIR, 'build.sqlite')

async function writeJson(filePath, data) {
  const tmp = filePath + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, filePath)
}

async function main() {
  console.log('[M-pre] 開始')

  const db = new Database(DB_PATH, { readonly: true })

  // ── 1. episodes の生タグ → tagsCurated マップ ─────────────────────
  // DB の episodes.tags は space-separated 生タグ文字列
  // series.title で作品名タグを除外する（processEpisodeTags の第2引数）
  const epTagsRows = db
    .prepare(
      `SELECT e.content_id, e.tags AS raw_tags, s.title AS series_title
       FROM episodes e
       LEFT JOIN series s ON s.series_id = e.series_id
       WHERE e.series_id IS NOT NULL`
    )
    .all()

  // contentId → curated tag names[]
  const tagsCuratedMap = new Map()
  for (const row of epTagsRows) {
    const processed = processEpisodeTags(row.raw_tags ?? '', row.series_title ?? null)
    const curated = processed.filter((t) => t.isCurated).map((t) => t.name)
    tagsCuratedMap.set(row.content_id, curated)
  }
  console.log(`[M-pre] エピソードタグ処理: ${epTagsRows.length} 件`)

  // ── 2. prev_view_counter マップ ────────────────────────────────────
  const prevRows = db
    .prepare(
      `SELECT content_id, prev_view_counter
       FROM episodes
       WHERE prev_view_counter IS NOT NULL`
    )
    .all()

  // contentId → prevViewCounter (number)
  const prevViewsMap = new Map()
  for (const row of prevRows) {
    prevViewsMap.set(row.content_id, row.prev_view_counter)
  }
  console.log(`[M-pre] prev_view_counter: ${prevViewsMap.size} 件`)

  // ── 3. is_available マップ（tombstone 判定） ───────────────────────
  const unavailRows = db.prepare(`SELECT series_id FROM series WHERE is_available = 0`).all()
  const unavailSet = new Set(unavailRows.map((r) => r.series_id))
  console.log(`[M-pre] is_available=0 シリーズ: ${unavailSet.size} 件`)

  // ── 4. rss_items ──────────────────────────────────────────────────
  const rssRows = db.prepare(`SELECT * FROM rss_items ORDER BY pub_date DESC`).all()
  console.log(`[M-pre] rss_items: ${rssRows.length} 件`)

  // ── 5. meta_state ─────────────────────────────────────────────────
  const metaRow = db.prepare(`SELECT * FROM meta_state LIMIT 1`).get() ?? {}

  db.close()

  // ── series JSON エンリッチ ─────────────────────────────────────────
  await fs.mkdir(STATE_DIR, { recursive: true })

  const seriesFiles = await fs.readdir(SERIES_DIR)
  const jsonFiles = seriesFiles.filter((f) => f.endsWith('.json'))
  console.log(`[M-pre] series JSON ファイル: ${jsonFiles.length} 件`)

  let enriched = 0
  for (const file of jsonFiles) {
    const filePath = path.join(SERIES_DIR, file)
    const json = JSON.parse(await fs.readFile(filePath, 'utf-8'))
    const seriesId = json.seriesId

    let changed = false

    // isAvailable を追記（DB 由来。デフォルト true）
    const isAvailable = !unavailSet.has(seriesId)
    if (json.isAvailable !== isAvailable) {
      json.isAvailable = isAvailable
      changed = true
    }

    // 各エピソードに tagsCurated を追記
    if (Array.isArray(json.episodes)) {
      for (const ep of json.episodes) {
        const curated = tagsCuratedMap.get(ep.contentId) ?? []
        const curatedStr = JSON.stringify(curated.slice().sort())
        const existingStr = JSON.stringify((ep.tagsCurated ?? []).slice().sort())
        if (curatedStr !== existingStr) {
          ep.tagsCurated = curated
          changed = true
        }
      }
    }

    if (changed) {
      await writeJson(filePath, json)
      enriched++
    }
  }
  console.log(`[M-pre] series JSON 更新: ${enriched} / ${jsonFiles.length} 件`)

  // ── data/state/meta.json ─────────────────────────────────────────
  const meta = {
    rssLastGuid: metaRow.rss_last_guid ?? null,
    snapshotLastStartTime: metaRow.snapshot_last_start_time ?? null,
    snapshotVersionLastModified: metaRow.snapshot_version_last_modified ?? null,
    lastSeedAt: metaRow.last_full_refresh_at ?? null,
  }
  await writeJson(path.join(STATE_DIR, 'meta.json'), meta)
  console.log('[M-pre] meta.json 書き出し完了')

  // ── data/state/prev-views.json ────────────────────────────────────
  // Object.fromEntries は大きいので直接 JSON 組み立て
  const prevViewsObj = Object.fromEntries(prevViewsMap)
  await writeJson(path.join(STATE_DIR, 'prev-views.json'), prevViewsObj)
  console.log(`[M-pre] prev-views.json 書き出し完了 (${prevViewsMap.size} 件)`)

  // ── data/state/rss.json ───────────────────────────────────────────
  const rssData = {
    lastGuid: metaRow.rss_last_guid ?? null,
    items: rssRows.map((r) => ({
      watchId: r.watch_id,
      guid: r.guid ?? null,
      pubDate: r.pub_date ?? null,
      title: r.title ?? null,
      titleNorm: r.title_norm ?? null,
      link: r.link ?? null,
      resolvedContentId: r.resolved_content_id ?? null,
      resolutionStatus: r.resolution_status ?? 'unresolved',
    })),
  }
  await writeJson(path.join(STATE_DIR, 'rss.json'), rssData)
  console.log(`[M-pre] rss.json 書き出し完了 (${rssData.items.length} 件)`)

  console.log('[M-pre] 完了')
}

main().catch((err) => {
  console.error('[M-pre] エラー:', err)
  process.exit(1)
})
