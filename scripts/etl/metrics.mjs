// scripts/etl/metrics.mjs
// 勢いスコア（Hot Score）set-based 再計算

import { registerCustomFunctions } from '../db/db.mjs'

export const defaultMetricsConfig = {
  weights: { delta: 0.5, velocity: 0.3, recency: 0.2 },
  tau: 14, // 指数減衰の時定数（日）
}

/**
 * series_metrics を set-based（単一 SQL）で再計算する。
 * hot_score = 0.5*delta_n + 0.3*velocity_n + 0.2*recency_n
 * @param {import('better-sqlite3').Database} db
 * @param {string} now - ISO8601 タイムスタンプ
 * @param {typeof defaultMetricsConfig} config
 */
export function recalcSeriesMetrics(db, now, config = defaultMetricsConfig) {
  registerCustomFunctions(db)

  const { delta, velocity, recency } = config.weights
  const { tau } = config

  db.prepare(
    `
    INSERT OR REPLACE INTO series_metrics(series_id, total_views, delta_views, velocity, recency, hot_score, updated_at)
    WITH ep_agg AS (
      SELECT
        series_id,
        SUM(CAST(view_counter AS REAL))                                           AS total_views,
        SUM(COALESCE(
          CAST(view_counter AS REAL) - CAST(prev_view_counter AS REAL), 0.0
        ))                                                                        AS delta_views,
        MAX(start_time)                                                           AS latest_ep_time,
        MIN(start_time)                                                           AS first_ep_time
      FROM episodes
      WHERE series_id IS NOT NULL
      GROUP BY series_id
    ),
    derived AS (
      SELECT
        series_id,
        total_views,
        delta_views,
        total_views / MAX(1.0, julianday(@now) - julianday(first_ep_time))        AS velocity,
        julianday(@now) - julianday(latest_ep_time)                               AS recency_days
      FROM ep_agg
    ),
    ranges AS (
      SELECT
        MIN(delta_views)       AS delta_min,
        MAX(delta_views)       AS delta_max,
        MIN(log1p(velocity))   AS vel_log_min,
        MAX(log1p(velocity))   AS vel_log_max
      FROM derived
    ),
    normalized AS (
      SELECT
        d.series_id, d.total_views, d.delta_views, d.velocity, d.recency_days,
        CASE WHEN r.delta_max = r.delta_min THEN 0.0
             ELSE (d.delta_views - r.delta_min) / (r.delta_max - r.delta_min)
        END AS delta_n,
        CASE WHEN r.vel_log_max = r.vel_log_min THEN 0.0
             ELSE (log1p(d.velocity) - r.vel_log_min) / (r.vel_log_max - r.vel_log_min)
        END AS velocity_n,
        exp_neg_div(d.recency_days, @tau) AS recency_n
      FROM derived d, ranges r
    )
    SELECT
      series_id,
      total_views,
      delta_views,
      velocity,
      exp_neg_div(recency_days, @tau)                              AS recency,
      (@w_delta * delta_n + @w_velocity * velocity_n + @w_recency * recency_n) AS hot_score,
      @now
    FROM normalized
    `
  ).run({ now, tau, w_delta: delta, w_velocity: velocity, w_recency: recency })
}
