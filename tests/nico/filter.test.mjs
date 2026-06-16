import { describe, it, expect } from 'vitest'
import { filterBranchEpisodes, BRANCH_CHANNEL_ID } from '../../scripts/nico/filter.mjs'

const branch = { contentId: 'so1', channelId: 2632720 }
const other = { contentId: 'so2', channelId: 9999999 }
const branchStr = { contentId: 'so3', channelId: '2632720' } // 文字列でも通る

describe('filterBranchEpisodes (F-0007)', () => {
  it('test_branch_filter_excludes_non_2632720 (AC-1)', () => {
    const mixed = [branch, other, other, branchStr]
    const result = filterBranchEpisodes(mixed)
    expect(result).toHaveLength(2)
    expect(result.map((e) => e.contentId)).toEqual(['so1', 'so3'])
  })

  it('test_branch_only_rows_inserted (AC-3): N+M 件 → 支店 N 件のみ', () => {
    const n = 3
    const m = 2
    const episodes = [
      ...Array.from({ length: n }, (_, i) => ({
        contentId: `so${i}`,
        channelId: BRANCH_CHANNEL_ID,
      })),
      ...Array.from({ length: m }, (_, i) => ({ contentId: `so${n + i}`, channelId: 0 })),
    ]
    const result = filterBranchEpisodes(episodes)
    expect(result).toHaveLength(n)
  })

  it('contentId 直引き（filter 可能）のシミュレーション (AC-2)', () => {
    // contentId を直引きした場合は1件のみ
    const single = [{ contentId: 'so12345', channelId: 2632720 }]
    const result = filterBranchEpisodes(single)
    expect(result).toHaveLength(1)
    expect(result[0].contentId).toBe('so12345')
  })
})
