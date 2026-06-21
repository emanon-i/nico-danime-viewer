// scripts/etl/metrics.mjs
// 勢いスコア（Hot Score）Store ベース再計算

export const defaultMetricsConfig = {
  // 候補2（§hot-redesign）: delta=今の伸び(絶対) / rise=相対成長率 / base=per-ep持続人気。
  weights: { delta: 0.5, rise: 0.3, base: 0.2 },
}

/**
 * Store から series_metrics を純 JS で再計算する。
 *
 * hotScore 設計（§hot-redesign・候補2）:
 *   hotScore = 0.5·deltaN + 0.3·riseN + 0.2·baseN
 *   - deltaN = minmax(log1p(max(delta,0)))         今の伸び（絶対・1日増分／負・ゼロは 0）
 *   - riseN  = minmax(log1p(growthRate))           相対成長率＝max(delta,0)/max(totalViews,1)
 *   - baseN  = minmax(log1p(avgViewsPerDay))        per-ep 持続人気＝(totalViews/epCount)/経過日数
 *   いずれも全シリーズ min-max（log 圧縮で外れ値ロバスト）。
 *
 * 旧式からの変更点:
 *   - 長編バイアス源だった velocity（累計÷日数）を per-ep 化（baseN・eps×hot 相関 0.25→約 0）。
 *   - 古い作品を恒久的に不利にしていた recency（exp(−最新話配信日/τ)）を撤廃。伸びは delta が担う。
 *   - delta の正規化を生 min-max → log1p+ゼロ床に変更（外れ値1作支配・ゼロ過多の破綻を回避）。
 *
 * 計算メモ:
 *   - 日数差 ≡ (Date(a)−Date(b)) / 86400000
 *   - delta = SUM(view−prev)。view==null||prev==null の話は寄与 0（null 伝播ガード）。
 *   - epCount は episodeCount（works.json buildEpCountMap と同一＝seriesId を持つ全話数）。
 *   - 単一シリーズ等で max===min のレンジは 0（ゼロ除算ガード）。
 *
 * @param {import('../store/store.mjs').Store} store
 * @param {string} now - ISO8601 タイムスタンプ
 * @param {typeof defaultMetricsConfig} config
 * @returns {Map<number, {totalViews:number,deltaViews:number,growthRate:number,avgViewsPerDay:number,hotScore:number}>}
 */
export function recalcSeriesMetricsJS(store, now, config = defaultMetricsConfig) {
  const { delta: w_delta, rise: w_rise, base: w_base } = config.weights
  const nowMs = new Date(now).getTime()

  // pass1: per-series 集計
  const agg = new Map() // seriesId → {totalViews, deltaViews, epCount, first}
  for (const ep of store.episodes.values()) {
    if (ep.seriesId == null) continue
    let a = agg.get(ep.seriesId)
    if (!a) {
      a = { totalViews: 0, deltaViews: 0, epCount: 0, first: null }
      agg.set(ep.seriesId, a)
    }
    // episodeCount（buildEpCountMap と同基準＝seriesId を持つ話を全数カウント・view 欠落も含む）
    a.epCount += 1
    if (ep.viewCounter != null) a.totalViews += ep.viewCounter
    // SUM(COALESCE(view−prev, 0)): view==null||prev==null → 寄与 0
    if (ep.viewCounter != null && ep.prevViewCounter != null) {
      a.deltaViews += ep.viewCounter - ep.prevViewCounter
    }
    // MIN(start_time): null は無視（first＝初話の配信時刻 → 経過日数の起点）
    if (ep.startTime) {
      const t = new Date(ep.startTime).getTime()
      if (!isNaN(t) && (a.first === null || t < a.first)) a.first = t
    }
  }

  // pass1b: 成分の生値（growthRate / avgViewsPerDay / deltaPos）を導出
  const derived = new Map()
  for (const [sid, a] of agg) {
    const deltaPos = Math.max(0, a.deltaViews) // 今の伸びは増加分のみ（減少・ゼロは 0）
    // 相対成長率＝増加分 ÷ 累計（小規模でも今伸びていれば高い）。累計 0 ガードで 0。
    const growthRate = a.totalViews > 0 ? deltaPos / a.totalViews : 0
    // per-ep 持続人気＝1話あたり平均再生 ÷ 経過日数（長編バイアスを外す）。
    // 初話不明（first=null）は経過日数を 1 とみなす（旧 velocity と同作法の下限ガード）。
    const daysSinceFirst = a.first !== null ? (nowMs - a.first) / 86400000 : 1
    const avgViews = a.epCount > 0 ? a.totalViews / a.epCount : 0
    const avgViewsPerDay = avgViews / Math.max(1, daysSinceFirst)
    derived.set(sid, { ...a, deltaPos, growthRate, avgViewsPerDay })
  }

  // pass2: グローバルレンジ（log1p 後に min-max）。3 成分とも外れ値ロバスト化のため log 圧縮。
  let dMin = Infinity,
    dMax = -Infinity
  let rMin = Infinity,
    rMax = -Infinity
  let bMin = Infinity,
    bMax = -Infinity
  for (const d of derived.values()) {
    const ld = Math.log1p(d.deltaPos)
    if (ld < dMin) dMin = ld
    if (ld > dMax) dMax = ld
    const lr = Math.log1p(d.growthRate)
    if (lr < rMin) rMin = lr
    if (lr > rMax) rMax = lr
    const lb = Math.log1p(d.avgViewsPerDay)
    if (lb < bMin) bMin = lb
    if (lb > bMax) bMax = lb
  }
  const norm = (v, mn, mx) => (mx === mn ? 0 : (Math.log1p(v) - mn) / (mx - mn))

  // pass3: 正規化 + ブレンド
  const metrics = new Map()
  for (const [sid, d] of derived) {
    const deltaN = norm(d.deltaPos, dMin, dMax)
    const riseN = norm(d.growthRate, rMin, rMax)
    const baseN = norm(d.avgViewsPerDay, bMin, bMax)
    const hotScore = w_delta * deltaN + w_rise * riseN + w_base * baseN
    metrics.set(sid, {
      totalViews: d.totalViews,
      deltaViews: d.deltaViews, // 総再生増（生値・参考用に保持）
      growthRate: d.growthRate, // 相対成長率（rise 成分の元値）
      avgViewsPerDay: d.avgViewsPerDay, // per-ep 持続人気（base 成分の元値）
      hotScore,
    })
  }
  return metrics
}
