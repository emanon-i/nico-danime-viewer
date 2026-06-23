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
  episodeOrdinalFromTitle,
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

  it('description long-wins: 短い新値は長い既存値を上書きしない', () => {
    const store = createStore()
    const longDesc = 'A'.repeat(200)
    upsertEpisodes(store, [makeEp({ description: longDesc })])
    upsertEpisodes(store, [{ contentId: 'so10000001', description: 'short' }])
    expect(store.episodes.get('so10000001')?.description).toBe(longDesc)
  })

  it('description long-wins: 長い新値は短い既存値を上書きする', () => {
    const store = createStore()
    upsertEpisodes(store, [makeEp({ description: 'short' })])
    const longDesc = 'B'.repeat(200)
    upsertEpisodes(store, [{ contentId: 'so10000001', description: longDesc }])
    expect(store.episodes.get('so10000001')?.description).toBe(longDesc)
  })

  it('description long-wins: null 新値は既存値を保護する', () => {
    const store = createStore()
    upsertEpisodes(store, [makeEp({ description: 'existing' })])
    upsertEpisodes(store, [{ contentId: 'so10000001', description: null }])
    expect(store.episodes.get('so10000001')?.description).toBe('existing')
  })

  it('description long-wins: null 既存に non-null 新値を受け入れる', () => {
    const store = createStore()
    upsertEpisodes(store, [makeEp({ description: null })])
    upsertEpisodes(store, [{ contentId: 'so10000001', description: 'new description' }])
    expect(store.episodes.get('so10000001')?.description).toBe('new description')
  })

  it('episodeNo COALESCE: 既存 null を nvapi 由来の話順で後埋めする', () => {
    const store = createStore()
    // snapshot 相当: episodeNo 無しで作成（null）
    upsertEpisodes(store, [makeEp({ seriesId: 99001, episodeNo: null })])
    expect(store.episodes.get('so10000001')?.episodeNo).toBeNull()
    // nvapi seed 相当: 話順を後埋め
    upsertEpisodes(store, [{ contentId: 'so10000001', seriesId: 99001, episodeNo: 3 }])
    expect(store.episodes.get('so10000001')?.episodeNo).toBe(3)
  })

  it('episodeNo COALESCE: 確定済み（non-null）は raw で上書きしない', () => {
    const store = createStore()
    upsertEpisodes(store, [makeEp({ seriesId: 99001, episodeNo: 5 })])
    // 後続が別値を渡しても確定値を守る（snapshot null 逆流防止と同方針）
    upsertEpisodes(store, [{ contentId: 'so10000001', seriesId: 99001, episodeNo: 99 }])
    expect(store.episodes.get('so10000001')?.episodeNo).toBe(5)
  })

  it('episodeNo COALESCE: 既存 null・raw も null なら null のまま', () => {
    const store = createStore()
    upsertEpisodes(store, [makeEp({ seriesId: 99001, episodeNo: null })])
    upsertEpisodes(store, [{ contentId: 'so10000001', seriesId: 99001, viewCounter: 200 }])
    expect(store.episodes.get('so10000001')?.episodeNo).toBeNull()
  })

  it('episodeNo COALESCE: 後埋めでシリーズが dirty になる', () => {
    const store = createStore()
    upsertEpisodes(store, [makeEp({ seriesId: 99001, episodeNo: null })])
    store._dirtySeries.clear()
    upsertEpisodes(store, [{ contentId: 'so10000001', seriesId: 99001, episodeNo: 2 }])
    expect(store._dirtySeries.has(99001)).toBe(true)
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
        resolutionStatus: 'pending',
      },
    ])
    expect(store.rss.size).toBe(1)
    expect(store.rss.get('12345678')?.resolutionStatus).toBe('pending')
  })

  it('upsertRssItems で不正な resolutionStatus は pending に矯正される', () => {
    const store = createStore()
    upsertRssItems(store, [{ watchId: '99999999', resolutionStatus: 'unresolved' }])
    expect(store.rss.get('99999999')?.resolutionStatus).toBe('pending')
  })

  it('updateRssResolution で解決状態を更新する', () => {
    const store = createStore()
    upsertRssItems(store, [{ watchId: '12345678', resolutionStatus: 'pending' }])
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

  it('startTime 同時刻・episodeNo 欠落ならタイトルの話数で並べる（contentId 逆転を是正）', () => {
    // 一括配信で so番号が話数と逆転している実データ相当のケース。
    const eps = [
      makeEp({
        contentId: 'so100',
        startTime: '2026-06-10T06:00:00+09:00',
        episodeNo: null,
        title: 'X 第7話 g',
      }),
      makeEp({
        contentId: 'so106',
        startTime: '2026-06-10T06:00:00+09:00',
        episodeNo: null,
        title: 'X 第1話 a',
      }),
      makeEp({
        contentId: 'so103',
        startTime: '2026-06-10T06:00:00+09:00',
        episodeNo: null,
        title: 'X 第4話 d',
      }),
    ]
    eps.sort(chronoSort)
    expect(eps.map((e) => episodeOrdinalFromTitle(e.title))).toEqual([1, 4, 7])
  })

  it('startTime はタイトル話数より優先（後日投稿の話は後ろ）', () => {
    const eps = [
      makeEp({
        contentId: 'so200',
        startTime: '2026-06-11T06:00:00+09:00',
        episodeNo: null,
        title: 'X 第1話',
      }),
      makeEp({
        contentId: 'so201',
        startTime: '2026-06-10T06:00:00+09:00',
        episodeNo: null,
        title: 'X 第8話',
      }),
    ]
    eps.sort(chronoSort)
    // 6/10 投稿の第8話が 6/11 投稿の第1話より前（startTime 昇順が主キー）
    expect(eps[0].title).toBe('X 第8話')
  })
})

describe('episodeOrdinalFromTitle', () => {
  it('代表的な話数表記を拾う', () => {
    expect(episodeOrdinalFromTitle('心臓に復讐を誓って　第1話　最高の不幸')).toBe(1)
    expect(episodeOrdinalFromTitle('まほろまてぃっく　第10話')).toBe(10)
    expect(episodeOrdinalFromTitle('ビビッドレッド　第二話')).toBe(2)
    expect(episodeOrdinalFromTitle('まほろ　第十四話')).toBe(14)
    expect(episodeOrdinalFromTitle('全角　第１２話')).toBe(12)
    expect(episodeOrdinalFromTitle('DOG DAYS　EPISODE 7')).toBe(7)
    expect(episodeOrdinalFromTitle('Occultic;Nine　Site 03')).toBe(3)
    expect(episodeOrdinalFromTitle('海のトリトン　Chapter.2')).toBe(2)
    expect(episodeOrdinalFromTitle('けいおん #4')).toBe(4)
    expect(episodeOrdinalFromTitle('俺の友達　1st game')).toBe(1)
  })

  it('「第」なしの素の「N話」も拾う（ニコニコ支店の表記ゆれ）', () => {
    // 例: ニコニコ支店の「Fate/stay night [全角空白] 16話」表記（「第」が付かない）
    expect(episodeOrdinalFromTitle('Fate/stay night　16話　約束された勝利の剣')).toBe(16)
    expect(episodeOrdinalFromTitle('Fate/stay night　1話　始まりの日')).toBe(1)
    expect(episodeOrdinalFromTitle('24話')).toBe(24)
  })

  it('総数・残数表現は誤検出しない（全N話・残りN話）', () => {
    expect(episodeOrdinalFromTitle('全12話　一挙放送')).toBeNull()
    expect(episodeOrdinalFromTitle('全12話')).toBeNull()
    expect(episodeOrdinalFromTitle('最終話')).toBeNull()
  })

  it('話数表記が無ければ null', () => {
    expect(episodeOrdinalFromTitle('TARI TARI')).toBeNull()
    expect(episodeOrdinalFromTitle('Fate/stay night')).toBeNull()
    expect(episodeOrdinalFromTitle('')).toBeNull()
    expect(episodeOrdinalFromTitle(null)).toBeNull()
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
