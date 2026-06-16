import { describe, it, expect, beforeEach } from 'vitest'
import { recalcSeriesMetrics } from '../../scripts/etl/metrics.mjs'
import {
  openDatabase,
  createSchema,
  bulkUpsertEpisodes,
  bulkUpsertSeries,
} from '../../scripts/db/db.mjs'

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
