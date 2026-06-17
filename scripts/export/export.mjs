// scripts/export/export.mjs
// 用途別 静的 JSON export: works/ranking/tags/cours/kana/new/series

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { stripHtml } from '../etl/series.mjs'

/** JSON ファイルに書き出す（配信用のためインデントなし） */
function writeJson(outDir, filename, data) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, filename), JSON.stringify(data), 'utf-8')
}

/**
 * DB から works.json を生成（series 一覧 + tags + related）
 */
export function exportWorks(db, outDir, lastUpdated) {
  const seriesList = db
    .prepare(
      `SELECT s.series_id, s.title, s.thumbnail_url, s.description_first,
              s.col_key, s.cours, s.franchise_key,
              (SELECT COUNT(*) FROM episodes e WHERE e.series_id = s.series_id) AS episode_count,
              (SELECT MAX(e.start_time) FROM episodes e WHERE e.series_id = s.series_id) AS latest_at,
              (SELECT MIN(e.start_time) FROM episodes e WHERE e.series_id = s.series_id) AS first_at,
              (SELECT COALESCE(SUM(e.comment_counter),0) FROM episodes e WHERE e.series_id = s.series_id) AS comment_total,
              (SELECT COALESCE(SUM(e.mylist_counter),0) FROM episodes e WHERE e.series_id = s.series_id) AS mylist_total,
              (SELECT e.mylist_counter FROM episodes e WHERE e.series_id = s.series_id
                 ORDER BY (e.episode_no IS NULL), e.episode_no ASC, e.start_time ASC, e.content_id ASC
                 LIMIT 1) AS mylist_first,
              (SELECT COALESCE(SUM(e.length_seconds),0) FROM episodes e WHERE e.series_id = s.series_id) AS duration_total,
              (SELECT m.hot_score FROM series_metrics m WHERE m.series_id = s.series_id) AS hot_score
       FROM series s
       WHERE s.is_available = 1
       ORDER BY s.series_id`
    )
    .all()

  const tagsBySeriesId = new Map()
  const tagRows = db
    .prepare(
      `SELECT st.series_id, t.name
       FROM series_tags st JOIN tags t ON st.tag_id = t.tag_id
       JOIN series s ON st.series_id = s.series_id WHERE s.is_available = 1`
    )
    .all()
  for (const row of tagRows) {
    if (!tagsBySeriesId.has(row.series_id)) tagsBySeriesId.set(row.series_id, [])
    tagsBySeriesId.get(row.series_id).push(row.name)
  }

  // 関連シリーズ（同一 franchise_key の他メンバー）
  const relatedRows = db
    .prepare(
      `SELECT a.series_id AS target_id, b.series_id, b.title, b.thumbnail_url
       FROM series a
       JOIN series b ON a.franchise_key = b.franchise_key
                     AND a.series_id != b.series_id
                     AND b.is_available = 1
       WHERE a.franchise_key IS NOT NULL AND a.is_available = 1`
    )
    .all()
  const relatedBySeries = new Map()
  for (const row of relatedRows) {
    if (!relatedBySeries.has(row.target_id)) relatedBySeries.set(row.target_id, [])
    relatedBySeries.get(row.target_id).push({
      seriesId: row.series_id,
      title: row.title,
      thumbnailUrl: row.thumbnail_url,
    })
  }

  const works = seriesList.map((s) => ({
    seriesId: s.series_id,
    title: s.title,
    thumbnailUrl: s.thumbnail_url,
    descriptionFirst: s.description_first,
    tags: tagsBySeriesId.get(s.series_id) ?? [],
    cours: s.cours,
    franchiseKey: s.franchise_key,
    colKey: s.col_key,
    episodeCount: s.episode_count ?? 0,
    latestAt: s.latest_at ?? null,
    firstAt: s.first_at ?? null,
    commentTotal: s.comment_total ?? 0,
    mylistTotal: s.mylist_total ?? 0,
    mylistFirst: s.mylist_first ?? 0,
    durationTotal: s.duration_total ?? 0,
    hotScore: s.hot_score ?? 0, // 炎ティア算出用（§64・ranking.hotTiers と突合）
    relatedSeries: relatedBySeries.get(s.series_id) ?? [],
  }))

  writeJson(outDir, 'works.json', { lastUpdated, works })
}

/**
 * ranking.json（hot / popular）
 */
export function exportRanking(db, outDir, lastUpdated) {
  const hotRows = db
    .prepare(
      `SELECT s.series_id, s.title, s.thumbnail_url,
              COALESCE(m.total_views, 0) AS total_views,
              COALESCE(m.hot_score, 0)   AS hot_score
       FROM series s
       LEFT JOIN series_metrics m ON s.series_id = m.series_id
       WHERE s.is_available = 1
       ORDER BY COALESCE(m.hot_score, 0) DESC,
                COALESCE(m.total_views, 0) DESC,
                s.series_id ASC
       LIMIT 200`
    )
    .all()

  const popularRows = db
    .prepare(
      `SELECT s.series_id, s.title, s.thumbnail_url,
              COALESCE(m.total_views, 0) AS total_views,
              COALESCE(m.hot_score, 0)   AS hot_score
       FROM series s
       LEFT JOIN series_metrics m ON s.series_id = m.series_id
       WHERE s.is_available = 1
       ORDER BY COALESCE(m.total_views, 0) DESC,
                s.series_id ASC
       LIMIT 200`
    )
    .all()

  const toEntry = (r) => ({
    seriesId: r.series_id,
    title: r.title,
    thumbnailUrl: r.thumbnail_url,
    totalViews: r.total_views,
    hotScore: r.hot_score,
  })

  // 炎ティア閾値（§64・全作品横断の percentile）。分布が右偏のため順位ベース。
  // t1=上位10%(p90) / t2=上位5%(p95) / t3=上位1%(p99) の hot_score 値。
  const scores = db
    .prepare(
      `SELECT COALESCE(m.hot_score, 0) AS hs
       FROM series s LEFT JOIN series_metrics m ON s.series_id = m.series_id
       WHERE s.is_available = 1
       ORDER BY hs ASC`
    )
    .all()
    .map((r) => r.hs)
  const pct = (p) =>
    scores.length ? scores[Math.min(scores.length - 1, Math.floor(p * scores.length))] : 0
  const hotTiers = { t1: pct(0.9), t2: pct(0.95), t3: pct(0.99) }

  writeJson(outDir, 'ranking.json', {
    lastUpdated,
    hot: hotRows.map(toEntry),
    popular: popularRows.map(toEntry),
    hotTiers,
  })
}

/**
 * tags.json（正規化タグ辞書 + top チップ）
 */
function exportTags(db, outDir, lastUpdated) {
  const tagRows = db
    .prepare(
      `SELECT t.name, t.is_curated, COUNT(st.series_id) as series_count
       FROM tags t
       JOIN series_tags st ON t.tag_id = st.tag_id
       JOIN series s ON st.series_id = s.series_id
       WHERE s.is_available = 1
       GROUP BY t.tag_id
       ORDER BY series_count DESC`
    )
    .all()

  // Hot 上位 20 作品の頻出タグ
  const hotTagRows = db
    .prepare(
      `SELECT t.name, COUNT(*) as c
       FROM (SELECT series_id FROM series_metrics WHERE series_id IN (
             SELECT series_id FROM series WHERE is_available=1)
             ORDER BY hot_score DESC LIMIT 20) top
       JOIN series_tags st ON top.series_id = st.series_id
       JOIN tags t ON st.tag_id = t.tag_id
       GROUP BY t.tag_id ORDER BY c DESC LIMIT 10`
    )
    .all()

  // 人気 TOP 20 の頻出タグ
  const popularTagRows = db
    .prepare(
      `SELECT t.name, COUNT(*) as c
       FROM (SELECT series_id FROM series_metrics WHERE series_id IN (
             SELECT series_id FROM series WHERE is_available=1)
             ORDER BY total_views DESC LIMIT 20) top
       JOIN series_tags st ON top.series_id = st.series_id
       JOIN tags t ON st.tag_id = t.tag_id
       GROUP BY t.tag_id ORDER BY c DESC LIMIT 10`
    )
    .all()

  writeJson(outDir, 'tags.json', {
    lastUpdated,
    tags: tagRows.map((r) => ({
      name: r.name,
      isCurated: r.is_curated === 1,
      seriesCount: r.series_count,
    })),
    topHotTags: hotTagRows.map((r) => r.name),
    topPopularTags: popularTagRows.map((r) => r.name),
  })
}

/**
 * cours.json（クール別シリーズ）
 */
function exportCours(db, outDir, lastUpdated) {
  const rows = db
    .prepare(
      `SELECT cours, series_id FROM series
       WHERE cours IS NOT NULL AND is_available = 1
       ORDER BY cours DESC, series_id`
    )
    .all()

  const grouped = new Map()
  for (const row of rows) {
    if (!grouped.has(row.cours)) grouped.set(row.cours, [])
    grouped.get(row.cours).push(row.series_id)
  }

  writeJson(outDir, 'cours.json', {
    lastUpdated,
    cours: [...grouped.entries()].map(([cours, seriesIds]) => ({ cours, seriesIds })),
  })
}

/**
 * kana.json（五十音別シリーズ）
 */
function exportKana(db, outDir, lastUpdated) {
  const rows = db
    .prepare(
      `SELECT col_key, series_id FROM series
       WHERE col_key IS NOT NULL AND is_available = 1
       ORDER BY col_key, title`
    )
    .all()

  const grouped = new Map()
  for (const row of rows) {
    if (!grouped.has(row.col_key)) grouped.set(row.col_key, [])
    grouped.get(row.col_key).push(row.series_id)
  }

  writeJson(outDir, 'kana.json', {
    lastUpdated,
    kana: [...grouped.entries()].map(([colKey, seriesIds]) => ({ colKey, seriesIds })),
  })
}

/**
 * new.json（最新 RSS 新着）
 */
export function exportNew(db, outDir, lastUpdated) {
  // 解決済み話は episodes(content_id) を resolved_content_id で join してサムネを取得。
  // 未解決(rss_only)はサムネ無し → thumbnail_url は NULL（クライアント側でプレースホルダ）。
  const rows = db
    .prepare(
      `SELECT r.watch_id, r.title, r.pub_date, r.resolved_content_id, r.resolution_status,
              e.thumbnail_url, e.episode_no, e.view_counter, e.comment_counter, e.mylist_counter
       FROM rss_items r
       LEFT JOIN episodes e ON e.content_id = r.resolved_content_id
       ORDER BY r.pub_date DESC
       LIMIT 100`
    )
    .all()

  writeJson(outDir, 'new.json', {
    lastUpdated,
    items: rows.map((r) => ({
      watchId: r.watch_id,
      title: r.title,
      pubDate: r.pub_date,
      resolvedContentId: r.resolved_content_id,
      resolutionStatus: r.resolution_status,
      thumbnailUrl: r.thumbnail_url ?? null,
      episodeNo: r.episode_no ?? null,
      viewCounter: r.view_counter ?? null,
      commentCounter: r.comment_counter ?? null,
      mylistCounter: r.mylist_counter ?? null,
    })),
  })
}

/**
 * series/{seriesId}.json（シリーズ詳細 + 各話一覧 + 関連シリーズ）
 * 全シリーズを 1 ファイルにまとめると JSON.stringify の V8 文字列長上限を超えるため
 * シリーズ単位で個別ファイルに出力する
 */
export function exportSeries(db, outDir) {
  // タグを事前に全体マップ化（タグ行数は数万行程度でメモリに収まる）
  const tagsBySeriesId = new Map()
  for (const row of db
    .prepare(
      `SELECT st.series_id, t.name FROM series_tags st
       JOIN tags t ON st.tag_id = t.tag_id
       JOIN series s ON st.series_id = s.series_id WHERE s.is_available = 1`
    )
    .iterate()) {
    if (!tagsBySeriesId.has(row.series_id)) tagsBySeriesId.set(row.series_id, [])
    tagsBySeriesId.get(row.series_id).push(row.name)
  }

  // 関連シリーズをマップ化
  const relatedBySeries = new Map()
  for (const row of db
    .prepare(
      `SELECT a.series_id AS target_id, b.series_id, b.title, b.thumbnail_url
       FROM series a
       JOIN series b ON a.franchise_key = b.franchise_key
                     AND a.series_id != b.series_id AND b.is_available = 1
       WHERE a.franchise_key IS NOT NULL AND a.is_available = 1`
    )
    .iterate()) {
    if (!relatedBySeries.has(row.target_id)) relatedBySeries.set(row.target_id, [])
    relatedBySeries.get(row.target_id).push({
      seriesId: row.series_id,
      title: row.title,
      thumbnailUrl: row.thumbnail_url,
    })
  }

  // エピソードはシリーズ単位で取得（全件一括ロードを避ける）
  const epStmt = db.prepare(
    `SELECT content_id, episode_no, title, view_counter, comment_counter, mylist_counter,
            length_seconds, start_time, thumbnail_url, description
     FROM episodes WHERE series_id = ?
     ORDER BY COALESCE(episode_no, 9999), start_time`
  )

  const seriesDir = join(outDir, 'series')
  mkdirSync(seriesDir, { recursive: true })

  for (const s of db
    .prepare(
      `SELECT s.series_id, s.title, s.thumbnail_url, s.description_first, s.col_key, s.cours
       FROM series s WHERE s.is_available = 1 ORDER BY s.series_id`
    )
    .iterate()) {
    // 注: per-series JSON には lastUpdated を入れない（毎回バイト変化＝6,352 ファイルが
    // 常に diff になり commit/lint-staged/state 保存が重くなるため）。更新時刻は works.json
    // 等の代表 1 か所に集約する＝**内容が変わった series ファイルだけ** diff になる（冪等）。
    const detail = {
      seriesId: s.series_id,
      title: s.title,
      thumbnailUrl: s.thumbnail_url,
      descriptionFirst: s.description_first,
      tags: tagsBySeriesId.get(s.series_id) ?? [],
      cours: s.cours,
      colKey: s.col_key,
      relatedSeries: relatedBySeries.get(s.series_id) ?? [],
      episodes: epStmt.all(s.series_id).map((ep) => ({
        contentId: ep.content_id,
        episodeNo: ep.episode_no,
        title: ep.title,
        viewCounter: ep.view_counter,
        commentCounter: ep.comment_counter ?? null,
        mylistCounter: ep.mylist_counter ?? null,
        lengthSeconds: ep.length_seconds ?? null,
        startTime: ep.start_time,
        thumbnailUrl: ep.thumbnail_url,
        // <br> を改行に・他 HTML/実体参照は除去（§56・XSS 安全。descriptionFirst と同処理）
        description: stripHtml(ep.description) || null,
      })),
    }
    writeFileSync(join(seriesDir, `${s.series_id}.json`), JSON.stringify(detail), 'utf-8')
  }
}

/**
 * 全 JSON を出力する
 * @param {import('better-sqlite3').Database} db
 * @param {string} outDir - data/ ディレクトリのパス
 * @param {string} lastUpdated - ISO8601 タイムスタンプ
 */
export function exportAll(db, outDir, lastUpdated) {
  exportWorks(db, outDir, lastUpdated)
  exportRanking(db, outDir, lastUpdated)
  exportTags(db, outDir, lastUpdated)
  exportCours(db, outDir, lastUpdated)
  exportKana(db, outDir, lastUpdated)
  exportNew(db, outDir, lastUpdated)
  exportSeries(db, outDir)
}
