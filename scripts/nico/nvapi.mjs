// scripts/nico/nvapi.mjs
// nvapi v2/series 取得: 各話リスト・話順・支店判定

import { fetchWithToS } from '../lib/http.mjs'
import { logger } from '../lib/logger.mjs'

const NVAPI_BASE = 'https://nvapi.nicovideo.jp/v2/series'
const NVAPI_HEADERS = {
  'X-Frontend-Id': '6',
  'X-Frontend-Version': '0',
  'X-Niconico-Language': 'ja-jp',
}

export const BRANCH_CHANNEL = 'ch2632720'

/**
 * nvapi v2/series/<id> を取得して data を返す。
 * @param {number} seriesId
 * @returns {Promise<{detail: object, items: object[]}>}
 */
export async function fetchSeriesData(seriesId) {
  const resp = await fetchWithToS(`${NVAPI_BASE}/${seriesId}`, { headers: NVAPI_HEADERS })
  if (resp.status !== 200) {
    throw new Error(`[nvapi] HTTP ${resp.status} for series/${seriesId}`)
  }
  const json = await resp.json()
  return json.data
}

/**
 * detail.owner.channel.id が ch2632720 か判定（支店シリーズ）
 */
export function isBranchSeries(detail) {
  return detail?.owner?.channel?.id === BRANCH_CHANNEL
}

/**
 * nvapi items[] からエピソード更新レコードを生成（contentId + 話順）
 * @param {number} seriesId
 * @param {object[]} items - nvapi data.items[]
 * @returns {{ contentId: string, seriesId: number, episodeNo: number }[]}
 */
export function mapNvapiItems(seriesId, items) {
  return items.map((item, i) => ({
    contentId: String(item.video?.id ?? item.id ?? ''),
    seriesId,
    episodeNo: i + 1,
  }))
}

/**
 * 全シリーズを逐次 nvapi でシード取得（初回のみ）。
 * ToS 準拠: fetchWithToS が適応遅延・503バックオフを担う。
 * @param {number[]} seriesIds
 * @param {(seriesId: number, data: object) => Promise<void>} onSeries
 */
export async function seedAllSeries(seriesIds, onSeries) {
  let processed = 0
  let skipped = 0

  for (const id of seriesIds) {
    try {
      const data = await fetchSeriesData(id)
      if (!isBranchSeries(data.detail)) {
        skipped++
        continue
      }
      await onSeries(id, data)
      processed++
      if (processed % 100 === 0) {
        logger.info('nvapi', 'seed progress', { processed, total: seriesIds.length })
      }
    } catch (err) {
      logger.warn('nvapi', 'failed to fetch series, skipping', {
        seriesId: id,
        error: err.message,
      })
    }
  }

  logger.info('nvapi', 'seed complete', { processed, skipped, total: seriesIds.length })
  return { processed, skipped }
}

/**
 * 差分更新: 対象 seriesIds のみ nvapi で再取得して更新コールバックを呼ぶ。
 * @param {number[]} seriesIds - 更新対象のみ（全件でなく絞り込み済み）
 * @param {(seriesId: number, data: object) => Promise<void>} onSeries
 */
export async function updateSeries(seriesIds, onSeries) {
  return seedAllSeries(seriesIds, onSeries)
}
