// scripts/nico/list.mjs
// list.json / programlist.json 取得

import { fetchWithToS } from '../lib/http.mjs'

const LIST_JSON_URL = 'https://site.nicovideo.jp/danime/static/data/list.json'
const PROGRAMLIST_URL = 'https://site.nicovideo.jp/danime/static/data/programlist.json'

/**
 * list.json（全作品カタログ・五十音）を取得
 * @returns {Promise<{title: string, col_key: string, url: string}[]>}
 */
export async function fetchListJson() {
  const resp = await fetchWithToS(LIST_JSON_URL)
  if (resp.status !== 200) throw new Error(`[list] HTTP ${resp.status}`)
  return resp.json()
}

/**
 * programlist.json（今季番組表）を取得
 * @returns {Promise<object[]>}
 */
export async function fetchProgramlist() {
  const resp = await fetchWithToS(PROGRAMLIST_URL)
  if (resp.status !== 200) throw new Error(`[programlist] HTTP ${resp.status}`)
  return resp.json()
}
