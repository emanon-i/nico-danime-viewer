import { describe, it, expect, beforeEach } from 'vitest'
import { recalcSeriesMetrics, recalcSeriesMetricsJS } from '../../scripts/etl/metrics.mjs'
import {
  openDatabase,
  createSchema,
  bulkUpsertEpisodes,
  bulkUpsertSeries,
} from '../../scripts/db/db.mjs'
import {
  createStore,
  upsertEpisodes as storeUpsertEps,
  upsertSeries as storeUpsertSeries,
} from '../../scripts/store/store.mjs'

const EPSILON = 1e-9

function setupDb() {
  const db = openDatabase(':memory:')
  createSchema(db)
  return db
}

const NOW = '2026-06-16T00:00:00+09:00'

describe('recalcSeriesMetrics (F-0018)', () => {
  let db

  beforeEach(() => {
    db = setupDb()
    bulkUpsertSeries(
      db,
      [
        { seriesId: 1, title: 'シリーズA' },
        { seriesId: 2, title: 'シリーズB' },
      ],
      NOW
    )
  })

  it('test_hot_score_in_range: hot_score が 0〜1 の範囲に収まる', () => {
    bulkUpsertEpisodes(
      db,
      [
        {
          contentId: 'so1',
          seriesId: 1,
          title: '第1話',
          viewCounter: 1000,
          startTime: '2026-06-10T00:00:00+09:00',
        },
        {
          contentId: 'so2',
          seriesId: 2,
          title: '第1話',
          viewCounter: 500,
          startTime: '2026-06-01T00:00:00+09:00',
        },
      ],
      NOW
    )

    recalcSeriesMetrics(db, NOW)

    const rows = db.prepare('SELECT * FROM series_metrics').all()
    expect(rows.length).toBeGreaterThan(0)

    for (const row of rows) {
      expect(row.hot_score).toBeGreaterThanOrEqual(0.0)
      expect(row.hot_score).toBeLessThanOrEqual(1.0)
    }
  })

  it('test_set_based_metrics_update: 全シリーズが1回の SQL で更新される', () => {
    bulkUpsertEpisodes(
      db,
      [
        {
          contentId: 'so10',
          seriesId: 1,
          title: 'ep1',
          viewCounter: 200,
          startTime: '2026-06-15T00:00:00+09:00',
        },
        {
          contentId: 'so20',
          seriesId: 2,
          title: 'ep1',
          viewCounter: 100,
          startTime: '2026-06-14T00:00:00+09:00',
        },
      ],
      NOW
    )

    recalcSeriesMetrics(db, NOW)

    const metrics1 = db.prepare('SELECT * FROM series_metrics WHERE series_id = 1').get()
    const metrics2 = db.prepare('SELECT * FROM series_metrics WHERE series_id = 2').get()

    expect(metrics1).toBeTruthy()
    expect(metrics2).toBeTruthy()
    expect(metrics1.total_views).toBe(200)
    expect(metrics2.total_views).toBe(100)
  })

  it('test_delta_score: delta_views は prev_view_counter との差（prev なしは 0）', () => {
    bulkUpsertEpisodes(
      db,
      [
        {
          contentId: 'so100',
          seriesId: 1,
          title: 'ep1',
          viewCounter: 999,
          startTime: '2026-06-15T00:00:00+09:00',
        },
      ],
      NOW
    )

    // prev_view_counter が NULL のため delta = 0
    recalcSeriesMetrics(db, NOW)
    const row = db.prepare('SELECT delta_views FROM series_metrics WHERE series_id = 1').get()
    expect(row.delta_views).toBe(0)
  })

  it('custom config でウェイトを変更できる', () => {
    bulkUpsertEpisodes(
      db,
      [
        {
          contentId: 'so1',
          seriesId: 1,
          title: 'ep1',
          viewCounter: 100,
          startTime: '2026-06-15T00:00:00+09:00',
        },
        {
          contentId: 'so2',
          seriesId: 2,
          title: 'ep1',
          viewCounter: 50,
          startTime: '2026-06-01T00:00:00+09:00',
        },
      ],
      NOW
    )

    // delta=0.9, velocity=0.05, recency=0.05 — recency-heavy ではなく delta-heavy
    recalcSeriesMetrics(db, NOW, {
      weights: { delta: 0.9, velocity: 0.05, recency: 0.05 },
      tau: 14,
    })

    const rows = db.prepare('SELECT * FROM series_metrics').all()
    expect(rows.length).toBe(2)
    // hot_score は 0〜1 の範囲
    for (const r of rows) {
      expect(r.hot_score).toBeGreaterThanOrEqual(0)
      expect(r.hot_score).toBeLessThanOrEqual(1)
    }
  })

  it('2回実行で INSERT OR REPLACE が動く（重複エラーなし）', () => {
    bulkUpsertEpisodes(
      db,
      [
        {
          contentId: 'so1',
          seriesId: 1,
          title: 'ep1',
          viewCounter: 100,
          startTime: '2026-06-15T00:00:00+09:00',
        },
      ],
      NOW
    )
    expect(() => {
      recalcSeriesMetrics(db, NOW)
      recalcSeriesMetrics(db, NOW)
    }).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// M2: SQL ⇄ JS 同値テスト
// 同じフィクスチャを DB（SQLite）と Store（JS）に流し、計算結果が一致することを確認。
// ─────────────────────────────────────────────────────────────────────────────
describe('M2: SQL⇄JS metrics equivalence (PH-0008)', () => {
  let db
  let store

  // 1回目 upsert（series 10 のみ。2回目で prev に退避される「旧値」）
  const EPS_FIRST = [
    {
      contentId: 'so10a',
      seriesId: 10,
      title: 'ep1',
      viewCounter: 800,
      startTime: '2026-06-10T00:00:00+09:00',
    },
    {
      contentId: 'so10b',
      seriesId: 10,
      title: 'ep2',
      viewCounter: 150,
      startTime: '2026-06-08T00:00:00+09:00',
    },
  ]
  // 2回目 upsert（series 10 の新値 + series 20 の初回）
  // so20 を初回のみ upsert → DB/Store 共に prev=NULL → delta=0
  const EPS_SECOND = [
    {
      contentId: 'so10a',
      seriesId: 10,
      title: 'ep1',
      viewCounter: 1000,
      startTime: '2026-06-10T00:00:00+09:00',
    },
    {
      contentId: 'so10b',
      seriesId: 10,
      title: 'ep2',
      viewCounter: 200,
      startTime: '2026-06-08T00:00:00+09:00',
    },
    {
      contentId: 'so20',
      seriesId: 20,
      title: 'ep1',
      viewCounter: 500,
      startTime: '2026-06-01T00:00:00+09:00',
    },
  ]
  const ALL_SERIES = [
    { seriesId: 10, title: 'シリーズ10' },
    { seriesId: 20, title: 'シリーズ20' },
  ]

  beforeEach(() => {
    db = setupDb()
    store = createStore()

    bulkUpsertSeries(db, ALL_SERIES, NOW)
    storeUpsertSeries(store, ALL_SERIES)

    // series 10: 2回 upsert → DB: ON CONFLICT SET prev_view_counter=view_counter
    //                        → Store: existing.prevViewCounter = existing.viewCounter
    // series 20: 1回のみ  → DB/Store 共に prev=NULL → delta=0
    bulkUpsertEpisodes(db, EPS_FIRST, NOW)
    storeUpsertEps(store, EPS_FIRST)
    bulkUpsertEpisodes(db, EPS_SECOND, NOW)
    storeUpsertEps(store, EPS_SECOND)
  })

  it('hot_score / totalViews / deltaViews が SQL と JS で一致する（epsilon=1e-9）', () => {
    recalcSeriesMetrics(db, NOW)
    const jsMap = recalcSeriesMetricsJS(store, NOW)

    for (const sid of [10, 20]) {
      const sql = db.prepare('SELECT * FROM series_metrics WHERE series_id = ?').get(sid)
      const js = jsMap.get(sid)

      expect(sql, `series ${sid} が series_metrics に存在しない`).toBeTruthy()
      expect(js, `series ${sid} が JS metrics に存在しない`).toBeTruthy()

      expect(
        Math.abs(sql.total_views - js.totalViews),
        `totalViews 不一致 series=${sid}: sql=${sql.total_views} js=${js.totalViews}`
      ).toBeLessThanOrEqual(EPSILON)

      expect(
        Math.abs(sql.delta_views - js.deltaViews),
        `deltaViews 不一致 series=${sid}: sql=${sql.delta_views} js=${js.deltaViews}`
      ).toBeLessThanOrEqual(EPSILON)

      expect(
        Math.abs(sql.hot_score - js.hotScore),
        `hotScore 不一致 series=${sid}: sql=${sql.hot_score} js=${js.hotScore}`
      ).toBeLessThanOrEqual(EPSILON)
    }
  })

  it('prevViewCounter が null の episode は delta=0（series 20: prev null → delta=0）', () => {
    recalcSeriesMetrics(db, NOW)
    const jsMap = recalcSeriesMetricsJS(store, NOW)

    const sqlDelta = db
      .prepare('SELECT delta_views FROM series_metrics WHERE series_id = ?')
      .get(20)
    const jsDelta = jsMap.get(20)

    expect(sqlDelta.delta_views).toBe(0)
    expect(jsDelta.deltaViews).toBe(0)
  })

  it('series 10 の多エピソード totalViews / deltaViews が正しい', () => {
    // so10a: viewCounter=1000, prev=800 → delta=200
    // so10b: viewCounter=200,  prev=150 → delta=50
    // total: 1200, delta: 250
    recalcSeriesMetrics(db, NOW)
    const jsMap = recalcSeriesMetricsJS(store, NOW)

    const sqlRow = db.prepare('SELECT * FROM series_metrics WHERE series_id = ?').get(10)
    const jsRow = jsMap.get(10)

    expect(sqlRow.total_views).toBeCloseTo(1200, 9)
    expect(jsRow.totalViews).toBeCloseTo(1200, 9)
    expect(sqlRow.delta_views).toBeCloseTo(250, 9)
    expect(jsRow.deltaViews).toBeCloseTo(250, 9)
  })

  it('null viewCounter は JS で totalViews / deltaViews に寄与しない', () => {
    // Store のみで null viewCounter のケースを検証（SQL との対称性は series 内に有効 ep が必要）
    storeUpsertSeries(store, [{ seriesId: 30, title: 'シリーズ30' }])
    storeUpsertEps(store, [
      {
        contentId: 'so30a',
        seriesId: 30,
        title: 'ep1',
        viewCounter: 800,
        startTime: '2026-06-05T00:00:00+09:00',
      },
      {
        contentId: 'so30b',
        seriesId: 30,
        title: 'ep2',
        viewCounter: 300,
        startTime: '2026-06-03T00:00:00+09:00',
      },
    ])
    storeUpsertEps(store, [
      {
        contentId: 'so30a',
        seriesId: 30,
        title: 'ep1',
        viewCounter: 1000,
        startTime: '2026-06-05T00:00:00+09:00',
      },
    ])
    // so30b: viewCounter を null に設定（null は totalViews/deltaViews に寄与しない）
    const ep30b = store.episodes.get('so30b')
    ep30b.prevViewCounter = ep30b.viewCounter // 300 を prev に退避
    ep30b.viewCounter = null

    const jsMap = recalcSeriesMetricsJS(store, NOW)
    const js = jsMap.get(30)

    expect(js.totalViews).toBe(1000) // null viewCounter は加算されない
    expect(js.deltaViews).toBe(200) // so30a のみ寄与: 1000-800=200
  })

  it('null startTime は JS でクラッシュせず hot_score が 0〜1 の範囲に収まる', () => {
    storeUpsertSeries(store, [{ seriesId: 40, title: 'シリーズ40' }])
    storeUpsertEps(store, [
      { contentId: 'so40', seriesId: 40, title: 'ep1', viewCounter: 50, startTime: null },
    ])
    storeUpsertEps(store, [
      { contentId: 'so40', seriesId: 40, title: 'ep1', viewCounter: 100, startTime: null },
    ])

    let jsMap
    expect(() => {
      jsMap = recalcSeriesMetricsJS(store, NOW)
    }).not.toThrow()

    const js = jsMap.get(40)
    expect(js).toBeTruthy()
    expect(js.deltaViews).toBe(50) // 100 - 50
    expect(js.hotScore).toBeGreaterThanOrEqual(0)
    expect(js.hotScore).toBeLessThanOrEqual(1)
  })

  it('カスタム config でも SQL と JS の hot_score が一致する', () => {
    const config = { weights: { delta: 0.9, velocity: 0.05, recency: 0.05 }, tau: 14 }
    recalcSeriesMetrics(db, NOW, config)
    const jsMap = recalcSeriesMetricsJS(store, NOW, config)

    for (const sid of [10, 20]) {
      const sql = db.prepare('SELECT hot_score FROM series_metrics WHERE series_id = ?').get(sid)
      const js = jsMap.get(sid)
      expect(
        Math.abs(sql.hot_score - js.hotScore),
        `カスタム config hot_score 不一致 series=${sid}`
      ).toBeLessThanOrEqual(EPSILON)
    }
  })
})
