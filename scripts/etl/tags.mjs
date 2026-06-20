// scripts/etl/tags.mjs
// タグ正規化: dアニメキュレーションマーカー除去・大小全半角統一・エイリアス吸収

const RE_SUFFIX_CURATION = /_dアニメ(ストア)?$/u
const RE_PREFIX_CURATION = /^dアニメ_/u
// 配信元マーカー＋ノイズタグ（全作品に付く「アニメ」・第1話源由来の「第1話/第一話」）を除外（§27）
const EXCLUDED_TAGS = new Set(['dアニメストア', 'アニメ', '第1話', '第一話'])

// よくある表記ゆれ・エイリアスマップ（正規化後の小文字→標準表記）
const ALIAS_MAP = new Map([
  ['sf', 'SF'],
  ['sci-fi', 'SF'],
  ['sci fi', 'SF'],
])

/**
 * 全角英数を半角に変換（ASCII範囲のみ）
 */
function toHalfWidth(s) {
  return s.replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
}

/**
 * 単一タグ名を正規化（半角化・英字大文字化・エイリアス適用）
 * @param {string} raw
 * @returns {string}
 */
export function normalizeTagName(raw) {
  let s = toHalfWidth(raw.trim())
  // ASCII英字のみ大文字化
  s = s.replace(/[a-z]/g, (c) => c.toUpperCase())
  return ALIAS_MAP.get(s.toLowerCase()) ?? s
}

/**
 * 生タグ文字列からキュレーションマーカーを除去し、正規化タグ配列を返す。
 * **`/` では分割しない**（「SF/ファンタジー」を 1 タグとして残す＝分割すると "SF" 等が
 * 大量の作品に付いてフィルタ候補が荒れるため）。
 * @param {string} rawTag
 * @returns {{ tags: string[], isCurated: boolean }}
 */
export function extractTagsFromRaw(rawTag) {
  const tag = rawTag.trim()
  if (!tag || EXCLUDED_TAGS.has(tag)) return { tags: [], isCurated: false }

  if (RE_SUFFIX_CURATION.test(tag)) {
    const name = normalizeTagName(tag.replace(RE_SUFFIX_CURATION, ''))
    return { tags: name ? [name] : [], isCurated: true }
  }

  if (RE_PREFIX_CURATION.test(tag)) {
    const name = normalizeTagName(tag.replace(RE_PREFIX_CURATION, ''))
    return { tags: name ? [name] : [], isCurated: true }
  }

  return { tags: [normalizeTagName(tag)], isCurated: false }
}

/** タイトル/タグを照合用にコンパクト化（記号・空白除去・小文字化） */
function normCompact(s) {
  return (s ?? '')
    .toLowerCase()
    .replace(/[\s・:：!！?？|｜/／「」『』【】（）()。、,，.\-―~〜～'"`＿_]+/gu, '')
}

/**
 * タグが「作品名そのもの」かを判定する（作品名タグはフィルタ候補に出さない＝§2）。
 * 正規化後にタイトルと完全一致、またはタイトルがタグで始まる（タグ 4 文字以上）場合。
 */
export function isTitleTag(tagName, title) {
  if (!title) return false
  const t = normCompact(title)
  const g = normCompact(tagName)
  if (!t || !g) return false
  if (g === t) return true
  if (g.length >= 4 && t.startsWith(g)) return true
  return false
}

/**
 * スペース区切りのタグ文字列を処理し、正規化タグセットを返す。
 * @param {string | null} tagsStr - snapshot の生タグ文字列（スペース区切り）
 * @param {string | null} [title] - シリーズ作品名（作品名タグ除外用・任意）
 * @returns {{ name: string, isCurated: boolean }[]} 重複除去済み
 */
export function processEpisodeTags(tagsStr, title = null) {
  if (!tagsStr) return []
  const rawTags = tagsStr
    .split(' ')
    .map((s) => s.trim())
    .filter(Boolean)
  const seen = new Set()
  const result = []
  for (const raw of rawTags) {
    const { tags, isCurated } = extractTagsFromRaw(raw)
    for (const name of tags) {
      if (!name || seen.has(name)) continue
      // 正規化後にもノイズタグ（全角「第１話」→「第1話」等）を除外（§27）
      if (EXCLUDED_TAGS.has(name)) continue
      // 作品名タグ（作品名そのもの）はフィルタ候補に出さない
      if (isTitleTag(name, title)) continue
      seen.add(name)
      result.push({ name, isCurated })
    }
  }
  return result
}

/**
 * Store 版 deriveSeriesTags: エピソードの tags + tagsCurated から各シリーズの
 * 全エピソードタグを正規化して distinct union し、replaceSeriesTags に渡せる形で返す。
 * tagsCurated を使って isCurated を復元（M-pre で付与済み）。
 * @param {import('../store/store.mjs').Store} store
 * @returns {{ seriesId: number, tags: { name: string, isCurated: boolean }[] }[]}
 */
export function deriveSeriesTagsFromStore(store) {
  // seriesId → Map(name → {name, isCurated})
  const bySeries = new Map()
  for (const ep of store.episodes.values()) {
    if (ep.seriesId == null) continue
    const seriesTitle = store.series.get(ep.seriesId)?.title ?? null
    let acc = bySeries.get(ep.seriesId)
    if (!acc) {
      acc = new Map()
      bySeries.set(ep.seriesId, acc)
    }
    const curatedSet = new Set(ep.tagsCurated ?? [])
    for (const name of ep.tags ?? []) {
      if (!name) continue
      if (isTitleTag(name, seriesTitle)) continue
      const prev = acc.get(name)
      const isCurated = curatedSet.has(name)
      if (prev) prev.isCurated = prev.isCurated || isCurated
      else acc.set(name, { name, isCurated })
    }
  }

  return [...bySeries.entries()].map(([seriesId, tagMap]) => ({
    seriesId,
    tags: [...tagMap.values()],
  }))
}
