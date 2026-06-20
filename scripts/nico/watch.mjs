// scripts/nico/watch.mjs
// watch ページ server-response meta から seriesId を取得する
// seriesId は JSON API では取れず、watch ページ HTML の <meta name="server-response"> のみが source

import { fetchWithToS } from '../lib/http.mjs'
import { logger } from '../lib/logger.mjs'

const WATCH_BASE = 'https://www.nicovideo.jp/watch'

/**
 * watch ページ HTML から seriesId / contentId / channelId / seriesTitle を返す。
 *
 * 戻り値の意味:
 *   - null                        → fetch 失敗 / bot block (video.id=null) → 呼び出し側は unresolved 維持でリトライ
 *   - { seriesId: null, ... }     → 本物の非シリーズ (PV・単話投稿等) → 呼び出し側は rss_only 確定
 *   - { seriesId: number, ... }   → 正常解決 → 呼び出し側は resolved 確定
 *
 * @param {string} watchIdOrContentId  watchId（数値文字列）または contentId（so…）
 * @returns {Promise<{seriesId:number|null,contentId:string,channelId:string|null,seriesTitle:string|null}|null>}
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

  if (!contentId) {
    // video.id=null = bot block（DC IP ソフトブロック）または削除済み動画
    // → null を返して呼び出し側が unresolved 維持・リトライできるようにする
    logger.warn('watch', 'no contentId (bot block?)', { id: watchIdOrContentId })
    return null
  }

  if (!seriesId) {
    // contentId あり・seriesId なし = 本物の非シリーズ（PV・単話投稿・告知等）
    // → seriesId:null オブジェクトを返して呼び出し側が rss_only 確定できるようにする
    logger.info('watch', 'no series', { id: watchIdOrContentId, contentId })
    return { seriesId: null, contentId: String(contentId), channelId, seriesTitle }
  }

  return {
    seriesId: Number(seriesId),
    contentId: String(contentId),
    channelId,
    seriesTitle,
  }
}
