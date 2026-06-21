// scripts/fetch.mjs
// pnpm fetch エントリポイント: 全データソース取得 -> ETL -> 静的 JSON export
//
// 環境変数:
//   NICO_USER_AGENT  問い合わせ先を含む UA 文字列（省略可・デフォルト値あり）
//   NICO_FORCE_SNAPSHOT=1  version gate をバイパスして常に全取得
//   NICO_FORCE_SEED=1      週次 seed ガードを無視して seed を強制

import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fetchAllBranchEpisodes, fetchSnapshotVersion } from './nico/snapshot.mjs'
import { assertSnapshotOk } from './nico/assert.mjs'
import {
  fetchAllStaticJsons,
  fetchListJson,
  buildListIndex,
  extractSeriesIdsFromItems,
  resolveByTitle,
  resolveByTag,
  contentIdFromThumbnail,
  extractSeriesTitle,
  provisionalSeriesId,
  trimSeriesTitle,
} from './nico/list.mjs'
import { fetchSeriesData, mapNvapiEpisodes, isBranchSeries } from './nico/nvapi.mjs'
import { fetchRssMultiPage, extractWatchId } from './nico/rss.mjs'

import { deriveSeriesTagsFromStore } from './etl/tags.mjs'
import { processEpisodeTags } from './etl/tags.mjs'
import {
  extractSeriesIdFromUrl,
  deriveSeriesOverviewsFromStore,
  getSeriesTagsMapFromStore,
  computeFranchiseKeys,
} from './etl/series.mjs'
import { deriveCoursFromTagsFromStore } from './etl/cours.mjs'
import { projectAll, exportNew as exportNewStore, exportWorksPartial } from './store/project.mjs'

import { logger } from './lib/logger.mjs'

import {
  loadStore,
  loadPartialStore,
  writeBackStore,
  writeSeriesFiles,
  upsertEpisodes as storeUpsertEps,
  upsertSeries as storeUpsertSeries,
  updateSeries as storeUpdateSeries,
  syncSeriesThumbnails as storeSyncThumbs,
  syncSeriesTimestamps as storeSyncTimestamps,
  updateMetaState as storeUpdateMeta,
  upsertRssItems as storeUpsertRss,
  updateRssResolution as storeUpdateRssResolution,
  replaceSeriesTags as storeReplaceSeriesTags,
  countSeriesWithEpisodes,
  chronoSort,
} from './store/store.mjs'

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../data')

const CLI_ARGS = process.argv.slice(2)
const CLI_MODE = CLI_ARGS.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? 'full'

function detectShrinkFromStore(store, dataDir, threshold = 0.9) {
  const ep0 = countSeriesWithEpisodes(store)
  let baseline = 0
  try {
    const w = JSON.parse(readFileSync(join(dataDir, 'works.json'), 'utf-8'))
    baseline = (w.works ?? []).filter((x) => (x.episodeCount ?? 0) > 0).length
  } catch {
    /* works.json がなければ baseline 0 = 比較しない（初回） */
  }
  return { ep0, baseline, shrink: baseline > 0 && ep0 < Math.floor(baseline * threshold) }
}

function runCoursFromTagsOnly(store) {
  for (const s of store.series.values()) {
    if (s.cours !== null) {
      s.cours = null
      store._dirtySeries.add(s.seriesId)
    }
  }
  const tagMap = deriveCoursFromTagsFromStore(store, chronoSort)
  for (const [id, cours] of tagMap) {
    const s = store.series.get(id)
    if (s) {
      s.cours = cours
      store._dirtySeries.add(id)
    }
  }
  logger.info('fetch', '[JS] E3 cours from tags (primary)', { count: tagMap.size })
}

function applyIsAvailableGrace(store) {
  const fetched = store.meta.snapshotFetchedAt
  if (!fetched) return
  const fetchedMs = new Date(fetched).getTime()
  const staleMs = 3 * 24 * 60 * 60 * 1000
  const graceMs = 2 * 24 * 60 * 60 * 1000

  if (Date.now() - fetchedMs > staleMs) {
    logger.info('fetch', '[JS] E7 isAvailable grace: snapshotFetchedAt too old -> skip', {
      snapshotFetchedAt: fetched,
    })
    return
  }

  const cutoff = new Date(fetchedMs - graceMs).toISOString()
  let toFalse = 0
  let toTrue = 0
  for (const s of store.series.values()) {
    if (s.seriesId < 0) continue
    const seen = s.lastSeenAt
    const shouldBeAvailable = seen != null && seen >= cutoff
    if (!shouldBeAvailable && s.isAvailable) {
      s.isAvailable = false
      store._dirtySeries.add(s.seriesId)
      toFalse++
    } else if (shouldBeAvailable && !s.isAvailable) {
      s.isAvailable = true
      store._dirtySeries.add(s.seriesId)
      toTrue++
    }
  }
  logger.info('fetch', '[JS] E7 isAvailable grace applied', { toFalse, toTrue, cutoff })
}

// RFC822 など任意の日付文字列を ISO8601 へ正規化（解釈不能・null はそのまま null）。
function toIso(value) {
  if (!value) return null
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

function registerProvisionalSeries(store, watchId, rssEntry) {
  const rawTitle = rssEntry.title ?? ''
  const contentId = contentIdFromThumbnail(rssEntry.thumbnailUrl ?? null)
  if (!contentId) return null

  const seriesTitle = extractSeriesTitle(rawTitle)
  const sid = provisionalSeriesId(seriesTitle)

  if (!store.series.has(sid)) {
    storeUpsertSeries(store, [{ seriesId: sid, title: seriesTitle, isAvailable: true }])
  }

  storeUpsertEps(store, [
    {
      contentId,
      seriesId: sid,
      title: rawTitle,
      // RSS pubDate は RFC822（"Sat, 20 Jun 2026 …"）。canonical な startTime は ISO8601 に
      // 揃える（snapshot/nvapi 由来の実話と同形式＝firstAt の文字列比較・並びを健全に保つ）。
      startTime: toIso(rssEntry.pubDate),
      description: rssEntry.description ?? null,
    },
  ])

  storeUpdateRssResolution(store, watchId, contentId, 'resolved')
  logger.info('fetch', '[JS] provisional series registered', {
    watchId,
    contentId,
    seriesTitle,
    sid,
  })
  return sid
}

async function rescueMissingEps(store, missedContentIds, contentToSeries, byTitle, dataDir = null) {
  if (missedContentIds.size === 0) return

  for (const cid of [...missedContentIds]) {
    const sid = contentToSeries.get(cid)
    if (sid != null) {
      const ep = store.episodes.get(cid)
      if (ep && (ep.seriesId == null || ep.seriesId < 0)) {
        ep.seriesId = sid
        store._dirtySeries.add(sid)
      }
      missedContentIds.delete(cid)
    }
  }
  logger.info('fetch', '[JS] A2 direct resolve', {
    directResolved: contentToSeries.size,
    remaining: missedContentIds.size,
  })

  if (missedContentIds.size === 0) return

  const seriesIdToMissed = new Map()
  for (const cid of [...missedContentIds]) {
    const ep = store.episodes.get(cid)
    if (!ep) {
      missedContentIds.delete(cid)
      continue
    }

    const seriesId =
      resolveByTag(ep.tagsCurated?.length ? ep.tagsCurated : (ep.tags ?? []), byTitle) ??
      resolveByTitle(ep.title, byTitle)

    if (!seriesId) continue

    if (!seriesIdToMissed.has(seriesId)) seriesIdToMissed.set(seriesId, [])
    seriesIdToMissed.get(seriesId).push(cid)
  }

  for (const [seriesId, cids] of seriesIdToMissed) {
    const wasNew = !store.series.has(seriesId)
    if (wasNew) {
      const title = [...(byTitle?.entries() ?? [])].find(([, sid]) => sid === seriesId)?.[0] ?? ''
      storeUpsertSeries(store, [{ seriesId, title, isAvailable: true }])
    }

    // list.json でマッチした cids は支店確定（list.json 自体が支店専用カタログ）。
    // nvapi 失敗・non-branch 判定でも这些 cid を権威的に seriesId へ割当て、仮降格を防ぐ。
    function applyListJsonRescue(reason) {
      let assigned = 0
      for (const cid of cids) {
        if (!missedContentIds.has(cid)) continue
        const ep = store.episodes.get(cid)
        if (ep && (ep.seriesId == null || ep.seriesId < 0)) {
          ep.seriesId = seriesId
          store._dirtySeries.add(seriesId)
          assigned++
        }
        contentToSeries.set(cid, seriesId)
        missedContentIds.delete(cid)
        logger.info('fetch', '[JS] A2 rescue: list.json trust (' + reason + ')', { cid, seriesId })
      }
      // 割当なし＋新規追加なら不要 series を削除
      if (assigned === 0 && wasNew) store.series.delete(seriesId)
    }

    let nvapiData
    try {
      nvapiData = await fetchSeriesData(seriesId)
    } catch (err) {
      logger.warn('fetch', '[JS] A2 nvapi failed', { seriesId, err: err.message })
      applyListJsonRescue('nvapi-error')
      continue
    }

    if (!isBranchSeries(nvapiData?.detail)) {
      logger.warn('fetch', '[JS] A2 rescue: non-branch series, skip', { seriesId })
      applyListJsonRescue('non-branch')
      continue
    }

    const eps = mapNvapiEpisodes(seriesId, nvapiData?.items ?? [])
    storeUpsertEps(store, eps)

    const allContentIds = new Set(eps.map((e) => e.contentId))
    for (const cid of [...missedContentIds]) {
      if (allContentIds.has(cid)) {
        const ep = store.episodes.get(cid)
        if (ep && (ep.seriesId == null || ep.seriesId < 0)) {
          ep.seriesId = seriesId
          store._dirtySeries.add(seriesId)
        }
        contentToSeries.set(cid, seriesId)
        missedContentIds.delete(cid)
      } else if (cids.includes(cid)) {
        // list.json title/tag-match + isBranchSeries 確認済み → nvapi 500件上限外でも支店確定
        // contentId が nvapi items に含まれない = 新話が未収録なだけ（limit超）。誤仮化を防ぐ。
        const ep = store.episodes.get(cid)
        if (ep && (ep.seriesId == null || ep.seriesId < 0)) {
          ep.seriesId = seriesId
          store._dirtySeries.add(seriesId)
        }
        contentToSeries.set(cid, seriesId)
        missedContentIds.delete(cid)
        logger.info('fetch', '[JS] A2 rescue: list.json trust (beyond nvapi 500-limit)', {
          cid,
          seriesId,
        })
      }
    }
  }

  for (const cid of [...missedContentIds]) {
    const ep = store.episodes.get(cid)
    if (!ep) {
      missedContentIds.delete(cid)
      continue
    }
    const seriesTitle = extractSeriesTitle(ep.title)
    const sid = provisionalSeriesId(seriesTitle)
    if (!store.series.has(sid)) {
      storeUpsertSeries(store, [{ seriesId: sid, title: seriesTitle, isAvailable: true }])
    }
    ep.seriesId = sid
    store._dirtySeries.add(sid)
    missedContentIds.delete(cid)
    logger.info('fetch', '[JS] A2 provisional registered', { cid, seriesTitle, sid })
  }

  if (dataDir) {
    for (const [neg] of [...store.series]) {
      if (neg >= 0) continue
      const stillUsed = [...store.episodes.values()].some((e) => e.seriesId === neg)
      if (!stillUsed) {
        store.series.delete(neg)
        const provFile = join(dataDir, 'series', `${neg}.json`)
        if (existsSync(provFile)) unlinkSync(provFile)
        logger.info('fetch', '[JS] A2 empty provisional cleaned', { neg })
      }
    }
  }

  logger.info('fetch', '[JS] A2 rescue done', { remaining: missedContentIds.size })
}

function _trimRss(store, maxItems = 200) {
  const all = [...store.rss.values()]
  if (all.length <= maxItems) return

  const byDate = (a, b) => {
    if (!a.pubDate && !b.pubDate) return 0
    if (!a.pubDate) return -1
    if (!b.pubDate) return 1
    return a.pubDate < b.pubDate ? -1 : a.pubDate > b.pubDate ? 1 : 0
  }

  const resolved = all.filter((r) => r.resolutionStatus === 'resolved').sort(byDate)
  const pending = all.filter((r) => r.resolutionStatus !== 'resolved').sort(byDate)
  const toDelete = [...resolved, ...pending].slice(0, all.length - maxItems)
  for (const r of toDelete) store.rss.delete(r.watchId)
  if (toDelete.length > 0) {
    logger.info('fetch', '[JS] rss trim', { deleted: toDelete.length, remaining: store.rss.size })
  }
}

async function runFullJS() {
  mkdirSync(DATA_DIR, { recursive: true })
  const now = new Date().toISOString()
  const stateDir = join(DATA_DIR, 'state')

  logger.info('fetch', '[JS] loadStore start')
  const store = await loadStore(DATA_DIR)
  logger.info('fetch', '[JS] loadStore done', {
    series: store.series.size,
    episodes: store.episodes.size,
    rss: store.rss.size,
  })

  const forceSnapshot = process.env.NICO_FORCE_SNAPSHOT === '1'
  if (forceSnapshot) logger.info('fetch', '[JS] NICO_FORCE_SNAPSHOT=1: version gate bypassed', {})
  const storedVersion = forceSnapshot ? null : (store.meta.snapshotVersionLastModified ?? null)
  const snapResult = await fetchAllBranchEpisodes(storedVersion)

  if (snapResult.skipped) {
    logger.info('fetch', '[JS] snapshot version unchanged -> immediate exit', {
      version: storedVersion,
    })
    return
  }

  logger.info('fetch', '[JS] phase A: snapshot')
  const { episodes: snapEps, newVersion } = snapResult
  assertSnapshotOk({ meta: { status: 200, totalCount: snapEps.length }, data: snapEps }, null)

  const mappedEps = snapEps.map((ep) => {
    const processedTags = processEpisodeTags(ep.tags ?? '', null)
    return {
      ...ep,
      tags: processedTags.map((t) => t.name),
      tagsCurated: processedTags.filter((t) => t.isCurated).map((t) => t.name),
    }
  })
  storeUpsertEps(store, mappedEps)

  const snapshotContentIds = new Set(mappedEps.map((ep) => ep.contentId))
  const missedContentIds = new Set()
  for (const ep of mappedEps) {
    const sid = store.episodes.get(ep.contentId)?.seriesId
    if (sid == null || sid < 0) {
      missedContentIds.add(ep.contentId)
    }
  }

  storeUpdateMeta(store, { snapshotVersionLastModified: newVersion, snapshotFetchedAt: now })
  logger.info('fetch', '[JS] snapshot done', {
    count: snapEps.length,
    missed: missedContentIds.size,
  })

  logger.info('fetch', '[JS] phase B: full static JSON union')
  const { listJson, programlist, extras } = await fetchAllStaticJsons()
  const { byTitle: listByTitle, bySeriesId: listBySeriesId } = buildListIndex(listJson)

  const allSeriesIds = new Set()
  for (const item of listJson) {
    const sid = extractSeriesIdFromUrl(item.url)
    if (sid) allSeriesIds.add(sid)
  }
  for (const item of programlist) {
    if (typeof item.series === 'number' && item.series > 0) allSeriesIds.add(item.series)
  }
  for (const extraItems of extras) {
    for (const sid of extractSeriesIdsFromItems(Array.isArray(extraItems) ? extraItems : [])) {
      if (sid > 0) allSeriesIds.add(sid)
    }
  }
  logger.info('fetch', '[JS] B2 seriesId union', { total: allSeriesIds.size })

  const knownSeriesIds = new Set([...store.series.keys()].filter((sid) => sid > 0))
  const newSeriesIds = [...allSeriesIds].filter((sid) => !knownSeriesIds.has(sid))
  logger.info('fetch', '[JS] B3 new seriesIds -> nvapi', { count: newSeriesIds.length })

  for (const seriesId of newSeriesIds) {
    const wasNew = !store.series.has(seriesId)
    if (wasNew) {
      storeUpsertSeries(store, [{ seriesId, title: '', isAvailable: true }])
    }
    let data
    try {
      data = await fetchSeriesData(seriesId)
    } catch (err) {
      logger.warn('fetch', '[JS] B3 nvapi failed', { seriesId, err: err.message })
      if (wasNew) store.series.delete(seriesId)
      continue
    }
    if (!isBranchSeries(data?.detail)) {
      logger.warn('fetch', '[JS] B3 non-branch series skipped', { seriesId })
      store.series.delete(seriesId)
      continue
    }
    const seriesTitle = data?.detail?.title ?? ''
    if (seriesTitle) {
      const s = store.series.get(seriesId)
      if (s && !s.title) {
        s.title = seriesTitle
        store._dirtySeries.add(seriesId)
      }
    }
    const eps = mapNvapiEpisodes(seriesId, data?.items ?? [])
    storeUpsertEps(store, eps)
  }

  const inListJson = new Set()
  for (const item of listJson) {
    const m = item.url?.match(/\/series\/(\d+)$/)
    if (!m || !item.col_key) continue
    const seriesId = Number(m[1])
    inListJson.add(seriesId)
    const s = store.series.get(seriesId)
    if (s) {
      // list.json タイトルを正準とする（trim後）: nvapi より list.json が権威
      const listTitle = trimSeriesTitle(item.title ?? '')
      if (listTitle && s.title !== listTitle) {
        s.title = listTitle
        store._dirtySeries.add(seriesId)
      }
      if (s.colKey !== item.col_key) {
        s.colKey = item.col_key
        store._dirtySeries.add(seriesId)
      }
      if (!s.isAvailable) {
        s.isAvailable = true
        store._dirtySeries.add(seriesId)
      }
    }
  }
  logger.info('fetch', '[JS] B4 col_key + isAvailable done', { inListJson: inListJson.size })

  const listIndexArr = [...listBySeriesId.entries()].map(([seriesId, title]) => ({
    seriesId,
    title,
  }))
  // list-index.json の書込は detectShrink 通過後に実施（異常時の部分前進を防ぐ）

  {
    // allTitles: 正規化タイトル → 正整数 seriesId（exact + extractSeriesTitle 正規化の両方を登録）
    // 同一キーに複数 seriesId が衝突する場合は ambiguous に追跡して除外（誤統合を防ぐ）
    const allTitles = new Map()
    const ambiguous = new Set()
    for (const [sid, s] of store.series) {
      if (sid > 0 && s.title) {
        for (const key of new Set([s.title, extractSeriesTitle(s.title)])) {
          if (ambiguous.has(key)) continue
          if (allTitles.has(key) && allTitles.get(key) !== sid) {
            ambiguous.add(key)
            allTitles.delete(key)
          } else {
            allTitles.set(key, sid)
          }
        }
      }
    }
    let reconciledCount = 0
    for (const [sid] of [...store.series]) {
      if (sid >= 0) continue
      const s = store.series.get(sid)
      if (!s) continue
      // 1. 仮シリーズの title そのまま照合
      let realId = allTitles.get(s.title)
      // 2. ep タイトルを resolveByTitle で前方一致照合（全角スペース境界ガード付き）
      if (!realId) {
        for (const ep of store.episodes.values()) {
          if (ep.seriesId !== sid) continue
          realId = resolveByTitle(ep.title ?? '', allTitles)
          if (realId) break
        }
      }
      if (!realId) continue

      // 3. nvapi で統合先が支店シリーズかつ仮 ep が話一覧に存在するか検証（誤統合防止）
      const provisionalCids = new Set()
      for (const ep of store.episodes.values()) {
        if (ep.seriesId === sid) provisionalCids.add(ep.contentId)
      }
      let mergeVerified = false
      try {
        const verifyData = await fetchSeriesData(realId)
        if (!isBranchSeries(verifyData?.detail)) {
          logger.warn('fetch', '[JS] B6 skip: realId not branch series', { sid, realId })
          continue
        }
        const nvapiEps = mapNvapiEpisodes(realId, verifyData?.items ?? [])
        const nvapiCids = new Set(nvapiEps.map((e) => e.contentId))
        mergeVerified = [...provisionalCids].some((cid) => nvapiCids.has(cid))
        if (mergeVerified) storeUpsertEps(store, nvapiEps)
      } catch (err) {
        logger.warn('fetch', '[JS] B6 nvapi verify failed', { realId, err: err.message })
      }
      if (!mergeVerified) {
        logger.warn('fetch', '[JS] B6 skip: provisional eps not in realId nvapi list', {
          sid,
          realId,
          title: s.title,
        })
        continue
      }

      // 4. 統合実施
      for (const ep of store.episodes.values()) {
        if (ep.seriesId === sid) {
          ep.seriesId = realId
          store._dirtySeries.add(realId)
        }
      }
      store.series.delete(sid)
      // 前回 run で書き出された data/series/<neg>.json を削除（次回 loadStore での再インジェスト防止）
      const provFile = join(DATA_DIR, 'series', `${sid}.json`)
      if (existsSync(provFile)) unlinkSync(provFile)
      reconciledCount++
      logger.info('fetch', '[JS] B6 reconciliation: provisional -> real', {
        provisionalId: sid,
        realId,
        title: s.title,
      })
    }
    logger.info('fetch', '[JS] B6 reconciliation done', { reconciled: reconciledCount })
  }

  if (missedContentIds.size > 0) {
    logger.info('fetch', '[JS] phase A2: rescue missing eps', { count: missedContentIds.size })
    // 正整数 seriesId のみ（仮シリーズ seriesId < 0 は除外して救出フローを実効化）
    const contentToSeries = new Map()
    for (const ep of store.episodes.values()) {
      if (ep.seriesId != null && ep.seriesId > 0) contentToSeries.set(ep.contentId, ep.seriesId)
    }
    await rescueMissingEps(store, missedContentIds, contentToSeries, listByTitle, DATA_DIR)
    logger.info('fetch', '[JS] phase A2: done', { remaining: missedContentIds.size })
  }

  for (const cid of snapshotContentIds) {
    const ep = store.episodes.get(cid)
    if (ep?.seriesId != null && ep.seriesId > 0) {
      const s = store.series.get(ep.seriesId)
      if (s && s.lastSeenAt !== now) {
        s.lastSeenAt = now
        store._dirtySeries.add(ep.seriesId)
      }
    }
  }

  logger.info('fetch', '[JS] phase E: ETL derivation')

  const overviews = deriveSeriesOverviewsFromStore(store, chronoSort)
  for (const { seriesId, descriptionFirst } of overviews) {
    if (descriptionFirst) storeUpdateSeries(store, seriesId, { descriptionFirst })
  }
  logger.info('fetch', '[JS] E1 overviews done', { count: overviews.length })

  const seriesTags = deriveSeriesTagsFromStore(store)
  for (const { seriesId, tags } of seriesTags) {
    if (tags.length > 0) storeReplaceSeriesTags(store, seriesId, tags)
  }
  logger.info('fetch', '[JS] E2 series tags done', { count: seriesTags.length })

  runCoursFromTagsOnly(store)

  const seriesTagsMap = getSeriesTagsMapFromStore(store)
  const titleMap = new Map()
  for (const s of store.series.values()) {
    if (s.isAvailable && s.seriesId > 0) titleMap.set(s.seriesId, s.title)
  }
  const franchiseKeys = computeFranchiseKeys(seriesTagsMap, titleMap)
  for (const s of store.series.values()) {
    if (s.franchiseKey !== null) {
      s.franchiseKey = null
      store._dirtySeries.add(s.seriesId)
    }
  }
  for (const [seriesId, franchiseKey] of franchiseKeys) {
    storeUpdateSeries(store, seriesId, { franchiseKey })
  }
  const byFranchise = new Map()
  for (const s of store.series.values()) {
    if (!s.franchiseKey) continue
    if (!byFranchise.has(s.franchiseKey)) byFranchise.set(s.franchiseKey, [])
    byFranchise.get(s.franchiseKey).push(s)
  }
  for (const members of byFranchise.values()) {
    for (const s of members) {
      s.relatedSeries = members
        .filter((m) => m.seriesId !== s.seriesId && m.isAvailable)
        .map((m) => ({ seriesId: m.seriesId, title: m.title, thumbnailUrl: m.thumbnailUrl }))
      store._dirtySeries.add(s.seriesId)
    }
  }
  logger.info('fetch', '[JS] E4 franchise keys done', { count: franchiseKeys.size })

  storeSyncTimestamps(store)
  storeSyncThumbs(store)
  logger.info('fetch', '[JS] E6 thumbnails synced')

  applyIsAvailableGrace(store)

  const guard = detectShrinkFromStore(store, DATA_DIR)
  if (guard.shrink) {
    logger.error('fetch', '[JS] REGRESSION GUARD: full-js would shrink -> skip export', guard)
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'meta.json') + '.tmp', JSON.stringify(store.meta), 'utf-8')
    renameSync(join(stateDir, 'meta.json') + '.tmp', join(stateDir, 'meta.json'))
    logger.info('fetch', '[JS] all done (guarded)', { now })
    return
  }

  // detectShrink 通過後に list-index.json を書込（ガード前に書くと異常時に部分前進）
  mkdirSync(stateDir, { recursive: true })
  if (listIndexArr.length > 0) {
    const listIndexPath = join(stateDir, 'list-index.json')
    writeFileSync(listIndexPath + '.tmp', JSON.stringify(listIndexArr), 'utf-8')
    renameSync(listIndexPath + '.tmp', listIndexPath)
    logger.info('fetch', '[JS] B5 list-index.json saved', { count: listIndexArr.length })
  } else {
    logger.warn(
      'fetch',
      '[JS] B5 list-index.json: empty (list.json fetch failed?) -> skip overwrite',
      {}
    )
  }

  logger.info('fetch', '[JS] phase F+G: project all')
  await writeBackStore(store, DATA_DIR, { now })
  await projectAll(store, DATA_DIR, now)

  writeFileSync(join(DATA_DIR, '.deploy-needed'), 'daily\n')
  logger.info('fetch', '[JS] all done', { now, ep0: guard.ep0 })
}

async function runHourlyJS() {
  mkdirSync(DATA_DIR, { recursive: true })
  const now = new Date().toISOString()
  const stateDir = join(DATA_DIR, 'state')

  logger.info('fetch', '[JS] phase D: RSS (hourly)')
  const { store, contentToSeries } = await loadPartialStore(DATA_DIR, [])

  if (contentToSeries.size === 0) {
    logger.warn('fetch', '[JS] hourly: no series-index (first run?) -> skip', {})
    return
  }

  const lastGuid = store.meta.rssLastGuid ?? null
  const { items: newRssItems, newLastGuid } = await fetchRssMultiPage(lastGuid, 5)

  if (newRssItems.length === 0) {
    logger.info('fetch', '[JS] hourly: RSS no new items -> exit', {})
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'meta.json') + '.tmp', JSON.stringify(store.meta), 'utf-8')
    renameSync(join(stateDir, 'meta.json') + '.tmp', join(stateDir, 'meta.json'))
    return
  }

  const rssRows = newRssItems
    .map((item) => {
      const watchId = extractWatchId(item.link)
      if (!watchId) return null
      return {
        watchId,
        guid: item.guid ?? null,
        pubDate: item.pubDate ?? null,
        title: item.title ?? null,
        titleNorm: null,
        link: item.link ?? null,
        description: item.description ?? null,
        thumbnailUrl: item.thumbnailUrl ?? null,
      }
    })
    .filter(Boolean)

  if (rssRows.length > 0) {
    storeUpsertRss(store, rssRows)
    logger.info('fetch', '[JS] hourly: new RSS items upserted', { count: rssRows.length })
  }
  if (newLastGuid) storeUpdateMeta(store, { rssLastGuid: newLastGuid })

  // list.json を毎時直接取得（state/list-index.json キャッシュに依存しない）
  let listIndexByTitle = new Map()
  try {
    const listJson = await fetchListJson()
    const { byTitle } = buildListIndex(listJson)
    listIndexByTitle = byTitle
    logger.info('fetch', '[JS] hourly D2: list.json loaded', { count: listIndexByTitle.size })
  } catch (err) {
    logger.warn('fetch', '[JS] hourly D2: list.json fetch failed, skip resolve', {
      err: err.message,
    })
  }

  const toPend = new Map()
  for (const r of store.rss.values()) {
    if (r.resolutionStatus === 'pending') toPend.set(r.watchId, r)
  }

  const resolvedSeriesIds = new Set()
  const resolvedSeriesTitles = new Map()
  logger.info('fetch', '[JS] hourly D2: list-index resolve', { candidates: toPend.size })

  // D3 の loadPartialStore が store.episodes を disk から上書きするため、
  // RSS description は D3 完了後に適用する（D2 時点で書くと消される）
  const rssDescriptions = new Map()

  for (const [watchId, rssEntry] of toPend) {
    const title = rssEntry.title ?? ''
    const seriesId = resolveByTitle(title, listIndexByTitle)

    if (seriesId) {
      const resolvedCid = contentIdFromThumbnail(rssEntry.thumbnailUrl ?? null)
      if (resolvedCid) {
        storeUpdateRssResolution(store, watchId, resolvedCid, 'resolved')
        // RSS description を退避（D3 完了後に long-wins で適用）
        if (rssEntry.description) {
          rssDescriptions.set(resolvedCid, rssEntry.description)
        }
      }
      resolvedSeriesIds.add(seriesId)
      if (!resolvedSeriesTitles.has(seriesId)) resolvedSeriesTitles.set(seriesId, '')
    } else if (listIndexByTitle.size > 0) {
      // list-index が空の場合は仮シリーズを作らず pending のまま据え置く（日次で正規解決）
      const sid = registerProvisionalSeries(store, watchId, rssEntry)
      if (sid != null) resolvedSeriesIds.add(sid)
    }
  }

  logger.info('fetch', '[JS] hourly D2: resolve done', { resolved: resolvedSeriesIds.size })

  const preD3Index = new Set(contentToSeries.keys())

  let insertedEpisodes = 0
  const realSeriesIds = [...resolvedSeriesIds].filter((sid) => sid > 0)
  if (realSeriesIds.length > 0) {
    logger.info('fetch', '[JS] hourly D3: nvapi seed', { series: realSeriesIds.length })

    const { store: seriesStore } = await loadPartialStore(DATA_DIR, realSeriesIds)
    for (const [k, v] of seriesStore.series) store.series.set(k, v)
    for (const [k, v] of seriesStore.episodes) store.episodes.set(k, v)

    for (const [seriesId] of resolvedSeriesTitles) {
      if (!store.series.has(seriesId)) {
        storeUpsertSeries(store, [{ seriesId, title: '', isAvailable: true }])
      }
    }

    for (const seriesId of realSeriesIds) {
      let data
      try {
        data = await fetchSeriesData(seriesId)
      } catch (err) {
        logger.warn('fetch', '[JS] hourly D3: nvapi failed', { seriesId, err: err.message })
        continue
      }
      if (!isBranchSeries(data?.detail)) {
        logger.warn('fetch', '[JS] hourly D3: non-branch series skipped', { seriesId })
        store.series.delete(seriesId)
        continue
      }
      const seriesTitle = data?.detail?.title ?? ''
      if (seriesTitle && store.series.has(seriesId)) {
        const s = store.series.get(seriesId)
        if (!s.title) {
          s.title = seriesTitle
          store._dirtySeries.add(seriesId)
        }
      }
      const eps = mapNvapiEpisodes(seriesId, data?.items ?? [])
      for (const ep of eps) {
        if (!preD3Index.has(ep.contentId)) insertedEpisodes++
      }
      storeUpsertEps(store, eps)
      store._dirtySeries.add(seriesId)
    }
    logger.info('fetch', '[JS] hourly D3: done', {
      insertedEpisodes,
      series: realSeriesIds.length,
    })
  }

  // D3 完了後: RSS description（HTML 700+字）を long-wins で適用（snapshot/nvapi の 50字に勝つ）
  if (rssDescriptions.size > 0) {
    const descUpdates = [...rssDescriptions.entries()].map(([contentId, description]) => ({
      contentId,
      description,
    }))
    storeUpsertEps(store, descUpdates)
    logger.info('fetch', '[JS] hourly D4: RSS description applied', { count: descUpdates.length })
  }

  _trimRss(store, 200)

  if (store._dirtySeries.size > 0) {
    storeSyncThumbs(store)
    storeSyncTimestamps(store)
    await writeSeriesFiles(store, DATA_DIR, [...store._dirtySeries])

    const idxPath = join(stateDir, 'series-index.json')
    let existingIdx = {}
    try {
      existingIdx = JSON.parse(readFileSync(idxPath, 'utf-8'))
    } catch {
      /* first run */
    }
    for (const ep of store.episodes.values()) {
      if (ep.seriesId != null) existingIdx[ep.contentId] = ep.seriesId
    }
    writeFileSync(idxPath + '.tmp', JSON.stringify(existingIdx), 'utf-8')
    renameSync(idxPath + '.tmp', idxPath)
  }

  // 新規/仮シリーズを works.json へ即時反映（日次を待たずにビューアに表示）
  if (resolvedSeriesIds.size > 0) {
    await exportWorksPartial(store, resolvedSeriesIds, DATA_DIR, now)
    logger.info('fetch', '[JS] hourly: works.json patched', { count: resolvedSeriesIds.size })
  }

  await exportNewStore(store, DATA_DIR, now)

  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'meta.json') + '.tmp', JSON.stringify(store.meta), 'utf-8')
  renameSync(join(stateDir, 'meta.json') + '.tmp', join(stateDir, 'meta.json'))
  const rssData = { lastGuid: store.meta.rssLastGuid, items: [...store.rss.values()] }
  writeFileSync(join(stateDir, 'rss.json') + '.tmp', JSON.stringify(rssData), 'utf-8')
  renameSync(join(stateDir, 'rss.json') + '.tmp', join(stateDir, 'rss.json'))

  const hasProvisional = [...resolvedSeriesIds].some((sid) => sid < 0)
  if (insertedEpisodes > 0 || hasProvisional) {
    writeFileSync(join(DATA_DIR, '.deploy-needed'), `${insertedEpisodes}\n`)
  }
  logger.info('fetch', '[JS] hourly done', { now, insertedEpisodes })
}

async function runCheckVersionJS() {
  const version = await fetchSnapshotVersion()
  logger.info('fetch', '[JS] check-version: snapshot version', { version })
}

const runner = CLI_ARGS.includes('--check-version')
  ? runCheckVersionJS()
  : CLI_MODE === 'hourly'
    ? runHourlyJS()
    : runFullJS()
runner.catch((err) => {
  logger.error('fetch', err.message, err.assertFields ?? {})
  process.exit(1)
})
