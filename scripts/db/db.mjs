// scripts/db/db.mjs
// SQLite ビルドDB: スキーマ作成・PRAGMA・一括UPSERT・delta管理

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
      length_seconds, start_time, thumbnail_url, last_updated
    ) VALUES (
      @contentId, @seriesId, @episodeNo, @title,
      @viewCounter, NULL,
      @commentCounter, @likeCounter, @mylistCounter,
      @lengthSeconds, @startTime, @thumbnailUrl, @now
    )
    ON CONFLICT(content_id) DO UPDATE SET
      prev_view_counter = view_counter,
      view_counter      = excluded.view_counter,
      comment_counter   = excluded.comment_counter,
      like_counter      = excluded.like_counter,
      mylist_counter    = excluded.mylist_counter,
      length_seconds    = excluded.length_seconds,
      thumbnail_url     = excluded.thumbnail_url,
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
        now,
      })
    }
  })

  runBatch(episodes)
  logger.info('db', 'bulk upsert complete', { count: episodes.length })
}
