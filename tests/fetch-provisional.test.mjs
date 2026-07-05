// tests/fetch-provisional.test.mjs
// registerProvisionalSeries のサムネ伝播テスト（修正B）。
// contentId は contentIdFromThumbnail(rssEntry.thumbnailUrl) 由来のため thumbnailUrl は実質
// 常に存在する。series 側にも episode 側にも thumbnailUrl が入ることを確認する。

import { describe, it, expect } from 'vitest'
import { createStore } from '../scripts/store/store.mjs'
import { registerProvisionalSeries } from '../scripts/fetch.mjs'

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
