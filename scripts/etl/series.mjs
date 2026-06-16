// scripts/etl/series.mjs
// シリーズ派生データ: 概要（第1話あらすじ）・フランチャイズ束ね・URL解析

/**
 * HTMLタグ・実体参照を除去してテキストを返す
 */
export function stripHtml(html) {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * list.json の URL からシリーズIDを抽出
 * @param {string} url - "https://www.nicovideo.jp/series/<id>"
 * @returns {number|null}
 */
export function extractSeriesIdFromUrl(url) {
  const m = url?.match(/\/series\/(\d+)/)
  return m ? Number(m[1]) : null
}

/**
 * DB から各シリーズの第1話（最古話）の description を取得して HTML 除去済みで返す。
 * @param {import('better-sqlite3').Database} db
 * @returns {{ seriesId: number, descriptionFirst: string }[]}
 */
export function deriveSeriesOverviews(db) {
  const rows = db
    .prepare(
      `SELECT e.series_id, e.description
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
    descriptionFirst: stripHtml(row.description),
  }))
}

/**
 * series_id → タグ名[] のマップを DB から取得（フランチャイズ計算用）
 * @param {import('better-sqlite3').Database} db
 * @returns {Map<number, string[]>}
 */
export function getSeriesTagsMap(db) {
  const rows = db
    .prepare(
      `SELECT st.series_id, t.name
       FROM series_tags st
       JOIN tags t ON st.tag_id = t.tag_id`
    )
    .all()

  const map = new Map()
  for (const row of rows) {
    if (!map.has(row.series_id)) map.set(row.series_id, [])
    map.get(row.series_id).push(row.name)
  }
  return map
}

/**
 * 共有作品タグ・`〜シリーズ` タグでフランチャイズキーを決定する（ベストエフォート）。
 * タグのみ主源とし、タイトル語幹は使わない（誤束ねリスク）。
 * @param {Map<number, string[]>} seriesTagsMap - series_id → tag名[]
 * @returns {Map<number, string>} series_id → franchise_key（無い場合は含まれない）
 */
export function computeFranchiseKeys(seriesTagsMap) {
  // 各タグが何件のシリーズで使われているか集計
  const tagCount = new Map()
  for (const tags of seriesTagsMap.values()) {
    for (const tag of tags) {
      tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1)
    }
  }

  // フランチャイズ候補タグ: 2作品以上で共有 OR `〜シリーズ` パターン
  const franchiseTags = new Set()
  for (const [tag, count] of tagCount) {
    if (count >= 2 || /シリーズ$/u.test(tag)) {
      franchiseTags.add(tag)
    }
  }

  const result = new Map()

  for (const [seriesId, tags] of seriesTagsMap) {
    // `〜シリーズ` タグを優先
    const seriesStyleTags = tags.filter((t) => /シリーズ$/u.test(t) && franchiseTags.has(t))
    if (seriesStyleTags.length > 0) {
      result.set(seriesId, seriesStyleTags[0])
      continue
    }

    // 共有タグの中で最も多くのシリーズで使われているものをキーに
    const sharedTags = tags.filter((t) => franchiseTags.has(t))
    if (sharedTags.length > 0) {
      const best = sharedTags.reduce((a, b) =>
        (tagCount.get(a) ?? 0) >= (tagCount.get(b) ?? 0) ? a : b
      )
      result.set(seriesId, best)
    }
    // franchise_key = NULL if no shared tags (not added to result map)
  }

  return result
}
