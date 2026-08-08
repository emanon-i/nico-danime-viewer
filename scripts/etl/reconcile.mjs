import { resolveByTitle } from '../nico/list.mjs'

/**
 * list.json の正規タイトルから判断できる「現在の正 seriesId と候補の正 seriesId が違う話」を
 * 対象 seriesId ごとにまとめる。これは移動の根拠には使わず、nvapi の排他的メンバーシップを
 * 優先確認するためだけに使う（タイトル推測だけで正→正を移動しない）。
 *
 * 誤登録が残っている限り毎日同じ候補を返すため、B7 の通常ローテーション時に nvapi が空・
 * partial でも翌日ふたたび検証される。巡回カーソルの通過だけで永久に取り残さない。
 *
 * @param {import('../store/store.mjs').Store} store
 * @param {Map<string,number>} byTitle
 * @returns {{seriesId:number, contentIds:string[]}[]}
 */
export function findTitleMismatchTargets(store, byTitle) {
  // resolveByTitle は Map 全走査なので、全約9万話×全約6,700タイトルの直積を避ける。
  // 前方一致が成立するには正規化後の先頭文字が必ず同じ、という不変条件で候補を絞る。
  const firstKey = (value) =>
    String(value ?? '')
      .charAt(0)
      .replace(/[‘’ʼ]/g, "'")
      .replace(/＆/g, '&')
  const titlesByFirst = new Map()
  for (const [title, seriesId] of byTitle) {
    const key = firstKey(title)
    if (!key) continue
    const candidates = titlesByFirst.get(key) ?? new Map()
    candidates.set(title, seriesId)
    titlesByFirst.set(key, candidates)
  }

  const byTarget = new Map()

  for (const ep of store.episodes.values()) {
    if (!(ep.seriesId > 0) || !ep.title) continue
    const candidates = titlesByFirst.get(firstKey(ep.title))
    if (!candidates) continue
    const targetSeriesId = resolveByTitle(ep.title, candidates)
    if (!(targetSeriesId > 0) || targetSeriesId === ep.seriesId) continue
    // B3 後も Store に存在しない候補は、支店シリーズとして確認できていないので対象外。
    if (!store.series.has(targetSeriesId)) continue

    const contentIds = byTarget.get(targetSeriesId) ?? []
    contentIds.push(ep.contentId)
    byTarget.set(targetSeriesId, contentIds)
  }

  return [...byTarget.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seriesId, contentIds]) => ({ seriesId, contentIds }))
}
