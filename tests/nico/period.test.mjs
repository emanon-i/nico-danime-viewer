// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { periodUrl, seasonOfMonth, enumeratePastSeasons } from '../../scripts/nico/period.mjs'

describe('period.mjs', () => {
  it('periodUrl: 年-英語季-danime.html の URL を生成する', () => {
    expect(periodUrl(2022, 'autumn')).toBe(
      'https://anime.nicovideo.jp/period/2022-autumn-danime.html'
    )
    expect(periodUrl(2026, 'spring')).toBe(
      'https://anime.nicovideo.jp/period/2026-spring-danime.html'
    )
  })

  it('seasonOfMonth: 月から季を返す（冬1-3/春4-6/夏7-9/秋10-12）', () => {
    expect(seasonOfMonth(1)).toBe('winter')
    expect(seasonOfMonth(4)).toBe('spring')
    expect(seasonOfMonth(7)).toBe('summer')
    expect(seasonOfMonth(12)).toBe('autumn')
  })

  it('enumeratePastSeasons: 現行季・未来季を除外し新しい順に並べる', () => {
    // 2026-06（spring）基準
    const now = new Date('2026-06-17T00:00:00+09:00')
    const seasons = enumeratePastSeasons(now, 2025)
    // 現行季（2026-spring）と未来季（2026-summer/autumn）は含まない
    expect(seasons).not.toContainEqual({ year: 2026, season: 'spring' })
    expect(seasons).not.toContainEqual({ year: 2026, season: 'summer' })
    expect(seasons).not.toContainEqual({ year: 2026, season: 'autumn' })
    // 直前の季＝2026-winter が先頭（新しい順）
    expect(seasons[0]).toEqual({ year: 2026, season: 'winter' })
    // 下限年まで遡る
    expect(seasons).toContainEqual({ year: 2025, season: 'winter' })
    // 全季が下限年〜現行季直前
    expect(seasons.length).toBe(5) // 2026冬 + 2025(冬春夏秋)
  })
})
