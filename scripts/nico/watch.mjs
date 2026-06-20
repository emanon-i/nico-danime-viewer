// scripts/nico/watch.mjs
// watch ページ server-response meta から seriesId を取得する
// seriesId は JSON API では取れず、watch ページ HTML の <meta name="server-response"> のみが source

import { fetchWithToS } from '../lib/http.mjs'
import { logger } from '../lib/logger.mjs'

const WATCH_BASE = 'https://www.nicovideo.jp/watch'

/**
 * watch ページ HTML から seriesId / contentId / channelId / seriesTitle を返す。
 * @param {string} watchIdOrContentId  watchId（数値文字列）または contentId（so…）
 * @returns {Promise<{seriesId:number,contentId:string,channelId:string|null,seriesTitle:string|null}|null>}
 */
export async function fetchWatchSeriesInfo(watchIdOrContentId) {
  let resp
  try {
    resp = await fetchWithToS(`${WATCH_BASE}/${watchIdOrContentId}`, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'ja,en-US;q=0.9',
      },
      redirect: 'follow',
    })
  } catch (e) {
    logger.warn('watch', 'fetch failed', { id: watchIdOrContentId, err: e.message })
    return null
  }

  if (resp.status !== 200) {
    logger.warn('watch', 'non-200', { id: watchIdOrContentId, status: resp.status })
    return null
  }

  const html = await resp.text()
  const m = html.match(/name="server-response"\s+content="([^"]+)"/)
  if (!m) {
    logger.warn('watch', 'server-response meta not found', { id: watchIdOrContentId })
    return null
  }

  let json
  try {
    const decoded = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
    json = JSON.parse(decoded)
  } catch (e) {
    logger.warn('watch', 'JSON parse failed', { id: watchIdOrContentId, err: e.message })
    return null
  }

  const r = json?.data?.response
  const seriesId = r?.series?.id ?? null
  const contentId = r?.video?.id ?? null
  const channelId = r?.channel?.id ?? null // 文字列 "ch2632720"
  const seriesTitle = r?.series?.title ?? null

  if (!seriesId || !contentId) {
    logger.info('watch', 'no series', { id: watchIdOrContentId, contentId })
    return null
  }

  return {
    seriesId: Number(seriesId),
    contentId: String(contentId),
    channelId,
    seriesTitle,
  }
}
