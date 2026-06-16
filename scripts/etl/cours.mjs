// scripts/etl/cours.mjs
// クール結合: programlist.json（今季）+ period HTML（過去季）

const SEASON_JA = { winter: '冬', spring: '春', summer: '夏', autumn: '秋' }

/**
 * period HTML から slug 一覧と変更検知用 title を抽出する。
 * @param {string} html
 * @param {string} source - ログ用ソース識別
 * @returns {{ title: string, slugs: string[] }}
 */
export function parsePeriodHtml(html, source = '') {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  if (!titleMatch) throw new Error(`[period] no <title> in HTML from ${source}`)

  const slugs = []
  const seen = new Set()
  const linkRe = /\/detail\/([^/"?\s]+)\//g
  let m
  while ((m = linkRe.exec(html)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      slugs.push(m[1])
    }
  }

  return { title: titleMatch[1].trim(), slugs }
}

/**
 * period HTML の変更検知アサート
 * @param {string} html
 * @param {number} minSlugs - /detail/ 件数の下限
 */
export function assertPeriodOk(html, source, minSlugs = 1) {
  const { title, slugs } = parsePeriodHtml(html, source)
  if (!title.includes('dアニメストア')) {
    throw new Error(`[assert:period] title does not include dアニメストア: "${title}"`)
  }
  if (slugs.length < minSlugs) {
    throw new Error(`[assert:period] slug count ${slugs.length} < ${minSlugs}`)
  }
}

/**
 * 年と英語季節からクールラベルを生成（"2026-春" など）
 * @param {number} year
 * @param {string} season - 'winter'|'spring'|'summer'|'autumn'
 * @returns {string}
 */
export function makeCoursLabel(year, season) {
  return `${year}-${SEASON_JA[season] ?? season}`
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

/**
 * slug を decodeURI してハイフンをスペースに変換
 */
export function normalizeSlug(slug) {
  try {
    return decodeURIComponent(slug).replace(/-/g, ' ').toLowerCase().trim()
  } catch {
    return slug.replace(/-/g, ' ').toLowerCase().trim()
  }
}

/**
 * slug ↔ series をタイトル正規化＋信頼度スコアで結合する。
 * @param {string[]} slugs
 * @param {Map<number, string>} seriesMap - series_id → title
 * @param {Record<string, number>} overrides - slug → series_id（手動 override 表）
 * @returns {{ seriesId: number|null, slug: string, confidence: number }[]}
 */
export function matchSlugsToSeries(slugs, seriesMap, overrides = {}) {
  return slugs.map((slug) => {
    // 手動 override が優先
    if (overrides[slug] != null) {
      return { seriesId: Number(overrides[slug]), slug, confidence: 1.0 }
    }

    const slugNorm = normalizeSlug(slug)
    let bestId = null
    let bestScore = 0

    for (const [id, title] of seriesMap) {
      const titleNorm = normalizeTitleForMatch(title)
      if (!titleNorm) continue

      let score = 0
      if (slugNorm === titleNorm) {
        score = 1.0
      } else if (slugNorm.includes(titleNorm) || titleNorm.includes(slugNorm)) {
        score = 0.7
      } else {
        // 先頭10文字で部分一致
        const prefix = titleNorm.slice(0, 10)
        if (prefix.length >= 4 && slugNorm.includes(prefix)) score = 0.5
      }

      if (score > bestScore) {
        bestScore = score
        bestId = id
      }
    }

    return { seriesId: bestId, slug, confidence: bestScore }
  })
}

/**
 * programlist.json から今季クール付与マップを生成
 * @param {object[]} programlist
 * @param {string} coursLabel - "2026-春" など
 * @returns {Map<number, string>} series_id → cours
 */
export function mapCurrentCours(programlist, coursLabel) {
  const result = new Map()
  for (const item of programlist) {
    // series フィールドが数値の series_id
    if (item.series) {
      result.set(Number(item.series), coursLabel)
    }
  }
  return result
}
