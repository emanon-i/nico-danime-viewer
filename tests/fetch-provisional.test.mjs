// tests/fetch-provisional.test.mjs
// registerProvisionalSeries のサムネ伝播テスト（修正B）。
// contentId は contentIdFromThumbnail(rssEntry.thumbnailUrl) 由来のため thumbnailUrl は実質
// 常に存在する。series 側にも episode 側にも thumbnailUrl が入ることを確認する。

import { describe, it, expect } from 'vitest'
import { createStore, upsertSeries } from '../scripts/store/store.mjs'
import {
  registerProvisionalSeries,
  compareByFirstSeen,
  applyFranchises,
} from '../scripts/fetch.mjs'

describe('registerProvisionalSeries サムネ伝播', () => {
  it('series と episode の両方に thumbnailUrl が入る', () => {
    const store = createStore()
    const rssEntry = {
      title: 'テスト作品　第1話',
      pubDate: 'Fri, 03 Jul 2026 22:30:00 +0900',
      description: 'あらすじ',
      thumbnailUrl: 'https://nicovideo.cdn.nimg.jp/thumbnails/40123456/40123456.L',
    }
    const sid = registerProvisionalSeries(store, 'sm40123456', rssEntry)
    expect(sid).not.toBeNull()

    const series = store.series.get(sid)
    expect(series).toBeTruthy()
    expect(series.thumbnailUrl).toBe(rssEntry.thumbnailUrl)

    const ep = store.episodes.get('so40123456')
    expect(ep).toBeTruthy()
    expect(ep.thumbnailUrl).toBe(rssEntry.thumbnailUrl)
  })

  it('thumbnailUrl が復元できない場合は null を返す', () => {
    const store = createStore()
    const sid = registerProvisionalSeries(store, 'sm1', {
      title: 'テスト作品　第1話',
      pubDate: null,
      description: null,
      thumbnailUrl: null,
    })
    expect(sid).toBeNull()
  })
})

describe('compareByFirstSeen（関連シリーズの並び＝初話の投稿日の古い順）', () => {
  it('古い順・日時不明は末尾・同時刻と不明同士は seriesId 昇順', () => {
    const list = [
      { seriesId: 5, firstSeen: null },
      { seriesId: 3, firstSeen: '2020-04-01T00:00:00+09:00' },
      { seriesId: 2, firstSeen: 'Sat, 20 Jun 2015 00:00:00 +0900' },
      { seriesId: 1, firstSeen: '2020-04-01T00:00:00+09:00' },
      { seriesId: 4, firstSeen: 'invalid' },
    ]
    expect(list.sort(compareByFirstSeen).map((s) => s.seriesId)).toEqual([2, 1, 3, 4, 5])
  })
})

describe('applyFranchises（日次 E4：franchiseKey と relatedSeries の再計算）', () => {
  const build = () => {
    const store = createStore()
    upsertSeries(store, [
      { seriesId: 1, title: 'ゆるキャン△', tags: ['ゆるキャン△シリーズ', '公式が病気シリーズ'] },
      { seriesId: 2, title: 'ゆるキャン△ SEASON２', tags: ['ゆるキャン△シリーズ'] },
      // 前回の誤結合の名残（ネタタグ経由で 1・2 と束ねられていた）
      {
        seriesId: 3,
        title: 'プリパラ',
        tags: ['公式が病気シリーズ'],
        franchiseKey: 'f:1',
        relatedSeries: [
          { seriesId: 1, title: 'ゆるキャン△', thumbnailUrl: null },
          { seriesId: 2, title: 'ゆるキャン△ SEASON２', thumbnailUrl: null },
        ],
      },
    ])
    // 支店への追加日: 2 のほうが 1 より早い（並びの確認用）
    store.episodes.set('so1', {
      contentId: 'so1',
      seriesId: 1,
      startTime: '2021-01-07T00:00:00+09:00',
    })
    store.episodes.set('so2', {
      contentId: 'so2',
      seriesId: 2,
      startTime: '2020-01-07T00:00:00+09:00',
    })
    store.episodes.set('so3', {
      contentId: 'so3',
      seriesId: 3,
      startTime: '2019-01-07T00:00:00+09:00',
    })
    return store
  }

  it('ネタタグでは束ねず、束から外れたシリーズの古い relatedSeries を空にする', () => {
    const store = build()
    expect(applyFranchises(store)).toBe(2)
    expect(store.series.get(1).franchiseKey).toBe(store.series.get(2).franchiseKey)
    expect(store.series.get(3).franchiseKey).toBeNull()
    expect(store.series.get(3).relatedSeries).toEqual([])
    expect(store._dirtySeries.has(3)).toBe(true)
  })

  it('relatedSeries は初話の投稿日（支店に追加された日）の古い順', () => {
    const store = build()
    upsertSeries(store, [
      { seriesId: 4, title: '映画『ゆるキャン△』', tags: ['ゆるキャン△シリーズ'] },
    ])
    store.episodes.set('so4', {
      contentId: 'so4',
      seriesId: 4,
      startTime: '2022-07-01T00:00:00+09:00',
    })
    applyFranchises(store)
    expect(store.series.get(1).relatedSeries.map((r) => r.seriesId)).toEqual([2, 4])
    expect(store.series.get(4).relatedSeries.map((r) => r.seriesId)).toEqual([2, 1])
  })
})
