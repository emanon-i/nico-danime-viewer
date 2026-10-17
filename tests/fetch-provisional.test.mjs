// tests/fetch-provisional.test.mjs
// registerProvisionalSeries のサムネ伝播テスト（修正B）。
// contentId は contentIdFromThumbnail(rssEntry.thumbnailUrl) 由来のため thumbnailUrl は実質
// 常に存在する。series 側にも episode 側にも thumbnailUrl が入ることを確認する。

import { describe, it, expect } from 'vitest'
import { createStore } from '../scripts/store/store.mjs'
import { registerProvisionalSeries, compareByFirstSeen } from '../scripts/fetch.mjs'

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
