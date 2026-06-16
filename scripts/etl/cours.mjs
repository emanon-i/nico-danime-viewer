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

  // アンカーから (slug, 日本語タイトル) を抽出。period の作品リンクのアンカー文には
  // 日本語タイトルが含まれる（例「新作 アークナイツ【…】 2022/10/28(金)～…」）ため、
  // タイトル突合（日本語↔日本語）に使う＝romaji slug 突合より高精度・高 recall。
  const entries = []
  const seenSlug = new Set()
  const aRe = /<a[^>]*href="[^"]*\/detail\/([^/"]+)\/?[^"]*"[^>]*>([\s\S]*?)<\/a>/g
  let am
  while ((am = aRe.exec(html)) !== null) {
    if (seenSlug.has(am[1])) continue
    seenSlug.add(am[1])
    entries.push({ slug: am[1], title: cleanPeriodTitle(am[2]) })
  }

  return { title: titleMatch[1].trim(), slugs, entries }
}

/**
 * period アンカー文から日本語の作品タイトルを抽出（状態ラベル・放送日時・媒体名を除去）。
 * 例「新作 アークナイツ【黎明前奏/PRELUDE TO DAWN】 2022/10/28(金)～ テレビ」→「アークナイツ【黎明前奏/PRELUDE TO DAWN】」
 * @param {string} raw - アンカー innerHTML
 * @returns {string}
 */
export function cleanPeriodTitle(raw) {
  let t = (raw ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  // 放送日時・媒体・スケジュール表記の手前で切る
  t = t.split(/\s\d{4}\/\d{1,2}\/\d{1,2}/u)[0]
  t = t.split(/\s\d{1,2}月\d{1,2}日/u)[0]
  t = t.split(/[（(][月火水木金土日][）)]/u)[0]
  t = t.split(/\s(?:TOKYO|AT-X|BS|ニコ動|テレビ|スタート|毎週|配信中|放送|独占)/u)[0]
  // 先頭の状態ラベル（新作/継続 等）を除去
  t = t
    .replace(/^(新作|継続|独占|最速|見放題|無料あり|無料|TVアニメ|TV|劇場版|特別編?|配信)\s*/u, '')
    .trim()
  // 末尾の「～…」以降を除去
  t = t.replace(/[～〜~].*$/u, '').trim()
  return t
}

/**
 * period の (slug, 日本語タイトル) を series にタイトル正規化で結合する（slug 突合より優先）。
 * 完全一致＝1.0、片方が他方の接頭（短い側 4 文字以上）＝0.8。
 * @param {{ slug: string, title: string }[]} entries
 * @param {Map<number, string>} seriesMap - series_id → title
 * @param {Record<string, number>} overrides - slug → series_id（手動 override）
 * @returns {{ seriesId: number|null, slug: string, confidence: number }[]}
 */
export function matchPeriodEntriesToSeries(entries, seriesMap, overrides = {}) {
  // 正規化タイトル → series_id（最初の1件を採用）
  const byNorm = new Map()
  for (const [id, title] of seriesMap) {
    const n = normalizeTitleForMatch(title)
    if (n && !byNorm.has(n)) byNorm.set(n, id)
  }

  return entries.map(({ slug, title }) => {
    if (overrides[slug] != null) {
      return { seriesId: Number(overrides[slug]), slug, confidence: 1.0 }
    }
    const n = normalizeTitleForMatch(title)
    if (!n) return { seriesId: null, slug, confidence: 0 }
    if (byNorm.has(n)) return { seriesId: byNorm.get(n), slug, confidence: 1.0 }
    // 接頭一致（短い側 4 文字以上）。「アークナイツ」⊂「アークナイツ【…】」等を拾う。
    for (const [sn, id] of byNorm) {
      if (
        sn.length >= 4 &&
        Math.min(sn.length, n.length) >= 4 &&
        (n.startsWith(sn) || sn.startsWith(n))
      ) {
        return { seriesId: id, slug, confidence: 0.8 }
      }
    }
    return { seriesId: null, slug, confidence: 0 }
  })
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
 * 各シリーズの第1話（最古話）タグから放送季クールを導出する（クールの**主源**＝§14）。
 * @param {import('better-sqlite3').Database} db
 * @returns {Map<number, string>} series_id → "YYYY-季"
 */
export function deriveCoursFromTags(db) {
  const rows = db
    .prepare(
      `SELECT s.series_id AS series_id, (
         SELECT e.tags FROM episodes e WHERE e.series_id = s.series_id
         ORDER BY e.start_time ASC, COALESCE(e.episode_no, 9999) ASC, e.content_id ASC LIMIT 1
       ) AS first_tags
       FROM series s WHERE s.is_available = 1`
    )
    .all()
  const result = new Map()
  for (const r of rows) {
    const cours = coursFromTags(r.first_tags)
    if (cours) result.set(r.series_id, cours)
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
 * b が a に「空白区切りの語境界」で含まれるか（部分文字列の偶発一致を避ける）。
 * 例: "bleach anime" ⊃ "bleach"（true）／"utawarerumono" ⊃ "mono"（false）。
 */
function boundaryContains(a, b) {
  if (a === b) return true
  return a.startsWith(b + ' ') || a.endsWith(' ' + b) || a.includes(' ' + b + ' ')
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
      } else if (boundaryContains(slugNorm, titleNorm) || boundaryContains(titleNorm, slugNorm)) {
        // 語境界での部分一致のみ採用し、さらに「短い側が 4 文字以上」を要求する。
        // 短い側が 1〜3 文字（例 title "K" / "A3"）や偶発的な部分文字列（utawarerumono⊃mono）
        // による誤マッチ（arknights→K 等）を量産しないため。
        const shorter = Math.min(slugNorm.length, titleNorm.length)
        if (shorter >= 4) score = 0.7
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
