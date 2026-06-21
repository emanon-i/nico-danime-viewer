import { describe, it, expect } from 'vitest'
import { recalcSeriesMetricsJS } from '../../scripts/etl/metrics.mjs'

// recalcSeriesMetricsJS は store.episodes（Map: contentId → {seriesId,viewCounter,prevViewCounter,startTime}）
// だけを参照する。最小の擬似 Store で hotScore 候補2（§hot-redesign）の各成分を検証する。
function makeStore(episodes) {
  return { episodes: new Map(episodes.map((e, i) => [e.contentId ?? `so${i}`, e])) }
}

const NOW = '2026-06-20T00:00:00Z'
const ST = '2026-06-10T00:00:00Z' // 初話＝経過 10 日（base 成分で全シリーズ共通なら比率は保たれる）

// 成分を 1 つだけ見るための重み（min-max は全シリーズ横断なので 2 件以上で非退化）
const deltaOnly = { weights: { delta: 1, rise: 0, base: 0 } }
const riseOnly = { weights: { delta: 0, rise: 1, base: 0 } }

describe('recalcSeriesMetricsJS: hotScore 候補2（§hot-redesign）', () => {
  it('delta 成分: 増加分のみ評価し、減少・ゼロは 0 床（負 delta は 0 寄与）', () => {
    // A: +400（増）／ B: −200（減＝伸びていない → 0 床）
    const store = makeStore([
      { seriesId: 1, viewCounter: 500, prevViewCounter: 100, startTime: ST },
      { seriesId: 2, viewCounter: 100, prevViewCounter: 300, startTime: ST },
    ])
    const m = recalcSeriesMetricsJS(store, NOW, deltaOnly)
    expect(m.get(1).deltaViews).toBe(400)
    expect(m.get(2).deltaViews).toBe(-200) // 生値は保持
    expect(m.get(1).hotScore).toBeGreaterThan(m.get(2).hotScore)
    expect(m.get(2).hotScore).toBeCloseTo(0, 10) // 減少作は delta 成分 0
  })

  it('base 成分: per-ep 持続人気で短編が長編を上回る（長編バイアス除去）', () => {
    // A: 4話・総8000（平均2000/話）／ B: 1話・総4000（平均4000/話）
    // 累計は A>B だが、per-ep 平均は B>A → base 成分は B が上位。
    const store = makeStore([
      { seriesId: 1, viewCounter: 2000, prevViewCounter: 2000, startTime: ST },
      { seriesId: 1, viewCounter: 2000, prevViewCounter: 2000, startTime: ST },
      { seriesId: 1, viewCounter: 2000, prevViewCounter: 2000, startTime: ST },
      { seriesId: 1, viewCounter: 2000, prevViewCounter: 2000, startTime: ST },
      { seriesId: 2, viewCounter: 4000, prevViewCounter: 4000, startTime: ST },
    ])
    const m = recalcSeriesMetricsJS(store, NOW, { weights: { delta: 0, rise: 0, base: 1 } })
    expect(m.get(1).avgViewsPerDay).toBeLessThan(m.get(2).avgViewsPerDay)
    expect(m.get(2).hotScore).toBeGreaterThan(m.get(1).hotScore) // 短編が上位＝長編バイアス無し
  })

  it('rise 成分: 相対成長率で小規模高成長が大規模低成長を上回る', () => {
    // A: 累計10000・増100 → 成長率 1% ／ B: 累計1000・増100 → 成長率 10%
    const store = makeStore([
      { seriesId: 1, viewCounter: 10000, prevViewCounter: 9900, startTime: ST },
      { seriesId: 2, viewCounter: 1000, prevViewCounter: 900, startTime: ST },
    ])
    const m = recalcSeriesMetricsJS(store, NOW, riseOnly)
    expect(m.get(1).growthRate).toBeCloseTo(0.01, 6)
    expect(m.get(2).growthRate).toBeCloseTo(0.1, 6)
    expect(m.get(2).hotScore).toBeGreaterThan(m.get(1).hotScore)
  })

  it('hotScore は 0.5·delta + 0.3·rise + 0.2·base のブレンド（既定の重み）', () => {
    // 既定重みで例外なく算出され、増加してる作品が上位に来る
    const store = makeStore([
      { seriesId: 1, viewCounter: 5000, prevViewCounter: 4000, startTime: ST }, // 増あり
      { seriesId: 2, viewCounter: 5000, prevViewCounter: 5000, startTime: ST }, // 増なし
    ])
    const m = recalcSeriesMetricsJS(store, NOW)
    expect(m.get(1).hotScore).toBeGreaterThan(m.get(2).hotScore)
    // recency 成分は撤廃済み＝返却に含まれない
    expect(m.get(1).recency).toBeUndefined()
  })
})
