// scripts/nico/snapshot.mjs
// snapshot 検索API v2 取得: 期間ウィンドウ分割 + version ゲート + 支店フィルタ

import { fetchWithToS } from '../lib/http.mjs'
import { filterBranchEpisodes } from './filter.mjs'
import { logger } from '../lib/logger.mjs'

const SEARCH_BASE = 'https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search'
const VERSION_URL = 'https://snapshot.search.nicovideo.jp/api/v2/snapshot/version'
const QUERY = 'dアニメストア'
const TARGETS = 'tagsExact'
const FIELDS =
  'contentId,title,viewCounter,tags,startTime,thumbnailUrl,channelId,description,commentCounter,likeCounter,mylistCounter,lengthSeconds'
const LIMIT = 100
/** 支店開設年（アニメ配信開始ごろ） */
const FIRST_YEAR = 2012
/** snapshot API の _offset 上限 */
const MAX_OFFSET = 100000

/** 年ベースのウィンドウ一覧を生成（TZ +09:00 必須） */
export function buildYearWindows(currentYear = new Date().getFullYear()) {
  const windows = []
  for (let y = FIRST_YEAR; y <= currentYear; y++) {
    windows.push({
      gte: `${y}-01-01T00:00:00+09:00`,
      lte: `${y}-12-31T23:59:59+09:00`,
    })
  }
  return windows
}

/** snapshot/version の last_modified を取得 */
export async function fetchSnapshotVersion() {
  const resp = await fetchWithToS(VERSION_URL)
  if (resp.status !== 200) {
    throw new Error(`[snapshot] version check failed: HTTP ${resp.status}`)
  }
  const json = await resp.json()
  return json.last_modified
}

/**
 * 1ウィンドウ分を全ページ取得
 * @returns {Promise<unknown[]>} エピソード配列（フィルタ前・全channelId混在）
 */
export async function fetchWindow(gte, lte) {
  const episodes = []
  let offset = 0

  while (true) {
    const params = new URLSearchParams({
      q: QUERY,
      targets: TARGETS,
      _fields: FIELDS,
      _sort: '-startTime',
      _limit: String(LIMIT),
      _offset: String(offset),
      'filters[startTime][gte]': gte,
      'filters[startTime][lte]': lte,
    })

    const resp = await fetchWithToS(`${SEARCH_BASE}?${params}`)
    if (resp.status !== 200) {
      throw new Error(`[snapshot] search API failed: HTTP ${resp.status} gte=${gte}`)
    }
    const json = await resp.json()
    if (json.meta?.status !== 200) {
      throw new Error(`[snapshot] API meta error status=${json.meta?.status} gte=${gte}`)
    }
    if (!json.data?.length) break

    episodes.push(...json.data)

    if (json.data.length < LIMIT) break
    offset += LIMIT
    if (offset >= MAX_OFFSET) {
      logger.warn('snapshot', 'offset limit reached, window may be incomplete', { gte, lte })
      break
    }
  }

  return episodes
}

/**
 * 全年ウィンドウを順番に取得し、id dedup して支店フィルタ済みエピソードを返す。
 * @param {string | null} storedVersionLastModified - 前回の last_modified（version ゲート用）
 * @param {number} [currentYear]
 * @returns {Promise<{skipped: boolean, episodes?: unknown[], newVersion?: string}>}
 */
export async function fetchAllBranchEpisodes(storedVersionLastModified, currentYear) {
  const newVersion = await fetchSnapshotVersion()

  if (storedVersionLastModified && storedVersionLastModified === newVersion) {
    logger.info('snapshot', 'version unchanged, skipping full fetch', {
      last_modified: newVersion,
    })
    return { skipped: true }
  }

  const windows = buildYearWindows(currentYear)
  const seen = new Set()
  const all = []

  for (const { gte, lte } of windows) {
    logger.info('snapshot', 'fetching window', { gte, lte })
    const items = await fetchWindow(gte, lte)
    for (const item of items) {
      if (!seen.has(item.contentId)) {
        seen.add(item.contentId)
        all.push(item)
      }
    }
  }

  const episodes = filterBranchEpisodes(all)
  logger.info('snapshot', 'fetch complete', { total: all.length, branch: episodes.length })

  return { skipped: false, episodes, newVersion }
}
