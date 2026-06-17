// scripts/db/db.mjs
// SQLite ビルドDB: スキーマ作成・PRAGMA・一括UPSERT・delta管理・ETL補助

import Database from 'better-sqlite3'
import { logger } from '../lib/logger.mjs'

/** PRAGMA（再生成可能なビルドDB用・速度優先） */
function applyPragma(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous  = NORMAL;
    PRAGMA temp_store   = MEMORY;
    PRAGMA cache_size   = -65536;
    PRAGMA mmap_size    = 268435456;
    PRAGMA foreign_keys = ON;
  `)
}

/** カスタム SQLite スカラー関数を登録（metrics 計算用） */
export function registerCustomFunctions(db) {
  if (db._customFunctionsRegistered) return
  db.function('log1p', (x) => Math.log1p(x ?? 0))
  db.function('exp_neg_div', (x, tau) => Math.exp(-(x ?? 0) / tau))
  db._customFunctionsRegistered = true
}

/** テーブル作成（インデックスなし） */
export function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS series (
      series_id         INTEGER PRIMARY KEY,
      title             TEXT NOT NULL,
      col_key           TEXT,
      thumbnail_url     TEXT,
      description_first TEXT,
      first_seen        TEXT,
      last_seen         TEXT,
      cours             TEXT,
      franchise_key     TEXT,
      is_available      INTEGER DEFAULT 1,
      updated_at        TEXT
    );

    CREATE TABLE IF NOT EXISTS episodes (
      content_id        TEXT PRIMARY KEY,
      series_id         INTEGER REFERENCES series(series_id),
      episode_no        INTEGER,
      title             TEXT,
      view_counter      INTEGER,
      prev_view_counter INTEGER,
      comment_counter   INTEGER,
      like_counter      INTEGER,
      mylist_counter    INTEGER,
      length_seconds    INTEGER,
      start_time        TEXT,
      thumbnail_url     TEXT,
      tags              TEXT,
      description       TEXT,
      last_updated      TEXT
    );

    CREATE TABLE IF NOT EXISTS rss_items (
      watch_id            TEXT PRIMARY KEY,
      guid                TEXT,
      pub_date            TEXT,
      title               TEXT,
      title_norm          TEXT,
      link                TEXT,
      resolved_content_id TEXT,
      resolution_status   TEXT DEFAULT 'unresolved'
    );

    CREATE TABLE IF NOT EXISTS tags (
      tag_id     INTEGER PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      is_curated INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS series_tags (
      series_id INTEGER REFERENCES series(series_id),
      tag_id    INTEGER REFERENCES tags(tag_id),
      PRIMARY KEY (series_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS meta_state (
      id                             INTEGER PRIMARY KEY CHECK (id = 1),
      rss_last_guid                  TEXT,
      snapshot_last_start_time       TEXT,
      snapshot_version_last_modified TEXT,
      last_full_refresh_at           TEXT
    );

    CREATE TABLE IF NOT EXISTS episode_view_history (
      content_id   TEXT REFERENCES episodes(content_id),
      slot         INTEGER,
      view_counter INTEGER,
      taken_at     TEXT,
      PRIMARY KEY (content_id, slot)
    );

    CREATE TABLE IF NOT EXISTS series_metrics (
      series_id   INTEGER PRIMARY KEY REFERENCES series(series_id),
      total_views INTEGER,
      delta_views INTEGER,
      velocity    REAL,
      recency     REAL,
      hot_score   REAL,
      updated_at  TEXT
    );
  `)
}

/** インデックス作成（一括ロード後に実行） */
export function createIndexes(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_episodes_start_time ON episodes(start_time);
    CREATE INDEX IF NOT EXISTS ix_episodes_series     ON episodes(series_id);
    CREATE INDEX IF NOT EXISTS ix_series_tags_tag     ON series_tags(tag_id);
    CREATE INDEX IF NOT EXISTS ix_series_cours        ON series(cours);
    CREATE INDEX IF NOT EXISTS ix_series_franchise    ON series(franchise_key);
    CREATE INDEX IF NOT EXISTS ix_series_colkey       ON series(col_key);
    CREATE INDEX IF NOT EXISTS ix_metrics_hot         ON series_metrics(hot_score);
    CREATE INDEX IF NOT EXISTS ix_metrics_total       ON series_metrics(total_views);
    CREATE INDEX IF NOT EXISTS ix_metrics_velocity    ON series_metrics(velocity);
  `)
  db.exec('ANALYZE')
}

/**
 * DB を開いて PRAGMA を適用して返す。
 * @param {string} dbPath ':memory:' でインメモリDB
 */
export function openDatabase(dbPath) {
  const db = new Database(dbPath)
  applyPragma(db)
  return db
}

/** meta_state（単一行）を取得または初期化 */
export function getMetaState(db) {
  let row = db.prepare('SELECT * FROM meta_state WHERE id = 1').get()
  if (!row) {
    db.prepare('INSERT INTO meta_state(id) VALUES(1)').run()
    row = db.prepare('SELECT * FROM meta_state WHERE id = 1').get()
  }
  return row
}

const ALLOWED_META_KEYS = new Set([
  'rss_last_guid',
  'snapshot_last_start_time',
  'snapshot_version_last_modified',
  'last_full_refresh_at',
])

/** meta_state を更新 */
export function updateMetaState(db, fields) {
  const keys = Object.keys(fields)
  for (const k of keys) {
    if (!ALLOWED_META_KEYS.has(k)) throw new Error(`updateMetaState: unknown key "${k}"`)
  }
  const sets = keys.map((k) => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE meta_state SET ${sets} WHERE id = 1`).run(fields)
}

/**
 * エピソードを一括 UPSERT（トランザクション）。
 * - prev_view_counter に既存値を退避してから最新に更新（delta 用・1スロット）
 * - 初回は prev_view_counter = NULL
 * @param {string} now - ISO8601 タイムスタンプ
 */
export function bulkUpsertEpisodes(db, episodes, now = new Date().toISOString()) {
  const stmt = db.prepare(`
    INSERT INTO episodes(
      content_id, series_id, episode_no, title,
      view_counter, prev_view_counter,
      comment_counter, like_counter, mylist_counter,
      length_seconds, start_time, thumbnail_url,
      tags, description, last_updated
    ) VALUES (
      @contentId, @seriesId, @episodeNo, @title,
      @viewCounter, NULL,
      @commentCounter, @likeCounter, @mylistCounter,
      @lengthSeconds, @startTime, @thumbnailUrl,
      @tags, @description, @now
    )
    ON CONFLICT(content_id) DO UPDATE SET
      prev_view_counter = view_counter,
      view_counter      = excluded.view_counter,
      comment_counter   = excluded.comment_counter,
      like_counter      = excluded.like_counter,
      mylist_counter    = excluded.mylist_counter,
      length_seconds    = excluded.length_seconds,
      thumbnail_url     = excluded.thumbnail_url,
      tags              = excluded.tags,
      description       = excluded.description,
      last_updated      = excluded.last_updated
  `)

  const runBatch = db.transaction((items) => {
    for (const ep of items) {
      stmt.run({
        contentId: ep.contentId,
        seriesId: ep.seriesId ?? null,
        episodeNo: ep.episodeNo ?? null,
        title: ep.title ?? null,
        viewCounter: ep.viewCounter ?? ep.view_counter ?? 0,
        commentCounter: ep.commentCounter ?? ep.comment_counter ?? 0,
        likeCounter: ep.likeCounter ?? ep.like_counter ?? 0,
        mylistCounter: ep.mylistCounter ?? ep.mylist_counter ?? 0,
        lengthSeconds: ep.lengthSeconds ?? ep.length_seconds ?? null,
        startTime: ep.startTime ?? ep.start_time ?? null,
        thumbnailUrl: ep.thumbnailUrl ?? ep.thumbnail_url ?? null,
        tags: ep.tags ?? null,
        description: ep.description ?? null,
        now,
      })
    }
  })

  runBatch(episodes)
  logger.info('db', 'bulk upsert complete', { count: episodes.length })
}

/**
 * シリーズを一括 UPSERT（重複は title/thumbnail_url を更新）
 * @param {{ seriesId: number, title: string, thumbnailUrl?: string|null }[]} seriesList
 */
export function bulkUpsertSeries(db, seriesList, now = new Date().toISOString()) {
  const stmt = db.prepare(`
    INSERT INTO series(series_id, title, thumbnail_url, is_available, updated_at)
    VALUES (@seriesId, @title, @thumbnailUrl, 1, @now)
    ON CONFLICT(series_id) DO UPDATE SET
      title         = excluded.title,
      thumbnail_url = COALESCE(excluded.thumbnail_url, thumbnail_url),
      is_available  = 1,
      updated_at    = excluded.updated_at
  `)
  const run = db.transaction((items) => {
    for (const s of items) {
      stmt.run({
        seriesId: s.seriesId,
        title: s.title,
        thumbnailUrl: s.thumbnailUrl ?? null,
        now,
      })
    }
  })
  run(seriesList)
  logger.info('db', 'series upsert complete', { count: seriesList.length })
}

/**
 * episodes の series_id と episode_no を更新（nvapi 由来）
 * @param {{ contentId: string, seriesId: number, episodeNo: number }[]} updates
 */
export function updateEpisodeOrderBatch(db, updates) {
  const stmt = db.prepare(
    'UPDATE episodes SET series_id = @seriesId, episode_no = @episodeNo WHERE content_id = @contentId'
  )
  const run = db.transaction((items) => {
    for (const u of items) stmt.run(u)
  })
  run(updates)
}

/**
 * series の任意フィールドを更新（ホワイトリスト制）
 */
const ALLOWED_SERIES_KEYS = new Set([
  'col_key',
  'description_first',
  'first_seen',
  'last_seen',
  'cours',
  'franchise_key',
  'is_available',
  'updated_at',
])

export function updateSeriesFields(db, seriesId, fields) {
  const keys = Object.keys(fields)
  for (const k of keys) {
    if (!ALLOWED_SERIES_KEYS.has(k)) throw new Error(`updateSeriesFields: unknown key "${k}"`)
  }
  if (!keys.length) return
  const sets = keys.map((k) => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE series SET ${sets} WHERE series_id = @seriesId`).run({ ...fields, seriesId })
}

/**
 * episodes.thumbnail_url → series.thumbnail_url を同期（NULL のシリーズのみ）
 * 各シリーズの最古エピソードのサムネを使う
 */
export function syncSeriesThumbnails(db) {
  db.exec(`
    UPDATE series
    SET thumbnail_url = (
      SELECT e.thumbnail_url FROM episodes e
      WHERE e.series_id = series.series_id
        AND e.thumbnail_url IS NOT NULL
      ORDER BY e.start_time ASC, e.content_id ASC
      LIMIT 1
    )
    WHERE thumbnail_url IS NULL
  `)
}

/**
 * 全シリーズの first_seen / last_seen を episodes から set-based で同期
 */
export function syncSeriesTimestamps(db) {
  db.exec(`
    UPDATE series
    SET
      first_seen = (SELECT MIN(e.start_time) FROM episodes e WHERE e.series_id = series.series_id),
      last_seen  = (SELECT MAX(e.start_time) FROM episodes e WHERE e.series_id = series.series_id)
    WHERE EXISTS (SELECT 1 FROM episodes e WHERE e.series_id = series.series_id)
  `)
}

/**
 * タグを UPSERT して tag_id を返す
 */
export function upsertTag(db, name, isCurated = 0) {
  db.prepare(
    'INSERT INTO tags(name, is_curated) VALUES(@name, @isCurated) ON CONFLICT(name) DO NOTHING'
  ).run({ name, isCurated })
  return db.prepare('SELECT tag_id FROM tags WHERE name = ?').get(name).tag_id
}

/**
 * シリーズの series_tags を全置換する
 * @param {{ name: string, isCurated: boolean }[]} tags
 */
export function replaceSeriesTags(db, seriesId, tags) {
  const del = db.prepare('DELETE FROM series_tags WHERE series_id = ?')
  const insTag = db.prepare(
    'INSERT INTO tags(name, is_curated) VALUES(@name, @isCurated) ON CONFLICT(name) DO UPDATE SET is_curated = MAX(is_curated, excluded.is_curated)'
  )
  const insRel = db.prepare(
    'INSERT OR IGNORE INTO series_tags(series_id, tag_id) VALUES(@seriesId, (SELECT tag_id FROM tags WHERE name = @name))'
  )
  const run = db.transaction(() => {
    del.run(seriesId)
    for (const t of tags) {
      insTag.run({ name: t.name, isCurated: t.isCurated ? 1 : 0 })
      insRel.run({ seriesId, name: t.name })
    }
  })
  run()
}

/**
 * RSS items を UPSERT（watch_id で重複排除）
 */
export function bulkUpsertRssItems(db, items) {
  const stmt = db.prepare(`
    INSERT INTO rss_items(watch_id, guid, pub_date, title, title_norm, link, resolution_status)
    VALUES(@watchId, @guid, @pubDate, @title, @titleNorm, @link, 'unresolved')
    ON CONFLICT(watch_id) DO NOTHING
  `)
  const run = db.transaction((rows) => {
    for (const r of rows) stmt.run(r)
  })
  run(items)
}

/**
 * rss_items をローリングウィンドウで有界化（運用監査）。watch_id（新しいほど大きい数値）の
 * 降順で最新 keep 件だけ残し、それ以前を削除する。INSERT のみで無限増大していたのを防ぐ。
 * 落とすのは「すでに episodes に解決済み」または「古い未解決」の行だけで、new.json は最新
 * ~20 件しか使わないため表示・delta に影響しない。keep は new 表示数より十分大きく取る。
 * @returns {number} 削除した行数
 */
export function pruneRssItems(db, keep = 500) {
  const info = db
    .prepare(
      `DELETE FROM rss_items WHERE watch_id NOT IN (
         SELECT watch_id FROM rss_items ORDER BY CAST(watch_id AS INTEGER) DESC LIMIT ?
       )`
    )
    .run(keep)
  return info.changes
}

/**
 * RSS item の解決状態を更新
 */
export function updateRssResolution(db, watchId, resolvedContentId, status) {
  db.prepare(
    'UPDATE rss_items SET resolved_content_id = ?, resolution_status = ? WHERE watch_id = ?'
  ).run(resolvedContentId, status, watchId)
}
