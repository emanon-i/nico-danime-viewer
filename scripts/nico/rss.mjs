// scripts/nico/rss.mjs
// 新着 RSS: 毎時取得・HWM 増分・watch id 解決

import { fetchWithToS } from '../lib/http.mjs'
import { logger } from '../lib/logger.mjs'

const RSS_URL = 'https://ch.nicovideo.jp/ch2632720/video?rss=2.0'

/**
 * RSS を条件付き GET で取得（304 ならスキップ）
 * @returns {Promise<{status: number, body: string|null, etag: string|null, lastModified: string|null}>}
 */
export async function fetchRss(etag = null, lastModified = null) {
  const headers = {}
  if (etag) headers['If-None-Match'] = etag
  if (lastModified) headers['If-Modified-Since'] = lastModified

  const resp = await fetchWithToS(RSS_URL, { headers })
  return {
    status: resp.status,
    etag: resp.headers?.get?.('ETag') ?? null,
    lastModified: resp.headers?.get?.('Last-Modified') ?? null,
    body: resp.status === 200 ? await resp.text() : null,
  }
}

/**
 * RSS XML のチャンネル情報と item リストを抽出（正規表現パース）
 * @param {string} xml
 * @returns {{ channelTitle: string, items: {title: string, link: string, guid: string, pubDate: string}[] }}
 */
export function parseRssXml(xml) {
  const channelTitleM = xml.match(
    /<channel[^>]*>[\s\S]*?<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i
  )
  const channelTitle = channelTitleM ? channelTitleM[1].trim() : ''

  const items = []
  const itemRe = /<item>([\s\S]*?)<\/item>/g
  let m
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1]
    const get = (tag) => {
      const tm = block.match(
        new RegExp(
          `<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`,
          'i'
        )
      )
      return tm ? (tm[1] ?? tm[2] ?? '').trim() : ''
    }
    items.push({
      title: get('title'),
      link: get('link'),
      guid: get('guid'),
      pubDate: get('pubDate'),
    })
  }

  return { channelTitle, items }
}

/**
 * watch id（数値文字列）を link URL から抽出
 * @param {string} link - "https://www.nicovideo.jp/watch/12345678"
 * @returns {string|null}
 */
export function extractWatchId(link) {
  const m = link?.match(/\/watch\/(\d+)/)
  return m ? m[1] : null
}

/**
 * タイトルを正規化（突合用）
 */
export function normalizeTitleForMatch(title) {
  return (title ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * RSS items から HWM より新しいものだけ抽出（guid で判定）
 * @param {{ guid: string }[]} items
 * @param {string|null} lastGuid - 前回の最新 guid（null = 初回）
 * @returns {object[]} 新しい items（先頭が最新）
 */
export function filterNewRssItems(items, lastGuid) {
  if (!lastGuid) return items
  const idx = items.findIndex((i) => i.guid === lastGuid)
  return idx === -1 ? items : items.slice(0, idx)
}

/**
 * RSS アサート: チャンネルタイトルに支店名・items 非空・link が watch URL
 */
export function assertRssOk(items, channelTitle) {
  if (!channelTitle?.includes('dアニメストア')) {
    throw new Error(`[assert:rss] channel.title does not include dアニメストア: "${channelTitle}"`)
  }
  if (!items?.length) {
    throw new Error('[assert:rss] no items found in RSS')
  }
  for (const item of items.slice(0, 3)) {
    if (!item.link?.includes('nicovideo.jp/watch/')) {
      throw new Error(`[assert:rss] invalid link format: "${item.link}"`)
    }
  }
}

/**
 * title+pubDate 突合で RSS watch id を contentId に解決する（DB 内 episodes から）
 * @param {import('better-sqlite3').Database} db
 * @param {{ watchId: string, title: string, pubDate: string }[]} rssItems
 */
export function resolveRssItems(db) {
  // unresolved に加え rss_only も再解決対象に含める（§D）。後から episodes が追加（nvapi 解決/
  // snapshot 回収）されると、以前 rss_only だった新着が contentId に解決できるようになるため。
  const unresolved = db
    .prepare(
      `SELECT watch_id, title, pub_date FROM rss_items WHERE resolution_status IN ('unresolved', 'rss_only')`
    )
    .all()

  if (!unresolved.length) return

  // episodes から正規化タイトルインデックスを構築
  const episodes = db
    .prepare('SELECT content_id, title, start_time FROM episodes WHERE title IS NOT NULL')
    .all()

  const index = new Map()
  for (const ep of episodes) {
    const key = normalizeTitleForMatch(ep.title)
    if (key) index.set(key, ep.content_id)
  }

  const updateStmt = db.prepare(
    'UPDATE rss_items SET resolved_content_id = ?, resolution_status = ? WHERE watch_id = ?'
  )
  const run = db.transaction(() => {
    for (const item of unresolved) {
      const key = normalizeTitleForMatch(item.title)
      const contentId = index.get(key) ?? null
      const status = contentId ? 'resolved' : 'rss_only'
      updateStmt.run(contentId, status, item.watch_id)
    }
  })
  run()

  const resolved = unresolved.filter((i) => {
    const key = normalizeTitleForMatch(i.title)
    return index.has(key)
  }).length
  logger.info('rss', 'resolution complete', { total: unresolved.length, resolved })
}
