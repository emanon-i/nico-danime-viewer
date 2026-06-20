// scripts/etl/cours.mjs
// クール派生: タグ主源（snapshot タグ内 YYYY年季アニメ）

const SEASON_ORDER = { 冬: 0, 春: 1, 夏: 2, 秋: 3 }

/**
 * タグ文字列から放送季ラベル（"YYYY-季"）を導出する。
 * snapshot タグに `YYYY年<季>アニメ`（例「2022年秋アニメ」「2025年冬アニメ_dアニメストア」）が
 * 入っているため、これを直接パースする＝追加 fetch 不要・放送季で正確（period 突合より高 recall）。
 * 複数季が含まれる場合は**最も古い季**（放送開始＝オリジナルの季）を採用する。
 * @param {string | null} tagsStr
 * @returns {string | null} "YYYY-季" または null
 */
export function coursFromTags(tagsStr) {
  if (!tagsStr) return null
  const matches = [...tagsStr.matchAll(/(\d{4})年(春|夏|秋|冬)アニメ/gu)]
  if (matches.length === 0) return null
  matches.sort((a, b) =>
    a[1] !== b[1] ? Number(a[1]) - Number(b[1]) : SEASON_ORDER[a[2]] - SEASON_ORDER[b[2]]
  )
  return `${matches[0][1]}-${matches[0][2]}`
}

/**
 * Store 版 deriveCoursFromTags: 各シリーズの第1話タグ（tags 配列の文字列）から
 * 放送季クールを導出する。
 * @param {import('./store/store.mjs').Store} store
 * @param {Function} chronoSort - store.mjs の chronoSort
 * @returns {Map<number, string>} seriesId → "YYYY-季"
 */
export function deriveCoursFromTagsFromStore(store, chronoSort) {
  const result = new Map()
  for (const [seriesId, s] of store.series) {
    if (!s.isAvailable) continue
    // 最古エピソードを取得（chronoSort）
    let firstEp = null
    for (const ep of store.episodes.values()) {
      if (ep.seriesId !== seriesId) continue
      if (!firstEp || chronoSort(ep, firstEp) < 0) firstEp = ep
    }
    if (!firstEp) continue
    // tags は string[] - space join して coursFromTags に渡す
    const tagsStr = (firstEp.tags ?? []).join(' ')
    const cours = coursFromTags(tagsStr)
    if (cours) result.set(seriesId, cours)
  }
  return result
}

/**
 * タイトルをスラッグ突合用に正規化（小文字・記号除去）
 */
export function normalizeTitleForMatch(title) {
  return (title ?? '')
    .toLowerCase()
    .replace(/[\s\u3000・「」『』【】（）()【】。、！？!?♪☆★…]+/gu, ' ')
    .trim()
}
