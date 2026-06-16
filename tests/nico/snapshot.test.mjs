import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildYearWindows,
  fetchWindow,
  fetchAllBranchEpisodes,
} from '../../scripts/nico/snapshot.mjs'
import { _resetAdaptiveDelay, _http } from '../../scripts/lib/http.mjs'

beforeEach(() => {
  _resetAdaptiveDelay()
  _http.sleepFn = vi.fn().mockResolvedValue(undefined)
  _http.nowFn = vi.fn().mockReturnValue(0)
})

afterEach(() => {
  vi.unstubAllGlobals()
  _http.sleepFn = (ms) => new Promise((r) => setTimeout(r, ms))
  _http.nowFn = () => Date.now()
})

describe('buildYearWindows (F-0008)', () => {
  it('test_starttime_filter_has_timezone (AC-1)', () => {
    const windows = buildYearWindows(2013)
    for (const { gte, lte } of windows) {
      expect(gte).toMatch(/\+09:00$/)
      expect(lte).toMatch(/\+09:00$/)
    }
  })

  it('windows cover from FIRST_YEAR to currentYear', () => {
    const windows = buildYearWindows(2014)
    expect(windows[0].gte).toMatch(/^2012-/)
    expect(windows[windows.length - 1].gte).toMatch(/^2014-/)
  })
})

describe('fetchWindow (F-0008)', () => {
  it('test_window_split_covers_all (AC-2): 全件を offset 分割して取得', async () => {
    // 最初のページに100件、2ページ目に50件、3ページ目は空 → 合計150件
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        call++
        const data =
          call === 1
            ? Array.from({ length: 100 }, (_, i) => ({
                contentId: `so${i}`,
                channelId: 2632720,
                startTime: '2020-01-01T00:00:00+09:00',
              }))
            : call === 2
              ? Array.from({ length: 50 }, (_, i) => ({
                  contentId: `so${100 + i}`,
                  channelId: 2632720,
                  startTime: '2020-01-01T00:00:00+09:00',
                }))
              : []
        return Promise.resolve({
          status: 200,
          json: async () => ({ meta: { status: 200 }, data }),
        })
      })
    )

    const items = await fetchWindow('2020-01-01T00:00:00+09:00', '2020-12-31T23:59:59+09:00')
    expect(items).toHaveLength(150)
  })
})

describe('fetchAllBranchEpisodes (F-0008)', () => {
  it('test_version_gate_skips_when_unchanged (AC-3)', async () => {
    const stored = '2026-06-15T10:00:00+09:00'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ last_modified: stored }),
      })
    )

    const result = await fetchAllBranchEpisodes(stored)
    expect(result.skipped).toBe(true)
    // search エンドポイントは呼ばれない（version チェックのみ）
  })

  it('test_window_split_no_gap_no_overlap (AC-4): 既知件数フィクスチャで重複・欠落 0', async () => {
    // version は変更あり扱い
    let versionCalled = false
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url) => {
        if (url.includes('/version')) {
          versionCalled = true
          return Promise.resolve({
            status: 200,
            json: async () => ({ last_modified: 'new-version' }),
          })
        }
        // window ごとに固有の contentId を返す（重複なし・境界なし）
        const u = new URL(url)
        const gte = u.searchParams.get('filters[startTime][gte]')
        const year = gte ? gte.slice(0, 4) : '0'
        return Promise.resolve({
          status: 200,
          json: async () => ({
            meta: { status: 200 },
            data:
              year >= '2012' && year <= '2013'
                ? [
                    {
                      contentId: `so${year}`,
                      channelId: 2632720,
                      startTime: `${year}-06-01T00:00:00+09:00`,
                    },
                  ]
                : [],
          }),
        })
      })
    )

    const result = await fetchAllBranchEpisodes(null, 2013)
    expect(result.skipped).toBe(false)
    expect(versionCalled).toBe(true)
    // 2012と2013の各1件 = 合計2件（重複なし）
    expect(result.episodes).toHaveLength(2)
    const ids = result.episodes.map((e) => e.contentId)
    expect(new Set(ids).size).toBe(ids.length) // id dedup
  })
})
