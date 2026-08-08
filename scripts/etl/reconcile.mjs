import { resolveByTitle } from '../nico/list.mjs'

function normalizeTitle(value) {
  return String(value ?? '')
    .trim()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/＆/g, '&')
}

export function seriesTitlesEqual(a, b) {
  return normalizeTitle(a) === normalizeTitle(b)
}

export function isSafeTitleFallbackCandidate(store, ep, targetSeriesId, targetTitle) {
  if (!ep?.title || !(targetSeriesId > 0) || !targetTitle) return false
  const targetOnly = new Map([[targetTitle, targetSeriesId]])
  if (resolveByTitle(ep.title, targetOnly) !== targetSeriesId) return false
  if (!(ep.seriesId > 0)) return true

  const currentTitle = store.series.get(ep.seriesId)?.title
  if (!currentTitle) return false
  const currentOnly = new Map([[currentTitle, ep.seriesId]])
  const currentMatches = resolveByTitle(ep.title, currentOnly) === ep.seriesId
  if (!currentMatches) return true
  return normalizeTitle(targetTitle).length > normalizeTitle(currentTitle).length
}

export function inferEpisodeNo(title) {
  const normalized = String(title ?? '').replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  )
  const patterns = [
    /第\s*(\d+)\s*話/i,
    /(?:#|＃)\s*(\d+)/,
    /\bBREAK\s*(\d+)\b/i,
    /にゃーの\s*(\d+)/,
    /\b(?:EPISODE|Chapter)[.\s]*(\d+)\b/i,
  ]
  for (const pattern of patterns) {
    const value = Number(normalized.match(pattern)?.[1])
    if (Number.isInteger(value) && value > 0) return value
  }
  return null
}

/**
 * list.json の正規タイトルから判断できる「現在の正 seriesId と候補の正 seriesId が違う話」を
 * 対象 seriesId ごとにまとめる。まず nvapi の排他的メンバーシップを優先確認し、GitHub
 * runner 固有の空配列応答時だけ、支店所有・series詳細タイトル一致を追加条件に安全な候補を使う。
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
  const titleBySeriesId = new Map()
  for (const [title, seriesId] of byTitle) {
    titleBySeriesId.set(seriesId, title)
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
    const targetTitle = titleBySeriesId.get(targetSeriesId)
    if (!isSafeTitleFallbackCandidate(store, ep, targetSeriesId, targetTitle)) continue

    const contentIds = byTarget.get(targetSeriesId) ?? []
    contentIds.push(ep.contentId)
    byTarget.set(targetSeriesId, contentIds)
  }

  return [...byTarget.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seriesId, contentIds]) => ({ seriesId, contentIds }))
}
