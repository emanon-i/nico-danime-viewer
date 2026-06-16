import { describe, it, expect } from 'vitest'
import { isBranchSeries, mapNvapiItems, BRANCH_CHANNEL } from '../../scripts/nico/nvapi.mjs'

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
