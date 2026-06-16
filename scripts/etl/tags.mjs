// scripts/etl/tags.mjs
// タグ正規化: dアニメキュレーションマーカー除去・大小全半角統一・エイリアス吸収

const RE_SUFFIX_CURATION = /_dアニメ(ストア)?$/u
const RE_PREFIX_CURATION = /^dアニメ_/u
const EXCLUDED_TAGS = new Set(['dアニメストア'])

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
 * @param {string} rawTag
 * @returns {{ tags: string[], isCurated: boolean }}
 */
export function extractTagsFromRaw(rawTag) {
  const tag = rawTag.trim()
  if (!tag || EXCLUDED_TAGS.has(tag)) return { tags: [], isCurated: false }

  if (RE_SUFFIX_CURATION.test(tag)) {
    const stripped = tag.replace(RE_SUFFIX_CURATION, '')
    const tags = stripped
      .split('/')
      .map((s) => normalizeTagName(s))
      .filter(Boolean)
    return { tags, isCurated: true }
  }

  if (RE_PREFIX_CURATION.test(tag)) {
    const stripped = tag.replace(RE_PREFIX_CURATION, '')
    const tags = stripped
      .split('/')
      .map((s) => normalizeTagName(s))
      .filter(Boolean)
    return { tags, isCurated: true }
  }

  return { tags: [normalizeTagName(tag)], isCurated: false }
}

/**
 * スペース区切りのタグ文字列を処理し、正規化タグセットを返す。
 * @param {string | null} tagsStr - snapshot の生タグ文字列（スペース区切り）
 * @returns {{ name: string, isCurated: boolean }[]} 重複除去済み
 */
export function processEpisodeTags(tagsStr) {
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
      if (name && !seen.has(name)) {
        seen.add(name)
        result.push({ name, isCurated })
      }
    }
  }
  return result
}

/**
 * DB から各シリーズの第1話（最古話）タグを取得して正規化し、replaceSeriesTags に渡せる形で返す。
 * @param {import('better-sqlite3').Database} db
 * @returns {{ seriesId: number, tags: { name: string, isCurated: boolean }[] }[]}
 */
export function deriveSeriesTags(db) {
  const rows = db
    .prepare(
      `SELECT e.series_id, e.tags
       FROM episodes e
       WHERE e.series_id IS NOT NULL
         AND e.content_id = (
           SELECT e2.content_id FROM episodes e2
           WHERE e2.series_id = e.series_id
           ORDER BY e2.start_time ASC, COALESCE(e2.episode_no, 9999) ASC, e2.content_id ASC
           LIMIT 1
         )`
    )
    .all()

  return rows.map((row) => ({
    seriesId: row.series_id,
    tags: processEpisodeTags(row.tags),
  }))
}
