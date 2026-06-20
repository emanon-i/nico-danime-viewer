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
 * list.json の items から title→seriesId / seriesId→title の双方向インデックスを構築する。
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
// 「K 第1話」→「K」は ' ' で境界あり。「Kアニメ」→「K」は 'ア' で境界なし → スキップ。
const TITLE_BOUNDARY_RE = /^[\s第#（(「『[【・\d]/

/**
 * エピソードタイトルを list-index の byTitle マップと前方一致させて seriesId を返す。
 * 最長マッチを優先。語境界ガード: シリーズタイトル直後が区切り文字でない場合はスキップ。
 * @param {string} episodeTitle
 * @param {Map<string,number>} byTitle
 * @returns {number|null}
 */
export function resolveByTitle(episodeTitle, byTitle) {
  let best = null
  for (const [title, seriesId] of byTitle) {
    if (title.length === 0 || !episodeTitle.startsWith(title)) continue
    const next = episodeTitle[title.length]
    if (next !== undefined && !TITLE_BOUNDARY_RE.test(next)) continue
    if (best === null || title.length > best.len) {
      best = { seriesId, len: title.length }
    }
  }
  return best?.seriesId ?? null
}

/**
 * エピソードのタグ（string[]）を list-index の byTitle で照合して seriesId を返す。
 * タグのアンダースコア → スペース変換あり（dアニメキュレーションタグ形式の対応）。
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
 * エピソードタイトルからシリーズ名を抽出する（第N話・#N・Episode N の直前まで）。
 * 抽出失敗時はタイトル全体を返す。
 * @param {string} episodeTitle
 * @returns {string}
 */
export function extractSeriesTitle(episodeTitle) {
  const t = episodeTitle ?? ''
  return (
    t.match(/^(.+?)[\s\u3000]第\d+[話巻]/)?.[1]?.trim() ??
    t.match(/^(.+?)[\s\u3000]#\d+/)?.[1]?.trim() ??
    t.match(/^(.+?)[\s\u3000][Ee]pisode\s*\d+/)?.[1]?.trim() ??
    t
  )
}

/**
 * シリーズタイトルの djb2 変形ハッシュ → 負整数（仮 seriesId）。
 * 決定的（同タイトル→同値）・0 除外・本物（正整数）と確実に区別。
 * @param {string} seriesTitle
 * @returns {number}
 */
export function provisionalSeriesId(seriesTitle) {
  let h = 0
  for (const ch of seriesTitle) h = (Math.imul(h, 31) + ch.codePointAt(0)) | 0
  return h <= 0 ? h - 1 : -h
}
