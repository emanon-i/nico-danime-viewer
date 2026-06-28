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
      // ブロック要素（段落 <p>・<div>・リスト <li>）の境界を改行に変換する。
      // ニコニコ RSS の description は本文を <p class="nico-description">…</p> 等で囲み
      // <br> を使わないため、ここを潰すと全段落が 1 行に詰まる（§56 / description 改行潰れ対策）。
      .replace(/<\/(?:p|div|li)>/gi, '\n')
      .replace(/<(?:p|div|li)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      // 実体参照のデコードで <br>/<p> 等が復活した場合（&lt;br&gt; 等）に再度改行化＋残タグ除去（§56 防御）
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li)>/gi, '\n')
      .replace(/<(?:p|div|li)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\r\n?/g, '\n')
      // ブロック境界由来の行頭・行末の余分な空白（RSS の "\n      <p>" インデント等）を除去
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/**
 * description が「構造化済み」か判定する（PH-0014 / F-0058）。
 *
 * ニコニコの各話 description は源で構造が異なる:
 *   - nvapi v2/series 由来 = あらすじ↔キャスト↔スタッフ↔© を <br>（多くは <br><br>）で区切る＝構造化。
 *   - チャンネル RSS 由来   = 全クレジットを 1 個の <p class="nico-description"> に区切り無しで連結＝フラット。
 *     （RSS 生は <p> ラッパ由来の実改行を 2 個持つが <br> は持たない。実測 200 件で <br>=0。）
 *
 * よって「構造化されているか」は **<br>（生・実体参照とも）の有無**で確実に判別できる。
 * 実改行(\n)の有無で判定すると RSS のラッパ改行を誤って構造化扱いするため使わない。
 *
 * @param {string|null|undefined} desc - 生（HTML strip 前）の description
 * @returns {boolean}
 */
export function isStructuredDescription(desc) {
  return typeof desc === 'string' && /<br\s*\/?>|&lt;\s*br/i.test(desc)
}

/**
 * 各話 description のマージ勝者を選ぶ（PH-0014 / F-0058 ＝源優先マージ）。
 *
 * 構造版（nvapi）はフラット版（RSS）より**長さに関わらず**優先する。
 * 同一構造クラス内（両構造・両フラット・両 null）でのみ従来の long-wins を維持する。
 * これにより、全クレジット連結で長くなりがちなフラット RSS が構造化 nvapi を潰す
 * （新着各話の本文 1 行詰まり）現象を解消する。
 *
 * @param {string|null|undefined} existing - 既存（store 保持）の生 description
 * @param {string|null|undefined} incoming - 新規（今回 upsert）の生 description
 * @returns {string|null}
 */
export function chooseDescription(existing, incoming) {
  const e = existing ?? null
  const i = incoming ?? null
  const eStructured = isStructuredDescription(e)
  const iStructured = isStructuredDescription(i)
  // 構造版が来た → 採用（長さ無視）。既存が構造版 → フラットで潰さない。
  if (iStructured && !eStructured) return i
  if (eStructured && !iStructured) return e
  // 同一構造クラス（両構造／両フラット／両 null）→ 従来 long-wins
  if (i && i.length > (e?.length ?? 0)) return i
  return e ?? i ?? null
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
 * Store 版 deriveSeriesOverviews: 各シリーズの第1話（chronoSort 最古話）の
 * description を HTML 除去して返す。
 * @param {import('../store/store.mjs').Store} store
 * @param {Function} chronoSort - store.mjs の chronoSort
 * @returns {{ seriesId: number, descriptionFirst: string }[]}
 */
export function deriveSeriesOverviewsFromStore(store, chronoSort) {
  const result = []
  for (const [seriesId] of store.series) {
    const eps = []
    for (const ep of store.episodes.values()) {
      if (ep.seriesId === seriesId) eps.push(ep)
    }
    if (eps.length === 0) continue
    eps.sort(chronoSort)
    const first = eps[0]
    result.push({
      seriesId,
      descriptionFirst: stripHtml(first.description),
    })
  }
  return result
}

/**
 * Store 版 getSeriesTagsMap: store.series の tags から seriesId → タグ名[] を返す。
 * @param {import('../store/store.mjs').Store} store
 * @returns {Map<number, string[]>}
 */
export function getSeriesTagsMapFromStore(store) {
  const map = new Map()
  for (const [sid, s] of store.series) {
    map.set(
      sid,
      s.tags.map((t) => t.name)
    )
  }
  return map
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
