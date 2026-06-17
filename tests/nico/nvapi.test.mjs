import { describe, it, expect } from 'vitest'
import {
  isBranchSeries,
  mapNvapiItems,
  mapNvapiEpisodes,
  BRANCH_CHANNEL,
} from '../../scripts/nico/nvapi.mjs'

describe('isBranchSeries (F-0012)', () => {
  it('test_branch_series_detection: ch2632720 は支店シリーズ', () => {
    const detail = { owner: { channel: { id: 'ch2632720' } } }
    expect(isBranchSeries(detail)).toBe(true)
  })

  it('test_non_branch_detection: 別チャンネルは支店シリーズではない', () => {
    const detail = { owner: { channel: { id: 'ch9999999' } } }
    expect(isBranchSeries(detail)).toBe(false)
  })

  it('detail が null でも throw しない', () => {
    expect(isBranchSeries(null)).toBe(false)
    expect(isBranchSeries({})).toBe(false)
    expect(isBranchSeries({ owner: {} })).toBe(false)
  })

  it('BRANCH_CHANNEL 定数が ch2632720 である', () => {
    expect(BRANCH_CHANNEL).toBe('ch2632720')
  })
})

describe('mapNvapiItems (F-0012)', () => {
  it('test_nvapi_episode_order: index + 1 が episodeNo になる', () => {
    const items = [
      { video: { id: 'so1001' } },
      { video: { id: 'so1002' } },
      { video: { id: 'so1003' } },
    ]
    const result = mapNvapiItems(100, items)

    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ contentId: 'so1001', seriesId: 100, episodeNo: 1 })
    expect(result[1]).toEqual({ contentId: 'so1002', seriesId: 100, episodeNo: 2 })
    expect(result[2]).toEqual({ contentId: 'so1003', seriesId: 100, episodeNo: 3 })
  })

  it('空 items は空配列を返す', () => {
    expect(mapNvapiItems(1, [])).toHaveLength(0)
  })

  it('video.id がない場合は item.id を使う', () => {
    const items = [{ id: 'so999' }]
    const result = mapNvapiItems(1, items)
    expect(result[0].contentId).toBe('so999')
  })

  it('contentId は文字列に変換される', () => {
    const items = [{ video: { id: 12345 } }]
    const result = mapNvapiItems(1, items)
    expect(typeof result[0].contentId).toBe('string')
    expect(result[0].contentId).toBe('12345')
  })
})

describe('mapNvapiEpisodes (§85 backfill)', () => {
  const items = [
    {
      meta: { id: 'so34938001', order: 1 },
      video: {
        id: 'so34938001',
        title: '第1話',
        registeredAt: '2019-04-10T12:00:00+09:00',
        count: { view: 17759, comment: 628, mylist: 326, like: 41 },
        thumbnail: { url: 'https://nicovideo.cdn.nimg.jp/thumbnails/x/x' },
        duration: 1440,
        shortDescription: 'あらすじ',
      },
    },
  ]

  it('各話フルレコードを生成する（bulkUpsertEpisodes 用フィールド）', () => {
    const [e] = mapNvapiEpisodes(67945, items)
    expect(e.contentId).toBe('so34938001')
    expect(e.seriesId).toBe(67945)
    expect(e.episodeNo).toBe(1)
    expect(e.title).toBe('第1話')
    expect(e.viewCounter).toBe(17759)
    expect(e.commentCounter).toBe(628)
    expect(e.mylistCounter).toBe(326)
    expect(e.likeCounter).toBe(41)
    expect(e.lengthSeconds).toBe(1440)
    expect(e.startTime).toBe('2019-04-10T12:00:00+09:00')
    expect(e.thumbnailUrl).toContain('nimg.jp')
    expect(e.description).toBe('あらすじ')
    expect(e.tags).toBeNull() // nvapi は各話タグを持たない
  })

  it('meta.order が無ければ index+1 を話順に使う', () => {
    const [e] = mapNvapiEpisodes(1, [{ video: { id: 'so1' } }])
    expect(e.episodeNo).toBe(1)
  })

  it('contentId が取れない item は除外', () => {
    expect(mapNvapiEpisodes(1, [{ video: {} }, { meta: {} }])).toHaveLength(0)
  })
})
