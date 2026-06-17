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

/**
 * Store から series_metrics を純 JS で再計算する（SQL CTE の等価移植・§A-5）。
 *
 * SQL⇄JS 等価要点:
 *  - julianday 差 ≡ (Date(a)−Date(b)) / 86400000（SQLite は naive datetime → UTC 解釈）
 *  - SUM(COALESCE(view−prev, 0)) の null 伝播: view==null||prev==null → 0（Opus §1 修正）
 *  - exp_neg_div(x, tau) ≡ Math.exp(−(x??0)/tau)（null→1.0）
 *  - MIN/MAX は null を無視（derived では velocity/recencyDays は非null なので問題なし）
 *  - ranges が単一シリーズ → delta_max===delta_min → delta_n = 0
 *
 * @param {import('../store/store.mjs').Store} store
 * @param {string} now - ISO8601 タイムスタンプ
 * @param {typeof defaultMetricsConfig} config
 * @returns {Map<number, {totalViews:number,deltaViews:number,velocity:number,recency:number,hotScore:number}>}
 */
export function recalcSeriesMetricsJS(store, now, config = defaultMetricsConfig) {
  const { delta: w_delta, velocity: w_vel, recency: w_rec } = config.weights
  const { tau } = config
  const nowMs = new Date(now).getTime()

  // pass1: per-series 集計（SQL ep_agg CTE 相当）
  const agg = new Map() // seriesId → {totalViews, deltaViews, latest, first}
  for (const ep of store.episodes.values()) {
    if (ep.seriesId == null) continue
    let a = agg.get(ep.seriesId)
    if (!a) {
      a = { totalViews: 0, deltaViews: 0, latest: null, first: null }
      agg.set(ep.seriesId, a)
    }
    // SUM(CAST(view_counter AS REAL)) - SQL は NULL を無視
    if (ep.viewCounter != null) a.totalViews += ep.viewCounter
    // SUM(COALESCE(view−prev, 0)) - view==null||prev==null → 0（Opus §1）
    if (ep.viewCounter != null && ep.prevViewCounter != null) {
      a.deltaViews += ep.viewCounter - ep.prevViewCounter
    }
    // MAX/MIN(start_time): null を無視（startTime が null なら latest/first に影響させない）
    if (ep.startTime) {
      const t = new Date(ep.startTime).getTime()
      if (!isNaN(t)) {
        if (a.latest === null || t > a.latest) a.latest = t
        if (a.first === null || t < a.first) a.first = t
      }
    }
  }

  // pass1b: velocity / recencyDays（SQL derived CTE 相当）
  const derived = new Map()
  for (const [sid, a] of agg) {
    // null first → julianday(NULL) = NULL → MAX(1.0, NULL) = 1.0 → velocity = total/1.0
    const daysSinceFirst = a.first !== null ? (nowMs - a.first) / 86400000 : null
    const velocity = a.totalViews / Math.max(1.0, daysSinceFirst ?? 1.0)
    // null latest → recency_days = NULL → exp_neg_div(NULL,tau) = exp(0) = 1.0
    const recencyDays = a.latest !== null ? (nowMs - a.latest) / 86400000 : null
    derived.set(sid, { ...a, velocity, recencyDays })
  }

  // pass2: グローバルレンジ（SQL ranges CTE 相当）
  let deltaMin = Infinity,
    deltaMax = -Infinity
  let velLogMin = Infinity,
    velLogMax = -Infinity
  for (const d of derived.values()) {
    if (d.deltaViews < deltaMin) deltaMin = d.deltaViews
    if (d.deltaViews > deltaMax) deltaMax = d.deltaViews
    const logV = Math.log1p(d.velocity)
    if (logV < velLogMin) velLogMin = logV
    if (logV > velLogMax) velLogMax = logV
  }

  // pass3: 正規化 + ブレンド（SQL normalized + SELECT 相当）
  const metrics = new Map()
  for (const [sid, d] of derived) {
    const deltaN = deltaMax === deltaMin ? 0 : (d.deltaViews - deltaMin) / (deltaMax - deltaMin)
    const velocityN =
      velLogMax === velLogMin ? 0 : (Math.log1p(d.velocity) - velLogMin) / (velLogMax - velLogMin)
    const recencyN = Math.exp(-((d.recencyDays ?? 0) / tau)) // exp_neg_div 等価
    const hotScore = w_delta * deltaN + w_vel * velocityN + w_rec * recencyN
    metrics.set(sid, {
      totalViews: d.totalViews,
      deltaViews: d.deltaViews,
      velocity: d.velocity,
      recency: recencyN,
      hotScore,
    })
  }
  return metrics
}
