// scripts/store/credit-index.mjs
// 発見タグの「グローバル索引」を組み立てる。各シリーズ1話目から credits.mjs で名前タグを抽出し、
// canonical key 単位で **recurrence（出現シリーズ数）** を数える。これが発見タグの価値判定の核心:
//   - クリック可能（発見タグ）= recurrence ≥ THRESHOLD（既定 2）。他作品に繋がるものだけ。
//   - singleton（=1）= 削除せず series JSON には残すが「非クリック（淡色）」。catalog 成長で昇格。
// recurrence は必ず **canonical key で・正規化後に** 数える（生文字列だと「諏訪部 順一」と
// 「諏訪部順一」が別 key で両方 singleton 落ちする）。

import { extractCredits, countRecurrence } from '../etl/credits.mjs'
import { chronoSort } from './store.mjs'

// クリック可能（発見タグ）とみなす最小 recurrence。configurable（env で上書き可）。
export const RECURRENCE_THRESHOLD = Number(process.env.CREDIT_RECURRENCE_THRESHOLD ?? 2)

/**
 * store 全体から credits のグローバル索引を作る。
 * @param {import('./store.mjs').Store} store
 * @returns {{ perSeries: Map<number, Array>, recurrence: Map<string, number> }}
 *   perSeries: seriesId → extractCredits().tags（1話目・recurrence 適用前）
 *   recurrence: canonical key → 出現シリーズ数
 */
export function buildCreditIndex(store) {
  // seriesId → 最古話（chronoSort 先頭＝あらすじ／credits と同一ソース）
  const firstBySeries = new Map()
  for (const ep of store.episodes.values()) {
    if (ep.seriesId == null) continue
    const cur = firstBySeries.get(ep.seriesId)
    if (!cur || chronoSort(ep, cur) < 0) firstBySeries.set(ep.seriesId, ep)
  }
  const perSeries = new Map()
  for (const [sid, ep] of firstBySeries) {
    perSeries.set(sid, extractCredits(ep.description).tags)
  }
  const recurrence = countRecurrence(perSeries.values())
  return { perSeries, recurrence }
}

/**
 * series JSON 用の credits（表示タグ列）。name=表示・key=canonical・recurrent=クリック可否
 * ・count=グローバル出現数・source/role=soft metadata（将来の序列/facet 用）。
 * 並びは recurrent 優先 → count 降順 → 元順。
 */
export function seriesCredits(tags, recurrence, threshold = RECURRENCE_THRESHOLD) {
  const list = (tags ?? []).map((t) => {
    const count = recurrence.get(t.key) ?? 0
    return {
      name: t.display,
      key: t.key,
      count,
      recurrent: count >= threshold,
      source: t.source,
      role: t.role,
    }
  })
  // recurrent を前に、その中で出現数の多い順（同数は元順保持＝stable sort）。
  return list
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) => Number(b.c.recurrent) - Number(a.c.recurrent) || b.c.count - a.c.count || a.i - b.i
    )
    .map((x) => x.c)
}

/**
 * works.json 用の credits（`?credit=` フィルタの照合キー）。クリック可能（recurrent）な
 * canonical key のみ・重複除去・順序保持。singleton はクリック対象でないので持たせない。
 */
export function worksCreditKeys(tags, recurrence, threshold = RECURRENCE_THRESHOLD) {
  const out = []
  const seen = new Set()
  for (const t of tags ?? []) {
    const count = recurrence.get(t.key) ?? 0
    if (count < threshold) continue
    if (seen.has(t.key)) continue
    seen.add(t.key)
    out.push(t.key)
  }
  return out
}
