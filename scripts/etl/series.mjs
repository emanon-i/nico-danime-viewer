// scripts/etl/series.mjs
// シリーズ派生データ: 概要（第1話あらすじ）・フランチャイズ束ね・URL解析

/**
 * HTMLタグ・実体参照を除去してテキストを返す
 */
export function stripHtml(html) {
  if (!html) return ''
  return (
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      // 実体参照のデコードで <br> が復活した場合（&lt;br&gt; 等）に再度改行化＋残タグ除去（§56 防御）
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
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
 * タイトルを「作品の語幹」に正規化する（続編/形式マーカーを除去）。
 * 例「劇場版「進撃の巨人」Season 1 前編～紅蓮の弓矢～」→「進撃の巨人」。
 * 続編束ねの主シグナル。短すぎる語幹（汎用）は呼び出し側で弾く。
 * @param {string} title
 * @returns {string}
 */
export function titleStem(title) {
  let t = (title ?? '')
    .replace(/[「」『』【】（）()｢｣"'`]/gu, ' ')
    .replace(/^(?:劇場版|映画|総集編|TVアニメ|TV|アニメ|OVA|OAD)\s*/u, '')
  // 続編/形式マーカーの手前で切る
  t = t.split(/\s*(?:The\s+)?Final\s+Season/iu)[0]
  t = t.split(/\s*(?:Season|SEASON|シーズン)\s*[0-9０-９]+/u)[0]
  t = t.split(/\s*第?\s*[0-9０-９]+\s*期/u)[0]
  t = t.split(/\s*[0-9０-９]+(?:st|nd|rd|th)\s*season/iu)[0]
  t = t.split(/\s+(?:OAD|OVA|SP|スペシャル|劇場版|前編|後編|完結編|総集編|Blu-ray|BD|特典)/u)[0]
  t = t.split(/[Ⅱ-Ⅻ]/u)[0]
  t = t.split(/[~～].*$/u)[0]
  return t.replace(/\s+/gu, ' ').trim()
}

/**
 * フランチャイズ（続編/関連シリーズ）束ねキーを決定する（ベストエフォート・§15）。
 * union-find で次のエッジを張り、同一連結成分を 1 フランチャイズとする:
 *  (1) **タイトル語幹**（4 文字以上）が一致するシリーズ同士＝続編の主シグナル
 *  (2) **`〜シリーズ` タグ**を共有するシリーズ同士＝キュレーション済みの束ね
 * 声優・スタッフ・汎用タグ（旧実装の 2〜50 共有ルール）は**使わない**（誤束ねの主因）。
 * @param {Map<number, string[]>} seriesTagsMap - series_id → tag名[]
 * @param {Map<number, string>} [titleMap] - series_id → title（語幹計算用・省略時は語幹エッジ無し）
 * @returns {Map<number, string>} series_id → franchise_key（成分サイズ 2 以上のみ）
 */
export function computeFranchiseKeys(seriesTagsMap, titleMap) {
  const ids = new Set(seriesTagsMap.keys())
  if (titleMap) for (const id of titleMap.keys()) ids.add(id)

  // union-find
  const parent = new Map()
  for (const id of ids) parent.set(id, id)
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)))
      x = parent.get(x)
    }
    return x
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  // (1) タイトル語幹（4 文字以上）でエッジ
  if (titleMap) {
    const byStem = new Map()
    for (const [id, title] of titleMap) {
      const stem = titleStem(title)
      if (stem.length >= 4) {
        if (!byStem.has(stem)) byStem.set(stem, [])
        byStem.get(stem).push(id)
      }
    }
    for (const group of byStem.values()) {
      for (let i = 1; i < group.length; i++) union(group[0], group[i])
    }
  }

  // (2) `〜シリーズ` タグでエッジ
  const bySeriesTag = new Map()
  for (const [id, tags] of seriesTagsMap) {
    for (const tag of tags) {
      if (/シリーズ$/u.test(tag)) {
        if (!bySeriesTag.has(tag)) bySeriesTag.set(tag, [])
        bySeriesTag.get(tag).push(id)
      }
    }
  }
  for (const group of bySeriesTag.values()) {
    for (let i = 1; i < group.length; i++) union(group[0], group[i])
  }

  // 連結成分を集計し、サイズ 2 以上のみ franchise_key を付与（キー＝成分内最小 id）
  const members = new Map()
  for (const id of ids) {
    const root = find(id)
    if (!members.has(root)) members.set(root, [])
    members.get(root).push(id)
  }
  const result = new Map()
  for (const group of members.values()) {
    if (group.length < 2) continue
    const key = `f:${Math.min(...group)}`
    for (const id of group) result.set(id, key)
  }
  return result
}
