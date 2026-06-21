// scripts/nico/list.mjs
// list.json / 全 static JSON 取得・インデックス・仮シリーズヘルパ

import { fetchWithToS } from '../lib/http.mjs'

const DANIME_STATIC = 'https://site.nicovideo.jp/danime/static/data/'
const LIST_JSON_URL = DANIME_STATIC + 'list.json'
const PROGRAMLIST_URL = DANIME_STATIC + 'programlist.json'
const EXCLUSIVE_FASTEST_URL = DANIME_STATIC + 'exclusiveAndFastest.json'
const ARCHIVE_EXCLUSIVE_URL = DANIME_STATIC + 'archiveExclusive.json'
const THEME_URLS = [1, 2, 3, 4, 5, 6].map((i) => DANIME_STATIC + `theme${i}.json`)

/**
 * danime static JSON を取得して JSON として返す。
 * @param {string} url
 * @param {string} label  ログ用ラベル
 * @returns {Promise<any>}
 */
export async function fetchStaticJson(url, label = url) {
  const resp = await fetchWithToS(url)
  if (resp.status !== 200) throw new Error(`[${label}] HTTP ${resp.status}`)
  return resp.json()
}

/**
 * list.json（全作品カタログ・五十音）を取得
 * @returns {Promise<{title: string, col_key: string, url: string}[]>}
 */
export async function fetchListJson() {
  return fetchStaticJson(LIST_JSON_URL, 'list.json')
}

/**
 * programlist.json（今季番組表）を取得
 * @returns {Promise<object[]>}
 */
export async function fetchProgramlist() {
  return fetchStaticJson(PROGRAMLIST_URL, 'programlist.json')
}

/**
 * 全 static JSON（list/programlist/exclusiveAndFastest/archiveExclusive/theme1-6）を並列取得する。
 * 失敗した JSON は null（スキップ）。
 * @returns {Promise<{listJson: any[], programlist: any[], extras: any[][]}>}
 */
export async function fetchAllStaticJsons() {
  const [listJson, programlist, exclusiveFastest, archiveExclusive, ...themes] =
    await Promise.allSettled([
      fetchStaticJson(LIST_JSON_URL, 'list.json'),
      fetchStaticJson(PROGRAMLIST_URL, 'programlist.json'),
      fetchStaticJson(EXCLUSIVE_FASTEST_URL, 'exclusiveAndFastest.json'),
      fetchStaticJson(ARCHIVE_EXCLUSIVE_URL, 'archiveExclusive.json'),
      ...THEME_URLS.map((u, i) => fetchStaticJson(u, `theme${i + 1}.json`)),
    ])

  const ok = (r) => (r.status === 'fulfilled' ? (r.value ?? []) : [])
  return {
    listJson: ok(listJson),
    programlist: ok(programlist),
    extras: [ok(exclusiveFastest), ok(archiveExclusive), ...themes.map(ok)],
  }
}

/**
 * items 配列（exclusiveAndFastest 等の形式）から seriesId を抽出する。
 * `href: "/series/<id>"` または `series: <number>` フィールドを認識する。
 * @param {any[]} items
 * @returns {number[]}
 */
export function extractSeriesIdsFromItems(items) {
  const ids = []
  for (const item of Array.isArray(items) ? items : []) {
    const fromHref = item.href?.match(/\/series\/(\d+)/)?.[1]
    if (fromHref) {
      ids.push(Number(fromHref))
      continue
    }
    if (typeof item.series === 'number' && item.series > 0) ids.push(item.series)
  }
  return ids
}

/**
 * list.json の items から title->seriesId / seriesId->title の双方向インデックスを構築する。
 * @param {{title:string, url:string}[]} items fetchListJson() の戻り値
 * @returns {{ byTitle: Map<string,number>, bySeriesId: Map<number,string> }}
 */
export function buildListIndex(items) {
  const byTitle = new Map()
  const bySeriesId = new Map()
  for (const item of items) {
    const m = item.url?.match(/\/series\/(\d+)$/)
    if (!m) continue
    const seriesId = Number(m[1])
    byTitle.set(item.title, seriesId)
    bySeriesId.set(seriesId, item.title)
  }
  return { byTitle, bySeriesId }
}

// タイトル直後で語境界とみなす文字（偽陽性防止）
// 「K 第1話」->「K」は ' ' で境界あり。「Kアニメ」->「K」は 'ア' で境界なし -> スキップ。
const TITLE_BOUNDARY_RE = /^[\s第#（(「『[【・\d]/

// U+2018 / U+2019 / U+02BC → U+0027 に正規化（list.json と snapshot の表記ゆれ吸収）
// 実例: DOG DAYS' のエピソードタイトルが U+2019、list.json が U+0027
function normalizeQuotes(s) {
  return s.replace(/[‘’ʼ]/g, "'").replace(/＆/g, '&')
}

/**
 * エピソードタイトルを list-index の byTitle マップと前方一致させて seriesId を返す。
 * 最長マッチを優先。語境界ガード: シリーズタイトル直後が区切り文字でない場合はスキップ。
 * アポストロフィ表記ゆれ（U+2019 vs U+0027）を正規化して比較する。
 * @param {string} episodeTitle
 * @param {Map<string,number>} byTitle
 * @returns {number|null}
 */
export function resolveByTitle(episodeTitle, byTitle) {
  const normEp = normalizeQuotes(episodeTitle)
  let best = null
  for (const [title, seriesId] of byTitle) {
    const normTitle = normalizeQuotes(title)
    if (normTitle.length === 0 || !normEp.startsWith(normTitle)) continue
    const next = normEp[normTitle.length]
    if (next !== undefined && !TITLE_BOUNDARY_RE.test(next)) continue
    if (best === null || normTitle.length > best.len) {
      best = { seriesId, len: normTitle.length }
    }
  }
  return best?.seriesId ?? null
}

/**
 * エピソードのタグ（string[]）を list-index の byTitle で照合して seriesId を返す。
 * タグのアンダースコア -> スペース変換あり（dアニメキュレーションタグ形式の対応）。
 * @param {string[]} tags
 * @param {Map<string,number>} byTitle
 * @returns {number|null}
 */
export function resolveByTag(tags, byTitle) {
  for (const tag of tags) {
    if (tag === 'アニメ' || tag === 'dアニメストア') continue
    const norm = tag.replace(/_/g, ' ')
    if (byTitle.has(norm)) return byTitle.get(norm)
    if (byTitle.has(tag)) return byTitle.get(tag)
  }
  return null
}

/**
 * RSS サムネ URL（thumbnails/{N}/{N}.{rev}）から contentId（so{N}）を復元する。
 * @param {string|null|undefined} thumbnailUrl
 * @returns {string|null}
 */
export function contentIdFromThumbnail(thumbnailUrl) {
  const m = thumbnailUrl?.match(/\/thumbnails\/(\d+)\//)
  return m ? `so${m[1]}` : null
}

/**
 * シリーズタイトルを正規化する（list.json / nvapi 由来のシリーズタイトル専用）。
 * P08/P09（二重化畳み込み）は行わない。
 * - 末尾の (第N話) / （第N話） を除去
 * - 末尾の U+3000+本編 を除去
 * - 前後の空白 trim
 *
 * @param {string} s
 * @returns {string}
 */
export function trimSeriesTitle(s) {
  if (!s) return s ?? ''
  let t = s.trim()
  t = t.replace(/[（(]第\d+話[）)]\s*$/, '').trim()
  t = t.replace(/\u3000本編$/, '').trim()
  return t
}

/**
 * エピソードタイトルのフォールバック正規化（仮シリーズ命名専用）。
 *
 * 1. 末尾の話数注記除去: (第N話) / U+3000+本編 / 半角スペース+本編 を末尾から除去
 * 2. 二重化畳み込み（P08）: "X[U+3000]X" -> "X"（sep は U+3000 のみ・半角スペースは対象外）
 * 3. 二重化畳み込み（P09）: "A[U+3000]...[U+3000 or ' ']A" -> "A"
 *
 * extractSeriesTitle のフォールバックとして使用する。
 * シリーズタイトルへの適用には trimSeriesTitle を使うこと。
 *
 * @param {string} s
 * @returns {string}
 */
export function sanitizeTitle(s) {
  if (!s) return s ?? ''
  let t = s.trim()

  // 1. 末尾の話数注記・本編を先に除去（重複チェック前に形を揃える）
  t = t.replace(/[（(]第\d+話[）)]\s*$/, '').trim()
  t = t.replace(/[\u3000 ]本編$/, '').trim()

  // 2a. 正確な中点セパレータ: "X[U+3000]X" -> "X"（U+3000 のみ・半角スペースは不問）
  //     奇数長のときだけ成立（sep が1文字）
  if (t.length % 2 === 1) {
    const mid = (t.length - 1) / 2
    if (t[mid] === '\u3000') {
      const first = t.slice(0, mid)
      if (first === t.slice(mid + 1)) return first
    }
  }

  // 2b. 最初の U+3000 前のテキストが末尾に繰り返す: "A[U+3000]...[U+3000 or ' ']A" -> "A"
  const u3000 = t.indexOf('\u3000')
  if (u3000 >= 4) {
    const firstPart = t.slice(0, u3000)
    if (t.endsWith(firstPart)) {
      const beforeEnd = t[t.length - firstPart.length - 1]
      if (beforeEnd === '\u3000' || beforeEnd === ' ') return firstPart
    }
  }

  return t
}

/**
 * エピソードタイトルからシリーズ名を抽出する（仮シリーズ命名専用フォールバック）。
 * 主系は resolveByTitle（list.json 前方一致）。本関数は list.json に存在しない
 * 真の新作の仮シリーズ命名にのみ使用する。
 *
 * 実データ 2140 件の分析結果（全件が U+3000 区切り）:
 *   第N話(算用)  73.7% / #N 9.1% / 第N話(漢数字) 4.2% / 数字のみ 1.7%
 *   第N章 38件 / 第N輪 実例あり / 全角# 実例あり / EP N 2件
 *
 * パターン順序: 算用数字を先・漢数字を最後（誤マッチ防止）。
 * EP を漢数字より前に配置: "X[U+3000]EP11[U+3000]第一回Y" で 第一回 をサブタイ誤認しないため。
 * @param {string} episodeTitle
 * @returns {string}
 */
export function extractSeriesTitle(episodeTitle) {
  const t = (episodeTitle ?? '').trim()
  return (
    // 1. 第N話（算用数字 73.7%）--- 厳格: 十進数字限定
    /^(.+?)\u3000第\d+[話巻幕夜回章輪]/.exec(t)?.[1]?.trim() ??
    // 2. #N / 全角#N（9.1%）
    /^(.+?)\u3000[#＃]\d+/.exec(t)?.[1]?.trim() ??
    // 3. Episode N（EPISODE 全大文字も対応: DOG DAYS' EPISODE 7 等）
    /^(.+?)\u3000episode\s*\d+/i.exec(t)?.[1]?.trim() ??
    // 4. EP N（EP前置）漢数字より先 -- "EP11[U+3000]第一回Y" の誤マッチ防止
    /^(.+?)\u3000[Ee][Pp][\s.]*\d+/.exec(t)?.[1]?.trim() ??
    // 5. 数字のみ -- "シリーズ名[U+3000]N[U+3000]サブタイ"、ルパン三世 PART1 等 1.7%
    /^(.+?)\u3000\d+(?:\u3000|$)/.exec(t)?.[1]?.trim() ??
    // 6. 第N話（漢数字 4.2%）--- 最後: "第一回Y" サブタイ誤マッチを避けるため
    /^(.+?)\u3000第[〇一二三四五六七八九十百千万拾参參壱弐零\d]+[話巻幕夜回章輪]/
      .exec(t)?.[1]
      ?.trim() ??
    // 7. 本編（OVA/映画単体）: "シリーズ名[U+3000]本編" or "シリーズ名[U+3000]本編[U+3000]サブタイ"
    /^(.+?)\u3000本編(?:\u3000|$)/.exec(t)?.[1]?.trim() ??
    // フォールバック: 二重化・末尾注記をサニタイズして返す
    sanitizeTitle(t)
  )
}

/**
 * シリーズタイトルの djb2 変形ハッシュ -> 負整数（仮 seriesId）。
 * 決定的（同タイトル->同値）・0 除外・本物（正整数）と確実に区別。
 * @param {string} seriesTitle
 * @returns {number}
 */
export function provisionalSeriesId(seriesTitle) {
  let h = 0
  for (const ch of seriesTitle) h = (Math.imul(h, 31) + ch.codePointAt(0)) | 0
  return h <= 0 ? h - 1 : -h
}
