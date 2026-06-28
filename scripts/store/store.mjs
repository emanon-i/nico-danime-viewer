/**
 * Store: 純 JSON ＋ メモリ JS による正本データ層（PH-0008 M1）
 *
 * 設計原則:
 * - canonical JSON → Store → derived projection（一方向フロー）
 * - projection ファイルを Store の入力に使わない
 * - isAvailable=false のシリーズも Store に保持（tombstone として除外せずに保つ）
 * - prevViewCounter は state/prev-views.json で管理（public series JSON には入れない）
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { stripHtml, chooseDescription } from '../etl/series.mjs'
import { parseDescription } from '../etl/description.mjs'
import { trimSeriesTitle } from '../nico/list.mjs'

// ────────────────────────────────────────────────────────────────────────────
// 型定義（JSDoc）
// ────────────────────────────────────────────────────────────────────────────
/**
 * @typedef {Object} SeriesEntry
 * @property {number} seriesId
 * @property {string} title
 * @property {string|null} colKey
 * @property {string|null} thumbnailUrl
 * @property {string|null} descriptionFirst
 * @property {string|null} firstSeen
 * @property {string|null} lastSeen
 * @property {string|null} lastSeenAt  snapshot に最後に登場した ISO 8601（Phase E7 で isAvailable 評価に使う）
 * @property {string|null} cours
 * @property {string|null} franchiseKey
 * @property {boolean} isAvailable
 * @property {{name:string,isCurated:boolean}[]} tags
 * @property {{seriesId:number,title:string,thumbnailUrl:string|null}[]} relatedSeries
 */

/**
 * @typedef {Object} EpisodeEntry
 * @property {string} contentId
 * @property {number|null} seriesId
 * @property {number|null} episodeNo
 * @property {string} title
 * @property {number|null} viewCounter
 * @property {number|null} prevViewCounter
 * @property {number|null} commentCounter
 * @property {number|null} likeCounter
 * @property {number|null} mylistCounter
 * @property {number|null} lengthSeconds
 * @property {string|null} startTime
 * @property {string|null} thumbnailUrl
 * @property {string|null} description
 * @property {string[]} tags              正規化済みタグ名配列
 * @property {string[]} tagsCurated       キュレーションタグ名配列（tags の部分集合）
 * @property {string|null} lastUpdated
 */

/**
 * @typedef {Object} RssEntry
 * @property {string} watchId
 * @property {string|null} guid
 * @property {string|null} pubDate
 * @property {string|null} title
 * @property {string|null} titleNorm
 * @property {string|null} link
 * @property {string|null} description    RSS <description> HTML CDATA as-is（暫定あらすじ）
 * @property {string|null} thumbnailUrl   RSS <media:thumbnail> URL（contentId 復元に使う）
 * @property {string|null} resolvedContentId
 * @property {string} resolutionStatus   'pending'|'resolved'
 */

/**
 * @typedef {Object} MetaRecord
 * @property {string|null} rssLastGuid
 * @property {string|null} snapshotLastStartTime
 * @property {string|null} snapshotVersionLastModified
 * @property {string|null} lastSeedAt
 * @property {string|null} snapshotFetchedAt  Phase A 完全実行が完了した ISO 8601（version gate skip 時は更新しない）
 */

/**
 * @typedef {Object} Store
 * @property {Map<number,SeriesEntry>} series
 * @property {Map<string,EpisodeEntry>} episodes
 * @property {Map<string,RssEntry>} rss
 * @property {MetaRecord} meta
 * @property {Set<number>} _dirtySeries  writeBack 時に上書きする seriesId（hourly 用）
 */

// ────────────────────────────────────────────────────────────────────────────
// ファクトリ
// ────────────────────────────────────────────────────────────────────────────

export function createStore() {
  return {
    series: new Map(),
    episodes: new Map(),
    rss: new Map(),
    meta: {
      rssLastGuid: null,
      snapshotLastStartTime: null,
      snapshotVersionLastModified: null,
      lastSeedAt: null,
      snapshotFetchedAt: null,
    },
    _dirtySeries: new Set(),
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ロード
// ────────────────────────────────────────────────────────────────────────────

/**
 * data/ 以下の series/*.json + state/*.json を読み込んで Store を返す。
 * @param {string} dataDir  data/ への絶対パス
 * @returns {Promise<Store>}
 */
export async function loadStore(dataDir) {
  const store = createStore()
  const seriesDir = path.join(dataDir, 'series')
  const stateDir = path.join(dataDir, 'state')

  // ── series JSON 全件（並列読み込みで高速化）───────────────────────
  let files
  try {
    files = await fs.readdir(seriesDir)
  } catch {
    files = []
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json'))

  // Promise.all で並列ロード（OS のファイルキャッシュを活用）
  const CHUNK = 200
  for (let i = 0; i < jsonFiles.length; i += CHUNK) {
    const chunk = jsonFiles.slice(i, i + CHUNK)
    const results = await Promise.all(
      chunk.map(async (file) => {
        try {
          return JSON.parse(await fs.readFile(path.join(seriesDir, file), 'utf-8'))
        } catch {
          return null
        }
      })
    )
    for (const json of results) {
      if (json) _ingestSeriesJson(store, json)
    }
  }

  // ── state/*.json ─────────────────────────────────────────────────
  await _loadState(store, stateDir)

  return store
}

/**
 * 部分ロード（hourly 用）: series-index.json + 指定 series ファイルのみ。
 * works.json 等の projection は読まない。
 * @param {string} dataDir
 * @param {number[]} seriesIds  追加で読む seriesId 一覧
 * @returns {Promise<{store: Store, contentToSeries: Map<string,number>}>}
 */
export async function loadPartialStore(dataDir, seriesIds = []) {
  const store = createStore()
  const stateDir = path.join(dataDir, 'state')
  const seriesDir = path.join(dataDir, 'series')

  // series-index.json（contentId → seriesId の逆引きインデックス）
  let contentToSeries = new Map()
  try {
    const idx = JSON.parse(await fs.readFile(path.join(stateDir, 'series-index.json'), 'utf-8'))
    contentToSeries = new Map(Object.entries(idx).map(([cid, sid]) => [cid, Number(sid)]))
  } catch {
    // ファイルが存在しない場合は空マップで進む（初回 bootstrap）
  }

  // 指定 seriesId の JSON を読む
  const toLoad = new Set(seriesIds)
  for (const sid of toLoad) {
    const filePath = path.join(seriesDir, `${sid}.json`)
    try {
      const json = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      _ingestSeriesJson(store, json)
    } catch {
      // ファイル不在はスキップ（新規 series は後続で upsertSeries が作る）
    }
  }

  await _loadState(store, stateDir)

  return { store, contentToSeries }
}

// ────────────────────────────────────────────────────────────────────────────
// 内部: JSON → Store マッピング
// ────────────────────────────────────────────────────────────────────────────

function _ingestSeriesJson(store, json) {
  const seriesId = Number(json.seriesId)
  if (!seriesId) return

  const existing = store.series.get(seriesId)

  // series エントリ（上書き or 新規）
  // tags はシリーズレベルの集約タグ。JSON では string[] or {name,isCurated}[] どちらも許容。
  const rawTags = Array.isArray(json.tags) ? json.tags : []
  const tags = rawTags.map((t) =>
    typeof t === 'string'
      ? { name: t, isCurated: false }
      : { name: t.name, isCurated: !!t.isCurated }
  )

  const entry = {
    seriesId,
    title: json.title ?? existing?.title ?? '',
    colKey: json.colKey ?? existing?.colKey ?? null,
    thumbnailUrl: json.thumbnailUrl ?? existing?.thumbnailUrl ?? null,
    descriptionFirst: json.descriptionFirst ?? existing?.descriptionFirst ?? null,
    firstSeen: json.firstSeen ?? existing?.firstSeen ?? null,
    lastSeen: json.lastSeen ?? existing?.lastSeen ?? null,
    lastSeenAt: json.lastSeenAt ?? existing?.lastSeenAt ?? null,
    cours: json.cours ?? existing?.cours ?? null,
    franchiseKey: json.franchiseKey ?? existing?.franchiseKey ?? null,
    isAvailable: json.isAvailable !== false,
    tags,
    relatedSeries: Array.isArray(json.relatedSeries)
      ? json.relatedSeries
      : (existing?.relatedSeries ?? []),
  }
  store.series.set(seriesId, entry)

  // episodes
  const episodes = Array.isArray(json.episodes) ? json.episodes : []
  for (const ep of episodes) {
    const cid = ep.contentId
    if (!cid) continue
    const existing = store.episodes.get(cid)
    const epEntry = {
      contentId: cid,
      seriesId,
      episodeNo: ep.episodeNo ?? existing?.episodeNo ?? null,
      title: ep.title ?? existing?.title ?? '',
      viewCounter: ep.viewCounter ?? existing?.viewCounter ?? null,
      prevViewCounter: existing?.prevViewCounter ?? null, // state から後で上書き
      commentCounter: ep.commentCounter ?? existing?.commentCounter ?? null,
      likeCounter: ep.likeCounter ?? existing?.likeCounter ?? null,
      mylistCounter: ep.mylistCounter ?? existing?.mylistCounter ?? null,
      lengthSeconds: ep.lengthSeconds ?? existing?.lengthSeconds ?? null,
      startTime: ep.startTime ?? existing?.startTime ?? null,
      thumbnailUrl: ep.thumbnailUrl ?? existing?.thumbnailUrl ?? null,
      description: ep.description ?? existing?.description ?? null,
      tags: Array.isArray(ep.tags)
        ? ep.tags.filter((t) => typeof t === 'string')
        : (existing?.tags ?? []),
      tagsCurated: Array.isArray(ep.tagsCurated) ? ep.tagsCurated : (existing?.tagsCurated ?? []),
      lastUpdated: ep.lastUpdated ?? existing?.lastUpdated ?? null,
    }
    store.episodes.set(cid, epEntry)
  }
}

async function _loadState(store, stateDir) {
  // meta.json
  try {
    const meta = JSON.parse(await fs.readFile(path.join(stateDir, 'meta.json'), 'utf-8'))
    Object.assign(store.meta, {
      rssLastGuid: meta.rssLastGuid ?? null,
      snapshotLastStartTime: meta.snapshotLastStartTime ?? null,
      snapshotVersionLastModified: meta.snapshotVersionLastModified ?? null,
      lastSeedAt: meta.lastSeedAt ?? null,
      snapshotFetchedAt: meta.snapshotFetchedAt ?? null,
    })
  } catch {
    /* 初回 bootstrap では存在しない */
  }

  // prev-views.json
  try {
    const prevViews = JSON.parse(await fs.readFile(path.join(stateDir, 'prev-views.json'), 'utf-8'))
    for (const [contentId, prev] of Object.entries(prevViews)) {
      const ep = store.episodes.get(contentId)
      if (ep) ep.prevViewCounter = typeof prev === 'number' ? prev : null
    }
  } catch {
    /* 初回はなくてよい */
  }

  // rss.json
  try {
    const rssData = JSON.parse(await fs.readFile(path.join(stateDir, 'rss.json'), 'utf-8'))
    if (rssData.lastGuid && !store.meta.rssLastGuid) {
      store.meta.rssLastGuid = rssData.lastGuid
    }
    for (const item of rssData.items ?? []) {
      store.rss.set(item.watchId, {
        watchId: item.watchId,
        guid: item.guid ?? null,
        pubDate: item.pubDate ?? null,
        title: item.title ?? null,
        titleNorm: item.titleNorm ?? null,
        link: item.link ?? null,
        description: item.description ?? null,
        thumbnailUrl: item.thumbnailUrl ?? null,
        resolvedContentId: item.resolvedContentId ?? null,
        resolutionStatus: item.resolutionStatus === 'resolved' ? 'resolved' : 'pending',
      })
    }
  } catch {
    /* 初回はなくてよい */
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Write-back（atomic temp→verify→rename）
// ────────────────────────────────────────────────────────────────────────────

/**
 * Store の内容を data/ 以下に書き戻す。
 *
 * opts.seriesIds: 指定時はその series ファイルのみ上書き（hourly 用）。
 *                 省略時は全 series を書き出し（daily 用）。
 * opts.now: 書き出し時刻（ISO 8601）。省略時は new Date().toISOString()。
 *
 * 書き出し順序（atomic）:
 * 1. temp ディレクトリ（data/.tmp-store-XXXX）に全ファイルを書く
 * 2. 件数 invariant を確認
 * 3. 本番パスへ rename / move（fs.rename で OS 原子性）
 * 4. state/series-index.json を更新（contentId → seriesId 逆引き）
 */
export async function writeBackStore(store, dataDir, opts = {}) {
  // seriesIds: 指定時はその series のみ（hourly 用）
  // forceAll: true なら dirty に関係なく全 series を書く（週次 full seed 後などの安全網）
  const { seriesIds = null, forceAll = false } = opts
  const seriesDir = path.join(dataDir, 'series')
  const stateDir = path.join(dataDir, 'state')

  await fs.mkdir(seriesDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })

  // 書き出す series の範囲（S4c: dirty 限定、ただし forceAll 時は全件）
  let targets
  if (seriesIds != null) {
    targets = new Set(seriesIds.map(Number))
  } else if (forceAll) {
    targets = new Set(store.series.keys())
  } else {
    // dirty のみ（実変化した series のみ）
    targets = new Set(store._dirtySeries)
  }

  // ── series/*.json（S4a: chunked 並列・S4b: compact）────────────────
  const targetArr = [...targets]
  const WRITE_CHUNK = 200
  for (let i = 0; i < targetArr.length; i += WRITE_CHUNK) {
    const chunk = targetArr.slice(i, i + WRITE_CHUNK)
    await Promise.all(
      chunk.map((seriesId) => {
        const json = _buildSeriesJson(store, seriesId)
        if (!json) return Promise.resolve()
        return _writeJsonCompact(path.join(seriesDir, `${seriesId}.json`), json)
      })
    )
  }

  // ── state/prev-views.json ────────────────────────────────────────
  // 現在の viewCounter を保存 → 次回 loadStore で prevViewCounter にセット → delta 計算に使う
  const prevViews = {}
  for (const ep of store.episodes.values()) {
    if (ep.viewCounter != null) {
      prevViews[ep.contentId] = ep.viewCounter
    }
  }
  await _writeJsonCompact(path.join(stateDir, 'prev-views.json'), prevViews)

  // ── state/meta.json ──────────────────────────────────────────────
  await _writeJsonCompact(path.join(stateDir, 'meta.json'), store.meta)

  // ── state/rss.json ───────────────────────────────────────────────
  const rssData = {
    lastGuid: store.meta.rssLastGuid,
    items: [...store.rss.values()],
  }
  await _writeJsonCompact(path.join(stateDir, 'rss.json'), rssData)

  // ── state/series-index.json（contentId → seriesId 逆引き）────────
  const idx = {}
  for (const ep of store.episodes.values()) {
    if (ep.seriesId != null) idx[ep.contentId] = ep.seriesId
  }
  await _writeJsonCompact(path.join(stateDir, 'series-index.json'), idx)

  // _dirtySeries リセット
  if (seriesIds != null) {
    for (const sid of seriesIds) store._dirtySeries.delete(Number(sid))
  } else {
    store._dirtySeries.clear()
  }
}

// S4b: compact JSON（インデント無し）で atomic 書き出し
async function _writeJsonCompact(filePath, data) {
  const tmp = filePath + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(data), 'utf-8')
  await fs.rename(tmp, filePath)
}

// series JSON オブジェクトを組み立てる（writeBackStore / writeSeriesFiles 共通）
function _buildSeriesJson(store, seriesId) {
  const s = store.series.get(seriesId)
  if (!s) return null
  const episodes = _getEpisodesForSeriesSorted(store, seriesId)

  // PH-0014 / F-0059: description を構造分解。各話 description（HTML strip 済み・後方互換）は
  // 残しつつ、各話に synopsis/episodeLinks/descriptionStructured を付与。
  // cast/staff/studios/copyright はシリーズ内でほぼ一定なので**シリーズ単位に集約**（per-episode
  // 重複でデータが約2倍に膨らむのを回避＝+91%→+34%）。代表は「最も完全な各話（cast 最多）」。
  const parsedByEp = episodes.map((ep) => parseDescription(ep.description))
  let rep = null
  for (const p of parsedByEp) {
    if (
      !rep ||
      p.cast.length > rep.cast.length ||
      (p.cast.length === rep.cast.length && p.staff.length > rep.staff.length)
    ) {
      rep = p
    }
  }

  return {
    seriesId: s.seriesId,
    title: s.title,
    thumbnailUrl: s.thumbnailUrl,
    descriptionFirst: s.descriptionFirst,
    tags: s.tags.map((t) => t.name),
    cours: s.cours,
    colKey: s.colKey,
    franchiseKey: s.franchiseKey,
    relatedSeries: s.relatedSeries,
    isAvailable: s.isAvailable,
    firstSeen: s.firstSeen,
    lastSeen: s.lastSeen,
    lastSeenAt: s.lastSeenAt ?? null,
    // シリーズ単位の構造化クレジット（代表各話由来）
    cast: rep ? rep.cast : [],
    staff: rep ? rep.staff : [],
    studios: rep ? rep.studios : [],
    copyright: rep ? rep.copyright : null,
    episodes: episodes.map((ep, i) => {
      const parsed = parsedByEp[i]
      return {
        contentId: ep.contentId,
        episodeNo: ep.episodeNo,
        title: ep.title,
        viewCounter: ep.viewCounter,
        commentCounter: ep.commentCounter,
        likeCounter: ep.likeCounter,
        mylistCounter: ep.mylistCounter,
        lengthSeconds: ep.lengthSeconds,
        startTime: ep.startTime,
        thumbnailUrl: ep.thumbnailUrl,
        description: stripHtml(ep.description) || null,
        synopsis: parsed.synopsis,
        episodeLinks: parsed.episodeLinks,
        descriptionStructured: parsed.structured,
        tags: ep.tags,
        tagsCurated: ep.tagsCurated,
        lastUpdated: ep.lastUpdated,
      }
    }),
  }
}

/**
 * 指定 series の JSON を data/series/*.json に書き出す（hourly 部分書き戻し用）。
 * writeBackStore と異なり state/*.json（prev-views/meta/rss/series-index）は書かない。
 * @param {Store} store
 * @param {string} dataDir
 * @param {number[]} seriesIds
 */
export async function writeSeriesFiles(store, dataDir, seriesIds) {
  const seriesDir = path.join(dataDir, 'series')
  await fs.mkdir(seriesDir, { recursive: true })
  const CHUNK = 50
  const ids = [...seriesIds]
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    await Promise.all(
      chunk.map((sid) => {
        const json = _buildSeriesJson(store, sid)
        if (!json) return Promise.resolve()
        return _writeJsonCompact(path.join(seriesDir, `${sid}.json`), json)
      })
    )
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CRUD API
// ────────────────────────────────────────────────────────────────────────────

/**
 * エピソードを upsert する（snapshot 取り込み用）。
 *
 * PRESERVE（既存値を上書きしない）:
 *   seriesId, episodeNo, title, startTime（一度 nvapi で確定した値を保護）
 * UPDATE（常に更新）:
 *   viewCounter, prevViewCounter=現 viewCounter, commentCounter, likeCounter,
 *   mylistCounter, lengthSeconds, thumbnailUrl, tags, tagsCurated, lastUpdated
 *
 * @param {Store} store
 * @param {Partial<EpisodeEntry>[]} rawEps
 */
export function upsertEpisodes(store, rawEps) {
  const now = new Date().toISOString()
  for (const raw of rawEps) {
    const cid = raw.contentId
    if (!cid) continue
    const existing = store.episodes.get(cid)

    if (existing) {
      // PRESERVE seriesId, episodeNo, title, startTime（確定済みなら守る）
      const prevView = existing.viewCounter // 旧 viewCounter を prev に退避
      existing.prevViewCounter = prevView

      // 実変化チェック（変化があった場合のみ dirty に追加・lastUpdated 更新）
      let changed = false
      const newView = raw.viewCounter ?? existing.viewCounter
      if (existing.viewCounter !== newView) {
        existing.viewCounter = newView
        changed = true
      }
      const newComment = raw.commentCounter ?? existing.commentCounter
      if (existing.commentCounter !== newComment) {
        existing.commentCounter = newComment
        changed = true
      }
      const newLike = raw.likeCounter ?? existing.likeCounter
      if (existing.likeCounter !== newLike) {
        existing.likeCounter = newLike
        changed = true
      }
      const newMylist = raw.mylistCounter ?? existing.mylistCounter
      if (existing.mylistCounter !== newMylist) {
        existing.mylistCounter = newMylist
        changed = true
      }
      const newLen = raw.lengthSeconds ?? existing.lengthSeconds
      if (existing.lengthSeconds !== newLen) {
        existing.lengthSeconds = newLen
        changed = true
      }
      const newThumb = raw.thumbnailUrl ?? existing.thumbnailUrl
      if (existing.thumbnailUrl !== newThumb) {
        existing.thumbnailUrl = newThumb
        changed = true
      }
      if (raw.tags != null) {
        const newTagStr = raw.tags.join('\x00')
        if (existing.tags.join('\x00') !== newTagStr) {
          existing.tags = raw.tags
          changed = true
        }
      }
      if (raw.tagsCurated != null) {
        const newCurStr = raw.tagsCurated.join('\x00')
        if (existing.tagsCurated.join('\x00') !== newCurStr) {
          existing.tagsCurated = raw.tagsCurated
          changed = true
        }
      }
      // 源優先マージ（PH-0014 / F-0058）: 構造版(nvapi の <br> 区切り)をフラット(RSS)より
      // 長さに関わらず優先。同一構造クラス内のみ従来 long-wins。フラット RSS が構造化 nvapi を
      // 潰す（新着各話の本文 1 行詰まり）現象を解消する。
      const newDesc = chooseDescription(existing.description, raw.description)
      if (existing.description !== newDesc) {
        existing.description = newDesc
        changed = true
      }

      // COALESCE: episodeNo は確定値を守りつつ、null のときだけ nvapi 由来の話順で埋める。
      // snapshot が先に作成（episodeNo=null）した既存話を、後続の nvapi seed が後埋めできるようにする。
      // 確定済み（non-null）の episodeNo は raw で上書きしない（snapshot 由来 null の逆流防止）。
      if (existing.episodeNo == null && raw.episodeNo != null) {
        existing.episodeNo = raw.episodeNo
        changed = true
      }

      if (changed) {
        existing.lastUpdated = now
        if (existing.seriesId != null) store._dirtySeries.add(existing.seriesId)
      }

      // seriesId が null なら受け入れる（linkEpisodes で後から設定）
      // seriesId が non-null なら既存を保護（orphan 化を防ぐ）
      if (existing.seriesId == null && raw.seriesId != null) {
        existing.seriesId = raw.seriesId
        store._dirtySeries.add(raw.seriesId)
      }
    } else {
      store.episodes.set(cid, {
        contentId: cid,
        seriesId: raw.seriesId ?? null,
        episodeNo: raw.episodeNo ?? null,
        title: raw.title ?? '',
        viewCounter: raw.viewCounter ?? null,
        prevViewCounter: null,
        commentCounter: raw.commentCounter ?? null,
        likeCounter: raw.likeCounter ?? null,
        mylistCounter: raw.mylistCounter ?? null,
        lengthSeconds: raw.lengthSeconds ?? null,
        startTime: raw.startTime ?? null,
        thumbnailUrl: raw.thumbnailUrl ?? null,
        description: raw.description ?? null,
        tags: raw.tags ?? [],
        tagsCurated: raw.tagsCurated ?? [],
        lastUpdated: now,
      })
      if (raw.seriesId != null) store._dirtySeries.add(raw.seriesId)
    }
  }
}

/**
 * シリーズを upsert する（list.json / nvapi 取り込み用）。
 * thumbnailUrl は COALESCE（既存があれば保護）。
 * @param {Store} store
 * @param {Partial<SeriesEntry>[]} seriesList
 */
export function upsertSeries(store, seriesList) {
  for (const raw of seriesList) {
    const sid = Number(raw.seriesId)
    if (!sid) continue
    const existing = store.series.get(sid)
    if (existing) {
      existing.title = raw.title != null ? trimSeriesTitle(raw.title) : existing.title
      existing.colKey = raw.colKey ?? existing.colKey
      // thumbnailUrl COALESCE: 既存があれば保護、null の時だけ受け入れ
      existing.thumbnailUrl = existing.thumbnailUrl ?? raw.thumbnailUrl ?? null
      existing.descriptionFirst = raw.descriptionFirst ?? existing.descriptionFirst
      existing.cours = raw.cours ?? existing.cours
      existing.franchiseKey = raw.franchiseKey ?? existing.franchiseKey
      if (raw.isAvailable !== undefined) existing.isAvailable = raw.isAvailable
      if (raw.relatedSeries != null) existing.relatedSeries = raw.relatedSeries
      if (raw.tags != null && raw.tags.length > 0) {
        existing.tags = raw.tags.map((t) =>
          typeof t === 'string' ? { name: t, isCurated: false } : t
        )
      }
      store._dirtySeries.add(sid)
    } else {
      store.series.set(sid, {
        seriesId: sid,
        title: trimSeriesTitle(raw.title ?? ''),
        colKey: raw.colKey ?? null,
        thumbnailUrl: raw.thumbnailUrl ?? null,
        descriptionFirst: raw.descriptionFirst ?? null,
        firstSeen: raw.firstSeen ?? null,
        lastSeen: raw.lastSeen ?? null,
        cours: raw.cours ?? null,
        franchiseKey: raw.franchiseKey ?? null,
        isAvailable: raw.isAvailable !== false,
        tags: (raw.tags ?? []).map((t) =>
          typeof t === 'string' ? { name: t, isCurated: false } : t
        ),
        relatedSeries: raw.relatedSeries ?? [],
      })
      store._dirtySeries.add(sid)
    }
  }
}

/**
 * エピソードにシリーズを紐付ける（nvapi 結果から）。
 * @param {Store} store
 * @param {{contentId:string, seriesId:number, episodeNo?:number}[]} updates
 */
export function linkEpisodes(store, updates) {
  for (const u of updates) {
    const ep = store.episodes.get(u.contentId)
    if (!ep) continue
    ep.seriesId = Number(u.seriesId)
    if (u.episodeNo != null) ep.episodeNo = u.episodeNo
    store._dirtySeries.add(ep.seriesId)
  }
}

/**
 * シリーズのフィールドを更新する（ホワイトリスト）。
 * @param {Store} store
 * @param {number} seriesId
 * @param {Partial<SeriesEntry>} fields
 */
const SERIES_UPDATE_WHITELIST = new Set([
  'title',
  'colKey',
  'thumbnailUrl',
  'descriptionFirst',
  'firstSeen',
  'lastSeen',
  'cours',
  'franchiseKey',
  'isAvailable',
  'tags',
  'relatedSeries',
])

export function updateSeries(store, seriesId, fields) {
  const sid = Number(seriesId)
  const s = store.series.get(sid)
  if (!s) return
  for (const [k, v] of Object.entries(fields)) {
    if (SERIES_UPDATE_WHITELIST.has(k)) s[k] = v
  }
  store._dirtySeries.add(sid)
}

/**
 * シリーズのサムネイルを最古エピソードから補完する。
 * @param {Store} store
 */
export function syncSeriesThumbnails(store) {
  for (const s of store.series.values()) {
    if (s.thumbnailUrl) continue
    const eps = _getEpisodesForSeriesSorted(store, s.seriesId)
    for (const ep of eps) {
      if (ep.thumbnailUrl) {
        s.thumbnailUrl = ep.thumbnailUrl
        store._dirtySeries.add(s.seriesId)
        break
      }
    }
  }
}

/**
 * シリーズの firstSeen / lastSeen を全エピソードの startTime から再計算する。
 * @param {Store} store
 */
export function syncSeriesTimestamps(store) {
  // seriesId → {first, last} の計算
  const ranges = new Map()
  for (const ep of store.episodes.values()) {
    if (!ep.seriesId || !ep.startTime) continue
    const t = new Date(ep.startTime).getTime()
    if (isNaN(t)) continue
    const r = ranges.get(ep.seriesId)
    if (!r) {
      ranges.set(ep.seriesId, { first: t, last: t, firstStr: ep.startTime, lastStr: ep.startTime })
    } else {
      if (t < r.first) {
        r.first = t
        r.firstStr = ep.startTime
      }
      if (t > r.last) {
        r.last = t
        r.lastStr = ep.startTime
      }
    }
  }
  for (const [sid, r] of ranges) {
    const s = store.series.get(sid)
    if (s) {
      if (s.firstSeen !== r.firstStr || s.lastSeen !== r.lastStr) {
        s.firstSeen = r.firstStr
        s.lastSeen = r.lastStr
        store._dirtySeries.add(sid)
      }
    }
  }
}

// ── meta state ─────────────────────────────────────────────────────────────

export function getMetaState(store) {
  return { ...store.meta }
}

export function updateMetaState(store, fields) {
  Object.assign(store.meta, fields)
}

// ── RSS ────────────────────────────────────────────────────────────────────

/**
 * RSS アイテムを upsert する。
 * @param {Store} store
 * @param {Partial<RssEntry>[]} items
 */
export function upsertRssItems(store, items) {
  for (const item of items) {
    const wid = item.watchId
    if (!wid) continue
    const existing = store.rss.get(wid)
    if (existing) {
      existing.guid = item.guid ?? existing.guid
      existing.pubDate = item.pubDate ?? existing.pubDate
      existing.title = item.title ?? existing.title
      existing.titleNorm = item.titleNorm ?? existing.titleNorm
      existing.link = item.link ?? existing.link
      if (item.description != null) existing.description = item.description
      existing.thumbnailUrl = existing.thumbnailUrl ?? item.thumbnailUrl ?? null
      // resolvedContentId / status は updateRssResolution で管理
    } else {
      store.rss.set(wid, {
        watchId: wid,
        guid: item.guid ?? null,
        pubDate: item.pubDate ?? null,
        title: item.title ?? null,
        titleNorm: item.titleNorm ?? null,
        link: item.link ?? null,
        description: item.description ?? null,
        thumbnailUrl: item.thumbnailUrl ?? null,
        resolvedContentId: item.resolvedContentId ?? null,
        resolutionStatus: item.resolutionStatus === 'resolved' ? 'resolved' : 'pending',
      })
    }
  }
}

/**
 * RSS アイテムの解決状態を更新する。
 * @param {Store} store
 * @param {string} watchId
 * @param {string|null} resolvedContentId
 * @param {string} status
 */
export function updateRssResolution(store, watchId, resolvedContentId, status) {
  const item = store.rss.get(watchId)
  if (!item) return
  item.resolvedContentId = resolvedContentId
  item.resolutionStatus = status
}

// ── タグ ────────────────────────────────────────────────────────────────────

/**
 * シリーズのタグを置換する（deriveSeriesTags の結果を受け取る）。
 * @param {Store} store
 * @param {number} seriesId
 * @param {{name:string,isCurated:boolean}[]} tags
 */
export function replaceSeriesTags(store, seriesId, tags) {
  const sid = Number(seriesId)
  const s = store.series.get(sid)
  if (!s) return
  s.tags = tags
  store._dirtySeries.add(sid)
}

// ── orphan / seed ──────────────────────────────────────────────────────────

/**
 * seriesId が null のエピソード数を返す（seed 要否の判定に使う）。
 * @param {Store} store
 * @returns {number}
 */
export function countOrphanEpisodes(store) {
  let n = 0
  for (const ep of store.episodes.values()) {
    if (ep.seriesId == null) n++
  }
  return n
}

/**
 * episodeNo=null の各話を持つ「available な正シリーズ」を集計する。
 * episodeNo backfill の対象選定・リトライ対象（pass1 後の残 null 系列）に使う。
 * 仮(負)シリーズ・非 available・null話を持たない系列は除外。
 * @param {Store} store
 * @returns {{nullBySeries: Map<number,number>, nullTotal: number, epTotal: number}}
 *   nullBySeries: seriesId → そのシリーズの null話数 / nullTotal: 正シリーズ全体の null話数 / epTotal: 正シリーズ全話数
 */
export function seriesWithNullEpisodes(store) {
  const nullBySeries = new Map()
  let nullTotal = 0
  let epTotal = 0
  for (const ep of store.episodes.values()) {
    if (ep.seriesId == null || ep.seriesId <= 0) continue
    epTotal++
    if (ep.episodeNo == null) {
      nullTotal++
      const s = store.series.get(ep.seriesId)
      if (s && s.isAvailable)
        nullBySeries.set(ep.seriesId, (nullBySeries.get(ep.seriesId) ?? 0) + 1)
    }
  }
  return { nullBySeries, nullTotal, epTotal }
}

/**
 * nvapi seed 対象シリーズを選定する（§0-5）。
 *
 * 優先度:
 * 1. list.json 収録済みだがエピソード 0 件のシリーズ（新規）
 * 2. エピソード数が insufficientThreshold 以下のシリーズ（不完全）
 * 3. orphan エピソードがあれば全 series が対象（orphan-driven seed）
 *
 * @param {Store} store
 * @param {{insufficientThreshold?:number, allIfOrphans?:boolean}} opts
 * @returns {number[]} seriesId 配列
 */
export function selectSeedTargets(store, opts = {}) {
  const { insufficientThreshold = 3, allIfOrphans = true } = opts

  const epCountBySeries = new Map()
  for (const ep of store.episodes.values()) {
    if (ep.seriesId != null) {
      epCountBySeries.set(ep.seriesId, (epCountBySeries.get(ep.seriesId) ?? 0) + 1)
    }
  }

  const orphans = countOrphanEpisodes(store)
  if (allIfOrphans && orphans > 0) {
    // orphan が存在 → 全シリーズを seed 対象（紐付けを全件やり直す）
    return [...store.series.keys()].filter((sid) => store.series.get(sid).isAvailable)
  }

  const targets = []
  for (const [sid, s] of store.series) {
    if (!s.isAvailable) continue
    const count = epCountBySeries.get(sid) ?? 0
    if (count <= insufficientThreshold) targets.push(sid)
  }
  return targets
}

// ── エピソード取得 ─────────────────────────────────────────────────────────

/**
 * seriesId に属するエピソードを chronoSort 順で返す。
 * @param {Store} store
 * @param {number} seriesId
 * @returns {EpisodeEntry[]}
 */
export function getEpisodesForSeries(store, seriesId) {
  return _getEpisodesForSeriesSorted(store, seriesId)
}

// 全角アラビア数字 → 半角。
function _toHalfWidthDigits(s) {
  return s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xff10 + 0x30))
}

const _KANJI_DIGIT = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

// 漢数字（百の位まで）→ 整数。解釈不能なら null。例「十四」→14・「二十」→20・「百」→100。
function _kanjiToInt(s) {
  let total = 0
  let cur = 0
  let seen = false
  for (const ch of s) {
    if (ch in _KANJI_DIGIT) {
      cur = _KANJI_DIGIT[ch]
      seen = true
    } else if (ch === '十') {
      total += (cur || 1) * 10
      cur = 0
      seen = true
    } else if (ch === '百') {
      total += (cur || 1) * 100
      cur = 0
      seen = true
    } else {
      return null
    }
  }
  return seen ? total + cur : null
}

const _EP_COUNTER = '話|回|章|幕|夜|戦|品|羽|刻|頁|球|滑走'

// タイトル中の「話数表記」を高精度で拾う候補パターン（明確な話数マーカーに限定）。
const _ORDINAL_PATTERNS = [
  { re: new RegExp(`第\\s*([0-9０-９]+)\\s*(?:${_EP_COUNTER})`), kanji: false },
  { re: new RegExp(`第\\s*([零〇一二三四五六七八九十百]+)\\s*(?:${_EP_COUNTER})`), kanji: true },
  { re: /(?:EPISODE|Episode|episode|EP|Ep)\.?\s*#?\s*([0-9０-９]+)/, kanji: false },
  {
    re: /(?:Chapter|Stage|Phase|Scene|Act|Vol|Track|File|Mission|Site)\.?\s*#?\s*([0-9０-９]+)/i,
    kanji: false,
  },
  { re: /#\s*([0-9０-９]+)/, kanji: false },
  { re: /\b([0-9０-９]+)(?:st|nd|rd|th)\b/i, kanji: false },
  // 「第」なしの素の「N話」。ニコニコ支店は「タイトル[空白]16話[空白]サブ」表記が多い。
  // 直前を行頭/空白(JS の \s は全角空白 U+3000 を含む)に限定し、直前が数字や文字の
  // 総数表現(全12話・残り3話・各話)等を弾く。優先度は最下位(第N話・英語表記が先に当たる)。
  { re: /(?:^|\s)([0-9０-９]+)\s*話/, kanji: false },
]

/**
 * エピソードタイトルから話数（序数）を推定する。拾えなければ null。
 * 用途: episodeNo（nvapi 由来）が無い同時刻一括配信のソート・タイブレーカ。
 * contentId はアップロード順で実際の話順と逆転し得る（例: 第1話が最大 so番号）ため、
 * タイトルの「第N話」等の明示話数を contentId より優先する。一般則のみ（特定作品の固定値なし）。
 * @param {string|null|undefined} title
 * @returns {number|null}
 */
export function episodeOrdinalFromTitle(title) {
  if (!title) return null
  for (const { re, kanji } of _ORDINAL_PATTERNS) {
    const m = title.match(re)
    if (!m) continue
    if (kanji) {
      const v = _kanjiToInt(m[1])
      if (v != null) return v
    } else {
      const n = parseInt(_toHalfWidthDigits(m[1]), 10)
      if (Number.isFinite(n)) return n
    }
  }
  return null
}

/**
 * エピソードのクロノロジカルソート比較関数。
 * 優先度: startTime → episodeNo（nvapi 確定話順）→ タイトル推定話数 → contentId（安定）
 */
export function chronoSort(a, b) {
  if (a.startTime && b.startTime) {
    const diff = new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
    if (diff !== 0) return diff
  } else if (a.startTime) return -1
  else if (b.startTime) return 1

  if (a.episodeNo != null && b.episodeNo != null) {
    const diff = a.episodeNo - b.episodeNo
    if (diff !== 0) return diff
  } else if (a.episodeNo != null) return -1
  else if (b.episodeNo != null) return 1

  // episodeNo 欠落の同時刻一括配信向け: タイトルの「第N話」等から話数を推定して順序付け。
  const ao = episodeOrdinalFromTitle(a.title)
  const bo = episodeOrdinalFromTitle(b.title)
  if (ao != null && bo != null) {
    if (ao !== bo) return ao - bo
  } else if (ao != null) return -1
  else if (bo != null) return 1

  return a.contentId < b.contentId ? -1 : a.contentId > b.contentId ? 1 : 0
}

// ── 統計 ────────────────────────────────────────────────────────────────────

/**
 * ep>0 のシリーズ数（shrink 検出用）。
 * @param {Store} store
 * @returns {number}
 */
export function countSeriesWithEpisodes(store) {
  const sids = new Set()
  for (const ep of store.episodes.values()) {
    if (ep.seriesId != null) sids.add(ep.seriesId)
  }
  return sids.size
}

// ── 内部ヘルパ ──────────────────────────────────────────────────────────────

function _getEpisodesForSeriesSorted(store, seriesId) {
  const result = []
  for (const ep of store.episodes.values()) {
    if (ep.seriesId === seriesId) result.push(ep)
  }
  return result.sort(chronoSort)
}
