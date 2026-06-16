import { describe, it, expect } from 'vitest'
import { watchLink, seriesLink } from '../../web/src/shared/deeplink'

describe('watchLink (F-0026)', () => {
  it('test_deeplink_format: so... contentId から正しい watch URL を生成する', () => {
    expect(watchLink('so12345')).toBe('https://www.nicovideo.jp/watch/so12345')
    expect(watchLink('so999999999')).toBe('https://www.nicovideo.jp/watch/so999999999')
  })

  it('test_deeplink_rejects_invalid_id: so... でない contentId は null を返す', () => {
    expect(watchLink('12345')).toBeNull()
    expect(watchLink('')).toBeNull()
    expect(watchLink('video12345')).toBeNull()
    expect(watchLink('SO12345')).toBeNull()
    expect(watchLink('so')).toBeNull()
  })
})

describe('seriesLink (F-0026)', () => {
  it('test_deeplink_format: 正整数 series id から正しい series URL を生成する', () => {
    expect(seriesLink(12345)).toBe('https://www.nicovideo.jp/series/12345')
    expect(seriesLink(1)).toBe('https://www.nicovideo.jp/series/1')
  })

  it('test_deeplink_rejects_invalid_id: 非整数・非正数は null を返す', () => {
    expect(seriesLink(0)).toBeNull()
    expect(seriesLink(-1)).toBeNull()
    expect(seriesLink(1.5)).toBeNull()
    expect(seriesLink(NaN)).toBeNull()
  })
})
