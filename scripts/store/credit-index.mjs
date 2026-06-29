// scripts/store/credit-index.mjs
// 発見タグの per-series 索引。各シリーズ1話目から credits.mjs で名前タグを抽出し、
// series JSON / works.json 用に整形する。
//
// 方針（recurrence ゲート撤廃）: タグのクリック可否・表示は recurrence の多寡で一切変えない。
// **全 credit タグは均一にクリック可能**（他タグ `#…` と同じ作法・1作品しかヒットしなくても
// 普通にフィルタが効いて1件出るだけ＝一貫・予測可能）。noise は抽出ルール側（credits.mjs）で落とす。
// recurrence の集計（countRecurrence）は将来の序列/facet 用ユーティリティとして残すが、
// 本パイプラインの表示/クリック判定には使わない。

import { extractCredits } from '../etl/credits.mjs'
import { chronoSort } from './store.mjs'

/**
 * store 全体から seriesId → 1話目の抽出タグ配列を作る。
 * @param {import('./store.mjs').Store} store
 * @returns {{ perSeries: Map<number, Array<{display:string,key:string,source:string,role:string}>> }}
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
  return { perSeries }
}

/**
 * series JSON 用 credits（表示タグ列）。抽出順のまま {name, key, source, role} に整形・key で dedup。
 * recurrence で並びや表示を変えない（全タグ均一・クリック可）。source/role は soft metadata。
 */
export function seriesCredits(tags) {
  const out = []
  const seen = new Set()
  for (const t of tags ?? []) {
    if (seen.has(t.key)) continue
    seen.add(t.key)
    out.push({ name: t.display, key: t.key, source: t.source, role: t.role })
  }
  return out
}

/**
 * works.json 用 credits（`?credit=` フィルタの照合キー）。全 canonical key・重複除去・順序保持。
 * recurrence で絞らない（singleton キーでもクリックすれば自作品1件が出る＝一貫）。
 */
export function worksCreditKeys(tags) {
  const out = []
  const seen = new Set()
  for (const t of tags ?? []) {
    if (seen.has(t.key)) continue
    seen.add(t.key)
    out.push(t.key)
  }
  return out
}

/**
 * canonical key → 表示名（display）のグローバル対応表。適用中ピル（`?credit=<key>`）で原表記
 * （TYPE-MOON・諏訪部 順一 等）を出すために使う。works.credits は key 配列のみ（照合用）なので
 * 表示名を別途持つ。**key と display が異なるものだけ**収録（kanji 名は key==display ＝省略しピル側で
 * key にフォールバック）＝肥大最小化。最初に出会った display を採用。
 * @param {Map<number, Array<{display:string,key:string}>>} perSeries
 * @returns {Record<string,string>}
 */
export function buildCreditDisplayMap(perSeries) {
  const map = {}
  for (const tags of perSeries.values()) {
    for (const t of tags ?? []) {
      if (t.key !== t.display && map[t.key] == null) map[t.key] = t.display
    }
  }
  return map
}
