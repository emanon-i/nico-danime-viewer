/**
 * Store → 配信用 JSON プロジェクション（PH-0008 M2）
 *
 * 全ての projection 関数は Store を読むだけ（書き込まない）。
 * 出力は data/*.json（works / ranking / tags / cours / kana / new）。
 * data/series/*.json は writeBackStore が担当（project.mjs では書かない）。
 *
 * 一方向フロー: canonical JSON → Store → (writeBackStore) series JSON
 *                                          ↓ (project.mjs)
 *                                        works.json / ranking.json / tags.json / …
 */

import { readFileSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { recalcSeriesMetricsJS } from '../etl/metrics.mjs'

// ── ヘルパ ───────────────────────────────────────────────────────────────────

async function writeJson(outDir, filename, data) {
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, filename), JSON.stringify(data), 'utf-8')
}

// ── episode count / metrics の事前計算 ─────────────────────────────────────

function buildEpCountMap(store) {
  const map = new Map() // seriesId → episode count
  for (const ep of store.episodes.values()) {
    if (ep.seriesId != null) {
      map.set(ep.seriesId, (map.get(ep.seriesId) ?? 0) + 1)
    }
  }
  return map
}

// so番号の数値（"so46451859" → 46451859）。sort=new のタイブレーカー用。
function soNumOf(contentId) {
  const m = (contentId ?? '').match(/(\d+)$/)
  return m ? parseInt(m[1], 10) : -1
}

function buildEpAggMap(store) {
  // seriesId → {totalViews, commentTotal, mylistTotal, durationTotal, latestAt, latestContentId, firstAt, firstContentId, mylistFirst}
  const map = new Map()
  for (const ep of store.episodes.values()) {
    if (ep.seriesId == null) continue
    let a = map.get(ep.seriesId)
    if (!a) {
      a = {
        totalViews: 0,
        commentTotal: 0,
        mylistTotal: 0,
        durationTotal: 0,
        latestAt: null,
        latestContentId: null,
        firstAt: null,
        firstContentId: null,
        mylistFirst: 0,
      }
      map.set(ep.seriesId, a)
    }
    a.totalViews += ep.viewCounter ?? 0
    a.commentTotal += ep.commentCounter ?? 0
    a.mylistTotal += ep.mylistCounter ?? 0
    a.durationTotal += ep.lengthSeconds ?? 0
    if (ep.startTime) {
      // latestAt = MAX(startTime)。同時刻タイは so番号大（後投稿）を採用。
      if (
        !a.latestAt ||
        ep.startTime > a.latestAt ||
        (ep.startTime === a.latestAt && soNumOf(ep.contentId) > soNumOf(a.latestContentId))
      ) {
        a.latestAt = ep.startTime
        a.latestContentId = ep.contentId
      }
      // firstAt = MIN(startTime)。同時刻タイは so番号小（先投稿）を採用。
      // 毎時の exportWorksPartial と同一定義（日次/毎時パリティ）。episodeNo は 97% 欠落の
      // ため第1話判定の主キーには使わず、純粋な最古話投稿時刻で「新規シリーズ」順を決める。
      // mylistFirst は最古話のマイリス数（schema 維持・現状 web 未使用）。
      if (!a.firstAt || ep.startTime < a.firstAt) {
        a.firstAt = ep.startTime
        a.firstContentId = ep.contentId
        a.mylistFirst = ep.mylistCounter ?? 0
      } else if (ep.startTime === a.firstAt && soNumOf(ep.contentId) < soNumOf(a.firstContentId)) {
        a.firstContentId = ep.contentId
        a.mylistFirst = ep.mylistCounter ?? 0
      }
    }
  }
  return map
}

// ── works.json ──────────────────────────────────────────────────────────────

export async function exportWorks(store, outDir, lastUpdated, metricsMap) {
  const epCountMap = buildEpCountMap(store)
  const epAggMap = buildEpAggMap(store)

  const works = []
  for (const s of store.series.values()) {
    const epCount = epCountMap.get(s.seriesId) ?? 0
    const agg = epAggMap.get(s.seriesId) ?? {}
    const m = metricsMap.get(s.seriesId)
    works.push({
      seriesId: s.seriesId,
      title: s.title,
      thumbnailUrl: s.thumbnailUrl,
      descriptionFirst: s.descriptionFirst,
      tags: s.tags.map((t) => t.name),
      cours: s.cours,
      franchiseKey: s.franchiseKey,
      colKey: s.colKey,
      isAvailable: s.isAvailable,
      episodeCount: epCount,
      latestAt: agg.latestAt ?? null,
      latestContentId: agg.latestContentId ?? null,
      firstAt: agg.firstAt ?? null,
      firstContentId: agg.firstContentId ?? null,
      commentTotal: agg.commentTotal ?? 0,
      mylistTotal: agg.mylistTotal ?? 0,
      mylistFirst: agg.mylistFirst ?? 0,
      durationTotal: agg.durationTotal ?? 0,
      totalViews: m?.totalViews ?? agg.totalViews ?? 0,
      hotScore: m?.hotScore ?? 0,
      relatedSeries: s.relatedSeries ?? [],
    })
  }

  // series_id 昇順（SQLと同一の決定的順序）
  works.sort((a, b) => a.seriesId - b.seriesId)

  await writeJson(outDir, 'works.json', { lastUpdated, works })
}

// ── ranking.json ─────────────────────────────────────────────────────────────

export async function exportRanking(store, outDir, lastUpdated, metricsMap) {
  // 利用可能シリーズ × metrics
  const entries = []
  for (const s of store.series.values()) {
    if (!s.isAvailable) continue
    const m = metricsMap.get(s.seriesId)
    entries.push({
      seriesId: s.seriesId,
      title: s.title,
      thumbnailUrl: s.thumbnailUrl,
      totalViews: m?.totalViews ?? 0,
      hotScore: m?.hotScore ?? 0,
    })
  }

  const hot = [...entries]
    .sort((a, b) =>
      b.hotScore !== a.hotScore
        ? b.hotScore - a.hotScore
        : b.totalViews !== a.totalViews
          ? b.totalViews - a.totalViews
          : a.seriesId - b.seriesId
    )
    .slice(0, 200)

  const popular = [...entries]
    .sort((a, b) =>
      b.totalViews !== a.totalViews ? b.totalViews - a.totalViews : a.seriesId - b.seriesId
    )
    .slice(0, 200)

  // 炎ティア閾値: 全シリーズ hot_score の percentile（順位ベース）
  const scores = entries.map((e) => e.hotScore).sort((a, b) => a - b)
  const pct = (p) =>
    scores.length ? scores[Math.min(scores.length - 1, Math.floor(p * scores.length))] : 0
  const hotTiers = { t1: pct(0.9), t2: pct(0.95), t3: pct(0.99) }

  await writeJson(outDir, 'ranking.json', { lastUpdated, hot, popular, hotTiers })
}

// ── tags.json ─────────────────────────────────────────────────────────────────

export async function exportTags(store, outDir, lastUpdated, metricsMap) {
  // タグ → {seriesCount, isCurated}
  const tagMap = new Map() // name → {name, isCurated, seriesCount}
  for (const s of store.series.values()) {
    if (!s.isAvailable) continue
    for (const t of s.tags) {
      let entry = tagMap.get(t.name)
      if (!entry) {
        entry = { name: t.name, isCurated: false, seriesCount: 0 }
        tagMap.set(t.name, entry)
      }
      entry.seriesCount++
      if (t.isCurated) entry.isCurated = true
    }
  }

  const tags = [...tagMap.values()].sort((a, b) => b.seriesCount - a.seriesCount)

  // Hot 上位 20 / Popular 上位 20 の頻出タグ
  const hotTop20 = [...store.series.values()]
    .filter((s) => s.isAvailable && metricsMap.has(s.seriesId))
    .sort(
      (a, b) =>
        (metricsMap.get(b.seriesId)?.hotScore ?? 0) - (metricsMap.get(a.seriesId)?.hotScore ?? 0)
    )
    .slice(0, 20)

  const popularTop20 = [...store.series.values()]
    .filter((s) => s.isAvailable && metricsMap.has(s.seriesId))
    .sort(
      (a, b) =>
        (metricsMap.get(b.seriesId)?.totalViews ?? 0) -
        (metricsMap.get(a.seriesId)?.totalViews ?? 0)
    )
    .slice(0, 20)

  const topTagsFrom = (seriesList) => {
    const tc = new Map()
    for (const s of seriesList) {
      for (const t of s.tags) {
        tc.set(t.name, (tc.get(t.name) ?? 0) + 1)
      }
    }
    return [...tc.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name]) => name)
  }

  await writeJson(outDir, 'tags.json', {
    lastUpdated,
    tags: tags.map((t) => ({ name: t.name, isCurated: t.isCurated, seriesCount: t.seriesCount })),
    topHotTags: topTagsFrom(hotTop20),
    topPopularTags: topTagsFrom(popularTop20),
  })
}

// ── cours.json ───────────────────────────────────────────────────────────────

export async function exportCours(store, outDir, lastUpdated) {
  const grouped = new Map() // cours → seriesId[]
  for (const s of store.series.values()) {
    if (!s.isAvailable || !s.cours) continue
    if (!grouped.has(s.cours)) grouped.set(s.cours, [])
    grouped.get(s.cours).push(s.seriesId)
  }

  // cours DESC, seriesId ASC（SQL と同一）
  const coursEntries = [...grouped.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([cours, seriesIds]) => ({ cours, seriesIds: seriesIds.slice().sort((a, b) => a - b) }))

  await writeJson(outDir, 'cours.json', { lastUpdated, cours: coursEntries })
}

// ── kana.json ────────────────────────────────────────────────────────────────

export async function exportKana(store, outDir, lastUpdated) {
  const grouped = new Map() // colKey → seriesId[]
  for (const s of store.series.values()) {
    if (!s.colKey) continue // isAvailable 問わず colKey があれば五十音に含める
    if (!grouped.has(s.colKey)) grouped.set(s.colKey, [])
    grouped.get(s.colKey).push({ seriesId: s.seriesId, title: s.title })
  }

  // colKey ASC, title（SQL: ORDER BY col_key, title）
  const kanaEntries = [...grouped.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([colKey, items]) => ({
      colKey,
      seriesIds: items
        .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
        .map((i) => i.seriesId),
    }))

  await writeJson(outDir, 'kana.json', { lastUpdated, kana: kanaEntries })
}

// ── new.json ─────────────────────────────────────────────────────────────────

export async function exportNew(store, outDir, lastUpdated) {
  // rss を pubDate DESC で最新 100 件
  const rssItems = [...store.rss.values()]
    .sort((a, b) => {
      if (!a.pubDate && !b.pubDate) return 0
      if (!a.pubDate) return 1
      if (!b.pubDate) return -1
      return b.pubDate < a.pubDate ? -1 : b.pubDate > a.pubDate ? 1 : 0
    })
    .slice(0, 100)

  const items = rssItems.map((r) => {
    const ep = r.resolvedContentId ? store.episodes.get(r.resolvedContentId) : null
    return {
      watchId: r.watchId,
      title: r.title,
      pubDate: r.pubDate,
      resolvedContentId: r.resolvedContentId ?? null,
      resolutionStatus: r.resolutionStatus,
      thumbnailUrl: ep?.thumbnailUrl ?? null,
      episodeNo: ep?.episodeNo ?? null,
      viewCounter: ep?.viewCounter ?? null,
      commentCounter: ep?.commentCounter ?? null,
      mylistCounter: ep?.mylistCounter ?? null,
    }
  })

  await writeJson(outDir, 'new.json', { lastUpdated, items })
}

// ── works.json 差分更新（毎時用）────────────────────────────────────────────

/**
 * works.json の指定シリーズを差分 upsert する（毎時・partial store で実行）。
 * 新規シリーズ・仮シリーズを日次を待たずに即座に works.json へ反映させる。
 * hotScore/relatedSeries は既存値を引き継ぎ（日次の full 計算には干渉しない）。
 *
 * @param {import('./store.mjs').Store} store
 * @param {Set<number>} seriesIds - 追加/更新対象 seriesId（正数・負数両方可）
 * @param {string} outDir
 * @param {string} lastUpdated
 */
export async function exportWorksPartial(store, seriesIds, outDir, lastUpdated) {
  if (seriesIds.size === 0) return

  const worksPath = join(outDir, 'works.json')
  let existing = { lastUpdated, works: [] }
  try {
    existing = JSON.parse(readFileSync(worksPath, 'utf-8'))
  } catch {
    /* first run or missing */
  }

  const worksMap = new Map(existing.works.map((w) => [w.seriesId, w]))

  // 対象シリーズのエピソード集計（partial store なのでこのシリーズ分だけ存在）
  const epAgg = new Map()
  for (const ep of store.episodes.values()) {
    const sid = ep.seriesId
    if (sid == null || !seriesIds.has(sid)) continue
    let a = epAgg.get(sid)
    if (!a) {
      a = {
        count: 0,
        totalViews: 0,
        commentTotal: 0,
        mylistTotal: 0,
        durationTotal: 0,
        latestAt: null,
        latestContentId: null,
        firstAt: null,
        firstContentId: null,
      }
      epAgg.set(sid, a)
    }
    a.count++
    a.totalViews += ep.viewCounter ?? 0
    a.commentTotal += ep.commentCounter ?? 0
    a.mylistTotal += ep.mylistCounter ?? 0
    a.durationTotal += ep.lengthSeconds ?? 0
    if (ep.startTime) {
      if (
        !a.latestAt ||
        ep.startTime > a.latestAt ||
        (ep.startTime === a.latestAt && soNumOf(ep.contentId) > soNumOf(a.latestContentId))
      ) {
        a.latestAt = ep.startTime
        a.latestContentId = ep.contentId
      }
      if (!a.firstAt || ep.startTime < a.firstAt) {
        a.firstAt = ep.startTime
        a.firstContentId = ep.contentId
      } else if (ep.startTime === a.firstAt && soNumOf(ep.contentId) < soNumOf(a.firstContentId)) {
        a.firstContentId = ep.contentId
      }
    }
  }

  for (const sid of seriesIds) {
    const s = store.series.get(sid)
    if (!s) continue
    const agg = epAgg.get(sid) ?? {}
    const prev = worksMap.get(sid)
    worksMap.set(sid, {
      seriesId: s.seriesId,
      title: s.title,
      thumbnailUrl: s.thumbnailUrl,
      descriptionFirst: s.descriptionFirst,
      tags: s.tags.map((t) => t.name),
      cours: s.cours,
      franchiseKey: s.franchiseKey,
      colKey: s.colKey,
      isAvailable: s.isAvailable,
      episodeCount: agg.count ?? 0,
      latestAt: agg.latestAt ?? null,
      latestContentId: agg.latestContentId ?? null,
      firstAt: agg.firstAt ?? null,
      firstContentId: agg.firstContentId ?? null,
      commentTotal: agg.commentTotal ?? 0,
      mylistTotal: agg.mylistTotal ?? 0,
      mylistFirst: prev?.mylistFirst ?? 0,
      durationTotal: agg.durationTotal ?? 0,
      totalViews: agg.totalViews ?? 0,
      hotScore: prev?.hotScore ?? 0,
      relatedSeries: s.relatedSeries ?? prev?.relatedSeries ?? [],
    })
  }

  const works = [...worksMap.values()].sort((a, b) => a.seriesId - b.seriesId)
  await writeJson(outDir, 'works.json', { lastUpdated, works })
}

// ── 全 projection を実行 ─────────────────────────────────────────────────────

/**
 * Store から全配信 JSON を生成する（series/*.json は writeBackStore 側で生成）。
 * @param {import('./store.mjs').Store} store
 * @param {string} outDir - data/ ディレクトリ
 * @param {string} lastUpdated - ISO8601
 * @param {string} now - metrics 計算の現在時刻（ISO8601）。省略時 = lastUpdated
 */
export async function projectAll(store, outDir, lastUpdated, now) {
  const nowTs = now ?? lastUpdated
  const metricsMap = recalcSeriesMetricsJS(store, nowTs)
  await Promise.all([
    exportWorks(store, outDir, lastUpdated, metricsMap),
    exportRanking(store, outDir, lastUpdated, metricsMap),
    exportTags(store, outDir, lastUpdated, metricsMap),
    exportCours(store, outDir, lastUpdated),
    exportKana(store, outDir, lastUpdated),
    exportNew(store, outDir, lastUpdated),
  ])
}
