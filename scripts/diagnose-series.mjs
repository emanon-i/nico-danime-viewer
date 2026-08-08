// GitHub Actions ランナーから、シリーズ情報源の実際の応答を読み取り専用で診断する。

import { pathToFileURL } from 'node:url'

import { fetchWithToS } from './lib/http.mjs'
import {
  _resetNvapiStats,
  fetchSeriesData,
  getNvapiStats,
  isBranchSeries,
  mapNvapiEpisodes,
} from './nico/nvapi.mjs'

const WATCH_BASE = 'https://www.nicovideo.jp/watch'
const SERIES_BASE = 'https://www.nicovideo.jp/series'
const MAX_TARGETS = 60

export function parseSeriesIds(value) {
  return parseTargets(value, (token) => {
    const id = Number(token)
    return Number.isInteger(id) && id > 0 ? id : null
  })
}

export function parseContentIds(value) {
  return parseTargets(value, (token) => (/^so\d+$/.test(token) ? token : null))
}

function parseTargets(value, parse) {
  const tokens = String(value ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
  const parsed = tokens.map(parse)
  if (parsed.some((target) => target == null)) {
    throw new Error(`invalid diagnostic target: ${value}`)
  }
  const unique = [...new Set(parsed)]
  if (unique.length > MAX_TARGETS) {
    throw new Error(`too many diagnostic targets: ${unique.length} > ${MAX_TARGETS}`)
  }
  return unique
}

export function extractServerResponse(html) {
  const match = String(html).match(/<meta name="server-response" content="([\s\S]*?)"\s*\/?>/)
  if (!match) return null
  const decoded = match[1]
    .replaceAll('&quot;', '"')
    .replaceAll('&#34;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
  return JSON.parse(decoded)
}

export function summarizeWatchResponse(contentId, status, payload) {
  const response = payload?.data?.response
  const series = response?.series
  const ownerId =
    response?.owner?.id ?? response?.video?.owner?.id ?? series?.video?.first?.owner?.id ?? null
  return {
    kind: 'watch',
    contentId,
    httpStatus: status,
    payloadStatus: payload?.meta?.status ?? null,
    ownerId,
    seriesId: Number.isInteger(series?.id) ? series.id : null,
    seriesTitle: series?.title ?? null,
    firstContentId: series?.video?.first?.id ?? null,
  }
}
export function extractSeriesPageContentIds(html) {
  return [...new Set(String(html).match(/\bso\d+\b/g) ?? [])]
}

export function summarizeSeriesPageResponse(seriesId, status, html) {
  const contentIds = extractSeriesPageContentIds(html)
  return {
    kind: 'series-page',
    seriesId,
    httpStatus: status,
    htmlLength: html.length,
    itemCount: contentIds.length,
    contentIds,
  }
}

export function summarizeSeriesResponse(seriesId, data) {
  const items = Array.isArray(data?.items) ? data.items : null
  const episodes = items ? mapNvapiEpisodes(seriesId, items) : []
  return {
    kind: 'series',
    seriesId,
    dataType: data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data,
    dataKeys: data && typeof data === 'object' ? Object.keys(data).sort() : [],
    isBranchSeries: isBranchSeries(data?.detail),
    ownerChannelId: data?.detail?.owner?.channel?.id ?? null,
    title: data?.detail?.title ?? null,
    itemsType: items ? 'array' : data?.items === null ? 'null' : typeof data?.items,
    itemCount: items?.length ?? null,
    contentIds: episodes.map((episode) => episode.contentId),
    orders: episodes.map((episode) => episode.episodeNo),
    titles: items?.map((item) => item?.video?.title ?? null) ?? [],
  }
}

async function diagnoseWatch(contentId) {
  const response = await fetchWithToS(`${WATCH_BASE}/${contentId}`)
  const html = await response.text()
  const payload = extractServerResponse(html)
  return summarizeWatchResponse(contentId, response.status, payload)
}
async function diagnoseSeriesPage(seriesId) {
  const response = await fetchWithToS(`${SERIES_BASE}/${seriesId}`)
  const html = await response.text()
  return summarizeSeriesPageResponse(seriesId, response.status, html)
}

async function main() {
  const requestedSeriesIds = parseSeriesIds(process.env.NICO_DIAG_SERIES_IDS)
  const contentIds = parseContentIds(process.env.NICO_DIAG_CONTENT_IDS)
  if (requestedSeriesIds.length === 0 && contentIds.length === 0) {
    throw new Error('NICO_DIAG_SERIES_IDS or NICO_DIAG_CONTENT_IDS is required')
  }

  const discoveredSeriesIds = []
  for (const contentId of contentIds) {
    try {
      const result = await diagnoseWatch(contentId)
      console.log(`[series-diagnostic] ${JSON.stringify(result)}`)
      if (result.seriesId) discoveredSeriesIds.push(result.seriesId)
    } catch (error) {
      console.log(
        `[series-diagnostic] ${JSON.stringify({ kind: 'watch', contentId, error: error.message })}`
      )
    }
  }

  _resetNvapiStats()
  const seriesIds = [...new Set([...requestedSeriesIds, ...discoveredSeriesIds])]
  for (const seriesId of seriesIds) {
    try {
      const result = await diagnoseSeriesPage(seriesId)
      console.log(`[series-diagnostic] ${JSON.stringify(result)}`)
    } catch (error) {
      console.log(
        `[series-diagnostic] ${JSON.stringify({ kind: 'series-page', seriesId, error: error.message })}`
      )
    }

    try {
      const data = await fetchSeriesData(seriesId)
      console.log(`[series-diagnostic] ${JSON.stringify(summarizeSeriesResponse(seriesId, data))}`)
    } catch (error) {
      console.log(
        `[series-diagnostic] ${JSON.stringify({ kind: 'series', seriesId, error: error.message })}`
      )
    }
  }
  console.log(`[series-diagnostic] ${JSON.stringify({ kind: 'nvapi-stats', ...getNvapiStats() })}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
