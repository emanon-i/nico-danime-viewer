// tests/store/store.test.mjs
// Store (M1) の単体テスト

import { describe, it, expect } from 'vitest'
import {
  createStore,
  upsertEpisodes,
  upsertSeries,
  linkEpisodes,
  updateSeries,
  syncSeriesThumbnails,
  syncSeriesTimestamps,
  getMetaState,
  updateMetaState,
  upsertRssItems,
  updateRssResolution,
  replaceSeriesTags,
  countOrphanEpisodes,
  selectSeedTargets,
  getEpisodesForSeries,
  chronoSort,
  countSeriesWithEpisodes,
} from '../../scripts/store/store.mjs'

// ────────────────────────────────────────────────────────────────────────────
// ヘルパ
// ────────────────────────────────────────────────────────────────────────────

function makeEp(overrides = {}) {
  return {
    contentId: 'so10000001',
    seriesId: null,
    episodeNo: 1,
    title: 'テスト第1話',
    viewCounter: 100,
    prevViewCounter: null,
    commentCounter: 0,
    likeCounter: 0,
    mylistCounter: 0,
    lengthSeconds: 1200,
    startTime: '2024-01-15T10:00:00+09:00',
    thumbnailUrl: 'https://example.com/thumb.jpg',
    description: 'あらすじ',
    tags: ['テストタグ'],
    tagsCurated: [],
    lastUpdated: null,
    ...overrides,
  }
}

function makeSeries(overrides = {}) {
  return {
    seriesId: 99001,
    title: 'テストシリーズ',
    colKey: 'た',
    thumbnailUrl: null,
    descriptionFirst: null,
    cours: '2024-冬',
    franchiseKey: null,
    isAvailable: true,
    tags: [],
    relatedSeries: [],
    ...overrides,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// createStore
// ────────────────────────────────────────────────────────────────────────────

describe('createStore', () => {
  it('空のストアを返す', () => {
    const store = createStore()
    expect(store.series.size).toBe(0)
    expect(store.episodes.size).toBe(0)
    expect(store.rss.size).toBe(0)
    expect(store.meta.rssLastGuid).toBeNull()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// upsertEpisodes
// ────────────────────────────────────────────────────────────────────────────

describe('upsertEpisodes', () => {
  it('新規エピソードを追加する', () => {
    const store = createStore()
    upsertEpisodes(store, [makeEp()])
    expect(store.episodes.size).toBe(1)
    expect(store.episodes.get('so10000001')?.title).toBe('テスト第1話')
  })

  it('既存エピソードの viewCounter を更新し prev に退避する', () => {
    const store = createStore()
    upsertEpisodes(store, [makeEp({ viewCounter: 100 })])
    upsertEpisodes(store, [{ contentId: 'so10000001', viewCounter: 150 }])
    const ep = store.episodes.get('so10000001')
    expect(ep.viewCounter).toBe(150)
    expect(ep.prevViewCounter).toBe(100)
  })

  it('seriesId が確定済みなら上書きしない（PRESERVE）', () => {
    const store = createStore()
    upsertEpisodes(store, [makeEp({ seriesId: 99001 })])
    upsertEpisodes(store, [{ contentId: 'so10000001', seriesId: 99002, viewCounter: 200 }])
    expect(store.episodes.get('so10000001')?.seriesId).toBe(99001)
  })

  it('seriesId が null なら新しい seriesId を受け入れる', () => {
    const store = createStore()
    upsertEpisodes(store, [makeEp({ seriesId: null })])
    upsertEpisodes(store, [{ contentId: 'so10000001', seriesId: 99002 }])
    expect(store.episodes.get('so10000001')?.seriesId).toBe(99002)
  })

  it('title・startTime は既存値を PRESERVE する', () => {
    const store = createStore()
    upsertEpisodes(store, [makeEp({ title: 'オリジナル', startTime: '2024-01-01T00:00:00Z' })])
    // title/startTime なしで更新
    upsertEpisodes(store, [{ contentId: 'so10000001', viewCounter: 200 }])
    const ep = store.episodes.get('so10000001')
    expect(ep.title).toBe('オリジナル')
    expect(ep.startTime).toBe('2024-01-01T00:00:00Z')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// upsertSeries
// ────────────────────────────────────────────────────────────────────────────

describe('upsertSeries', () => {
  it('新規シリーズを追加する', () => {
    const store = createStore()
    upsertSeries(store, [makeSeries()])
    expect(store.series.size).toBe(1)
    expect(store.series.get(99001)?.title).toBe('テストシリーズ')
  })

  it('thumbnailUrl を COALESCE する（既存があれば保護）', () => {
    const store = createStore()
    upsertSeries(store, [makeSeries({ thumbnailUrl: 'https://example.com/thumb.jpg' })])
    upsertSeries(store, [{ seriesId: 99001, thumbnailUrl: 'https://example.com/new.jpg' }])
    expect(store.series.get(99001)?.thumbnailUrl).toBe('https://example.com/thumb.jpg')
  })

  it('thumbnailUrl が null なら新しい値を受け入れる', () => {
    const store = createStore()
    upsertSeries(store, [makeSeries({ thumbnailUrl: null })])
    upsertSeries(store, [{ seriesId: 99001, thumbnailUrl: 'https://example.com/new.jpg' }])
    expect(store.series.get(99001)?.thumbnailUrl).toBe('https://example.com/new.jpg')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// linkEpisodes
// ────────────────────────────────────────────────────────────────────────────

describe('linkEpisodes', () => {
  it('orphan エピソードに seriesId を紐付ける', () => {
    const store = createStore()
    upsertEpisodes(store, [makeEp({ seriesId: null })])
    linkEpisodes(store, [{ contentId: 'so10000001', seriesId: 99001, episodeNo: 1 }])
    const ep = store.episodes.get('so10000001')
    expect(ep.seriesId).toBe(99001)
    expect(ep.episodeNo).toBe(1)
  })

  it('_dirtySeries にマークする', () => {
    const store = createStore()
    upsertEpisodes(store, [makeEp({ seriesId: null })])
    linkEpisodes(store, [{ contentId: 'so10000001', seriesId: 99001 }])
    expect(store._dirtySeries.has(99001)).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// updateSeries
// ────────────────────────────────────────────────────────────────────────────

describe('updateSeries', () => {
  it('ホワイトリスト内フィールドを更新する', () => {
    const store = createStore()
    upsertSeries(store, [makeSeries()])
    updateSeries(store, 99001, { cours: '2024-春', colKey: 'た' })
    expect(store.series.get(99001)?.cours).toBe('2024-春')
  })

  it('存在しない seriesId は無視する', () => {
    const store = createStore()
    expect(() => updateSeries(store, 99999, { title: 'X' })).not.toThrow()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// syncSeriesThumbnails
// ────────────────────────────────────────────────────────────────────────────

describe('syncSeriesThumbnails', () => {
  it('thumbnailUrl が null のシリーズにエピソードのサムネを補完する', () => {
    const store = createStore()
    upsertSeries(store, [makeSeries({ thumbnailUrl: null })])
    upsertEpisodes(store, [
      makeEp({
        seriesId: 99001,
        thumbnailUrl: 'https://example.com/ep1.jpg',
        startTime: '2024-01-01T00:00:00Z',
      }),
    ])
    syncSeriesThumbnails(store)
    expect(store.series.get(99001)?.thumbnailUrl).toBe('https://example.com/ep1.jpg')
  })

  it('既存サムネがある場合は上書きしない', () => {
    const store = createStore()
    upsertSeries(store, [makeSeries({ thumbnailUrl: 'https://example.com/series.jpg' })])
    upsertEpisodes(store, [
      makeEp({ seriesId: 99001, thumbnailUrl: 'https://example.com/ep1.jpg' }),
    ])
    syncSeriesThumbnails(store)
    expect(store.series.get(99001)?.thumbnailUrl).toBe('https://example.com/series.jpg')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// syncSeriesTimestamps
// ────────────────────────────────────────────────────────────────────────────

describe('syncSeriesTimestamps', () => {
  it('firstSeen / lastSeen を startTime から計算する', () => {
    const store = createStore()
    upsertSeries(store, [makeSeries()])
    upsertEpisodes(store, [
      makeEp({ contentId: 'so10000001', seriesId: 99001, startTime: '2024-01-01T00:00:00Z' }),
      makeEp({ contentId: 'so10000002', seriesId: 99001, startTime: '2024-06-01T00:00:00Z' }),
    ])
    syncSeriesTimestamps(store)
    const s = store.series.get(99001)
    expect(s.firstSeen).toBe('2024-01-01T00:00:00Z')
    expect(s.lastSeen).toBe('2024-06-01T00:00:00Z')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// meta state
// ────────────────────────────────────────────────────────────────────────────

describe('meta state', () => {
  it('updateMetaState で更新し getMetaState で取得できる', () => {
    const store = createStore()
    updateMetaState(store, { rssLastGuid: 'tag:nicovideo.jp,2024-01-01:/watch/12345' })
    const meta = getMetaState(store)
    expect(meta.rssLastGuid).toBe('tag:nicovideo.jp,2024-01-01:/watch/12345')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// RSS
// ────────────────────────────────────────────────────────────────────────────

describe('rss', () => {
  it('upsertRssItems で新規 RSS を追加する', () => {
    const store = createStore()
    upsertRssItems(store, [
      {
        watchId: '12345678',
        guid: 'tag:nicovideo.jp,2024-01-01:/watch/12345678',
        title: 'テスト第1話',
        resolutionStatus: 'unresolved',
      },
    ])
    expect(store.rss.size).toBe(1)
    expect(store.rss.get('12345678')?.resolutionStatus).toBe('unresolved')
  })

  it('updateRssResolution で解決状態を更新する', () => {
    const store = createStore()
    upsertRssItems(store, [{ watchId: '12345678', resolutionStatus: 'unresolved' }])
    updateRssResolution(store, '12345678', 'so99000001', 'resolved')
    const item = store.rss.get('12345678')
    expect(item.resolvedContentId).toBe('so99000001')
    expect(item.resolutionStatus).toBe('resolved')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// countOrphanEpisodes / selectSeedTargets
// ────────────────────────────────────────────────────────────────────────────

describe('orphan / seed targets', () => {
  it('seriesId が null のエピソード数を正しくカウントする', () => {
    const store = createStore()
    upsertEpisodes(store, [
      makeEp({ contentId: 'so10000001', seriesId: 99001 }),
      makeEp({ contentId: 'so10000002', seriesId: null }),
      makeEp({ contentId: 'so10000003', seriesId: null }),
    ])
    expect(countOrphanEpisodes(store)).toBe(2)
  })

  it('orphan がある場合 selectSeedTargets は全 isAvailable シリーズを返す', () => {
    const store = createStore()
    upsertSeries(store, [
      makeSeries({ seriesId: 99001 }),
      makeSeries({ seriesId: 99002, isAvailable: false }),
    ])
    upsertEpisodes(store, [makeEp({ contentId: 'so10000001', seriesId: null })])
    const targets = selectSeedTargets(store, { allIfOrphans: true })
    expect(targets).toContain(99001)
    expect(targets).not.toContain(99002)
  })

  it('orphan がない場合はエピソード不足シリーズのみを返す', () => {
    const store = createStore()
    upsertSeries(store, [makeSeries({ seriesId: 99001 }), makeSeries({ seriesId: 99002 })])
    // 99001 は ep 5 件, 99002 は ep 1 件（threshold 3 以下）
    for (let i = 0; i < 5; i++) {
      upsertEpisodes(store, [makeEp({ contentId: `so1000000${i}`, seriesId: 99001 })])
    }
    upsertEpisodes(store, [makeEp({ contentId: 'so1000010', seriesId: 99002 })])
    const targets = selectSeedTargets(store, { insufficientThreshold: 3, allIfOrphans: true })
    expect(targets).not.toContain(99001)
    expect(targets).toContain(99002)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// chronoSort
// ────────────────────────────────────────────────────────────────────────────

describe('chronoSort', () => {
  it('startTime 昇順でソートする', () => {
    const eps = [
      makeEp({ contentId: 'so10000002', startTime: '2024-02-01T00:00:00Z' }),
      makeEp({ contentId: 'so10000001', startTime: '2024-01-01T00:00:00Z' }),
    ]
    eps.sort(chronoSort)
    expect(eps[0].contentId).toBe('so10000001')
    expect(eps[1].contentId).toBe('so10000002')
  })

  it('startTime が同じ場合 episodeNo でソートする', () => {
    const eps = [
      makeEp({ contentId: 'so10000002', startTime: '2024-01-01T00:00:00Z', episodeNo: 2 }),
      makeEp({ contentId: 'so10000001', startTime: '2024-01-01T00:00:00Z', episodeNo: 1 }),
    ]
    eps.sort(chronoSort)
    expect(eps[0].contentId).toBe('so10000001')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// getEpisodesForSeries
// ────────────────────────────────────────────────────────────────────────────

describe('getEpisodesForSeries', () => {
  it('指定 seriesId のエピソードを chronoSort 順で返す', () => {
    const store = createStore()
    upsertEpisodes(store, [
      makeEp({
        contentId: 'so10000002',
        seriesId: 99001,
        episodeNo: 2,
        startTime: '2024-02-01T00:00:00Z',
      }),
      makeEp({
        contentId: 'so10000001',
        seriesId: 99001,
        episodeNo: 1,
        startTime: '2024-01-01T00:00:00Z',
      }),
      makeEp({
        contentId: 'so20000001',
        seriesId: 99002,
        episodeNo: 1,
        startTime: '2024-01-01T00:00:00Z',
      }),
    ])
    const eps = getEpisodesForSeries(store, 99001)
    expect(eps.length).toBe(2)
    expect(eps[0].contentId).toBe('so10000001')
    expect(eps[1].contentId).toBe('so10000002')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// countSeriesWithEpisodes
// ────────────────────────────────────────────────────────────────────────────

describe('countSeriesWithEpisodes', () => {
  it('ep>0 のシリーズ数を返す', () => {
    const store = createStore()
    upsertEpisodes(store, [
      makeEp({ contentId: 'so10000001', seriesId: 99001 }),
      makeEp({ contentId: 'so10000002', seriesId: 99001 }),
      makeEp({ contentId: 'so10000003', seriesId: 99002 }),
      makeEp({ contentId: 'so10000004', seriesId: null }), // orphan は含まない
    ])
    expect(countSeriesWithEpisodes(store)).toBe(2)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// replaceSeriesTags
// ────────────────────────────────────────────────────────────────────────────

describe('replaceSeriesTags', () => {
  it('シリーズのタグを置換する', () => {
    const store = createStore()
    upsertSeries(store, [makeSeries()])
    replaceSeriesTags(store, 99001, [
      { name: 'アクション', isCurated: true },
      { name: 'SF', isCurated: false },
    ])
    const tags = store.series.get(99001)?.tags
    expect(tags).toHaveLength(2)
    expect(tags?.[0]).toEqual({ name: 'アクション', isCurated: true })
  })
})
