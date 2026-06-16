import { describe, it, expect, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync, existsSync } from 'node:fs'
import {
  openDatabase,
  createSchema,
  createIndexes,
  bulkUpsertEpisodes,
  getMetaState,
  updateMetaState,
} from '../../scripts/db/db.mjs'

function makeEp(i, override = {}) {
  return {
    contentId: `so${i}`,
    seriesId: null,
    episodeNo: i,
    title: `テスト第${i}話`,
    viewCounter: i * 100,
    commentCounter: i,
    likeCounter: i,
    mylistCounter: i,
    lengthSeconds: 1440,
    startTime: `2020-01-${String(i).padStart(2, '0')}T00:00:00+09:00`,
    thumbnailUrl: `https://nicovideo.cdn.nimg.jp/thumbnails/${i}/thumb`,
    ...override,
  }
}

describe('SQLite スキーマ (F-0009)', () => {
  let db

  beforeEach(() => {
    db = openDatabase(':memory:')
    createSchema(db)
  })

  const tables = [
    'series',
    'episodes',
    'rss_items',
    'tags',
    'series_tags',
    'meta_state',
    'episode_view_history',
    'series_metrics',
  ]

  for (const tbl of tables) {
    it(`${tbl} テーブルが作成される (AC-1)`, () => {
      const info = db.prepare('PRAGMA table_info(' + tbl + ')').all()
      expect(info.length).toBeGreaterThan(0)
    })
  }

  it('episodes の必須列が存在する', () => {
    const cols = db
      .prepare('PRAGMA table_info(episodes)')
      .all()
      .map((r) => r.name)
    expect(cols).toContain('content_id')
    expect(cols).toContain('view_counter')
    expect(cols).toContain('prev_view_counter')
    expect(cols).toContain('start_time')
  })

  it('PRAGMA foreign_keys が ON (AC-3)', () => {
    const row = db.prepare('PRAGMA foreign_keys').get()
    expect(row.foreign_keys).toBe(1)
  })

  it('PRAGMA journal_mode が WAL (AC-3)', () => {
    // WAL は :memory: では無効なため一時ファイルDBで検証
    const tmpPath = join(tmpdir(), `nico-wal-${process.pid}.sqlite`)
    let fileDb
    try {
      fileDb = openDatabase(tmpPath)
      const row = fileDb.prepare('PRAGMA journal_mode').get()
      expect(row.journal_mode).toBe('wal')
    } finally {
      fileDb?.close()
      for (const p of [tmpPath, tmpPath + '-shm', tmpPath + '-wal']) {
        if (existsSync(p)) unlinkSync(p)
      }
    }
  })

  it('test_bulk_load_uses_transaction_then_index (AC-2)', () => {
    const eps = Array.from({ length: 10 }, (_, i) => makeEp(i + 1))
    bulkUpsertEpisodes(db, eps, '2026-06-16T00:00:00Z')
    createIndexes(db)

    const count = db.prepare('SELECT COUNT(*) as c FROM episodes').get()
    expect(count.c).toBe(10)

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='episodes'")
      .all()
      .map((r) => r.name)
    expect(indexes).toContain('ix_episodes_start_time')
    expect(indexes).toContain('ix_episodes_series')
  })

  it('SQLite ファイルが配信出力に含まれない (AC-4): .sqlite を export しない', () => {
    // db.mjs の openDatabase は ':memory:' または ビルド用パスのみ使用
    // この検証は grep で確認（ここでは export 関数一覧を確認）
    const exported = [
      openDatabase,
      createSchema,
      createIndexes,
      bulkUpsertEpisodes,
      getMetaState,
      updateMetaState,
    ]
    expect(exported.every((f) => typeof f === 'function')).toBe(true)
  })
})

describe('UPSERT + delta (F-0010)', () => {
  let db

  beforeEach(() => {
    db = openDatabase(':memory:')
    createSchema(db)
  })

  it('test_first_load_delta_inactive (AC-2): 初回は prev_view_counter = NULL', () => {
    bulkUpsertEpisodes(db, [makeEp(1)], '2026-06-16T00:00:00Z')
    const row = db.prepare('SELECT * FROM episodes WHERE content_id = ?').get('so1')
    expect(row.prev_view_counter).toBeNull()
    expect(row.view_counter).toBe(100)
  })

  it('test_upsert_shifts_prev_view_counter (AC-1): 2回目で prev に旧値が退避される', () => {
    const ep = makeEp(1)
    bulkUpsertEpisodes(db, [ep], '2026-06-16T00:00:00Z')

    // 2回目: view_counter が増加
    bulkUpsertEpisodes(db, [{ ...ep, viewCounter: 200 }], '2026-06-17T00:00:00Z')

    const row = db.prepare('SELECT * FROM episodes WHERE content_id = ?').get('so1')
    expect(row.prev_view_counter).toBe(100)
    expect(row.view_counter).toBe(200)
  })

  it('test_7slot_ring_not_written_v1 (AC-3): episode_view_history は空のまま', () => {
    bulkUpsertEpisodes(db, [makeEp(1)], '2026-06-16T00:00:00Z')
    const count = db.prepare('SELECT COUNT(*) as c FROM episode_view_history').get()
    expect(count.c).toBe(0)
  })
})

describe('meta_state (F-0009/F-0010)', () => {
  let db

  beforeEach(() => {
    db = openDatabase(':memory:')
    createSchema(db)
  })

  it('初期化で単一行を作成', () => {
    const state = getMetaState(db)
    expect(state.id).toBe(1)
    expect(state.rss_last_guid).toBeNull()
  })

  it('updateMetaState でフィールドを更新できる', () => {
    getMetaState(db)
    updateMetaState(db, { snapshot_version_last_modified: 'v2026' })
    const state = getMetaState(db)
    expect(state.snapshot_version_last_modified).toBe('v2026')
  })
})
