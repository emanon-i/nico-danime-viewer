import { describe, it, expect } from 'vitest'
import {
  filterWorks,
  sortWorks,
  paginateWorks,
  colKeyMatchesRow,
  currentCoursLabel,
  PAGE_SIZE,
} from '../../web/src/features/list/filter'
import type { FilterOpts } from '../../web/src/features/list/filter'
import type { Work, RankingJson } from '../../web/src/data/types'
import type { ListState } from '../../web/src/features/router'

const BASE_WORK: Work = {
  seriesId: 0,
  title: '',
  thumbnailUrl: null,
  descriptionFirst: null,
  tags: [],
  cours: null,
  franchiseKey: null,
  colKey: null,
  episodeCount: 0,
  relatedSeries: [],
}

const BASE_STATE: ListState = { q: '', row: '', tag: '', cours: '', sort: 'hot', page: 1 }

const BASE_RANKING: RankingJson = {
  lastUpdated: '2026-06-16T00:00:00Z',
  hot: [],
  popular: [],
}

describe('colKeyMatchesRow（col_key は行 char そのもの）', () => {
  it('null は常に false', () => {
    expect(colKeyMatchesRow(null, 'さ')).toBe(false)
  })

  it('未知の行は false', () => {
    expect(colKeyMatchesRow('さ', 'x')).toBe(false)
  })

  it('さ行: col_key=さ が一致する', () => {
    expect(colKeyMatchesRow('さ', 'さ')).toBe(true)
  })

  it('さ行: col_key=や は不一致', () => {
    expect(colKeyMatchesRow('や', 'さ')).toBe(false)
  })

  it('や行: col_key=や が一致する', () => {
    expect(colKeyMatchesRow('や', 'や')).toBe(true)
  })

  it('前後空白は無視する', () => {
    expect(colKeyMatchesRow(' さ ', 'さ')).toBe(true)
  })

  it('な行とわ行は別行で混入しない（H-2 回帰）', () => {
    expect(colKeyMatchesRow('な', 'な')).toBe(true)
    expect(colKeyMatchesRow('な', 'わ')).toBe(false)
    expect(colKeyMatchesRow('わ', 'わ')).toBe(true)
    expect(colKeyMatchesRow('わ', 'な')).toBe(false)
  })
})

describe('currentCoursLabel', () => {
  it('YYYY-季 の形式を返す', () => {
    expect(currentCoursLabel()).toMatch(/^\d{4}-(冬|春|夏|秋)$/)
  })
})

describe('filterWorks (F-0028/0029/0030)', () => {
  const WORKS: Work[] = [
    { ...BASE_WORK, seriesId: 1, title: 'さくら', colKey: 'さ', tags: ['日常'], cours: '2026-春' },
    {
      ...BASE_WORK,
      seriesId: 2,
      title: 'やまと',
      colKey: 'や',
      tags: ['アクション'],
      cours: '2025-秋',
    },
    { ...BASE_WORK, seriesId: 3, title: 'はなこ', colKey: 'は', tags: ['日常'], cours: null },
  ]

  it('test_kana_row_filter: さ行で絞ると colKey=sa のみ', () => {
    const result = filterWorks(WORKS, { ...BASE_STATE, row: 'さ' })
    expect(result).toHaveLength(1)
    expect(result[0].seriesId).toBe(1)
  })

  it('test_tag_filter: タグ絞りが機能する', () => {
    const result = filterWorks(WORKS, { ...BASE_STATE, tag: '日常' })
    expect(result).toHaveLength(2)
    expect(result.map((w) => w.seriesId).sort()).toEqual([1, 3])
  })

  it('test_cours_filter: クール絞りが機能する', () => {
    const result = filterWorks(WORKS, { ...BASE_STATE, cours: '2026-春' })
    expect(result).toHaveLength(1)
    expect(result[0].seriesId).toBe(1)
  })

  it('test_current_cours_preset: cours=current が現行季に解決される', () => {
    const label = currentCoursLabel()
    const works: Work[] = [
      { ...BASE_WORK, seriesId: 1, cours: label },
      { ...BASE_WORK, seriesId: 2, cours: '2000-冬' },
      { ...BASE_WORK, seriesId: 3, cours: null },
    ]
    const result = filterWorks(works, { ...BASE_STATE, cours: 'current' })
    expect(result).toHaveLength(1)
    expect(result[0].seriesId).toBe(1)
  })

  it('test_cours_unknown_handling: cours=null の作品は季絞りに混入しない', () => {
    const result = filterWorks(WORKS, { ...BASE_STATE, cours: '2026-春' })
    expect(result.every((w) => w.cours !== null)).toBe(true)
  })

  it('test_filter_sort_combination: 複数フィルタを組み合わせられる', () => {
    const result = filterWorks(WORKS, { ...BASE_STATE, row: 'は', tag: '日常' })
    expect(result).toHaveLength(1)
    expect(result[0].seriesId).toBe(3)
  })

  it('q 検索: タイトルに部分一致する', () => {
    const result = filterWorks(WORKS, { ...BASE_STATE, q: 'さく' })
    expect(result).toHaveLength(1)
    expect(result[0].seriesId).toBe(1)
  })

  it('q 検索: タグに部分一致する', () => {
    const result = filterWorks(WORKS, { ...BASE_STATE, q: 'アクション' })
    expect(result).toHaveLength(1)
    expect(result[0].seriesId).toBe(2)
  })

  it('q が空なら全件返す', () => {
    expect(filterWorks(WORKS, { ...BASE_STATE, q: '' })).toHaveLength(3)
  })
})

describe('sortWorks (F-0031)', () => {
  const WORKS: Work[] = [
    { ...BASE_WORK, seriesId: 3, colKey: 'さ', title: 'A' },
    { ...BASE_WORK, seriesId: 1, colKey: 'や', title: 'Z' },
    { ...BASE_WORK, seriesId: 2, colKey: 'さ', title: 'B' },
  ]

  it('test_sort_options_deterministic: hot ソートが決定的', () => {
    const ranking: RankingJson = {
      ...BASE_RANKING,
      hot: [
        { seriesId: 1, title: 'Z', thumbnailUrl: null, totalViews: 100, hotScore: 10 },
        { seriesId: 2, title: 'B', thumbnailUrl: null, totalViews: 80, hotScore: 8 },
        { seriesId: 3, title: 'A', thumbnailUrl: null, totalViews: 60, hotScore: 6 },
      ],
    }
    const r1 = sortWorks(WORKS, 'hot', ranking).map((w) => w.seriesId)
    const r2 = sortWorks(WORKS, 'hot', ranking).map((w) => w.seriesId)
    expect(r1).toEqual(r2)
    expect(r1).toEqual([1, 2, 3])
  })

  it('test_sort_options_deterministic: views ソートが決定的', () => {
    const ranking: RankingJson = {
      ...BASE_RANKING,
      popular: [
        { seriesId: 3, title: 'A', thumbnailUrl: null, totalViews: 300, hotScore: null },
        { seriesId: 1, title: 'Z', thumbnailUrl: null, totalViews: 100, hotScore: null },
        { seriesId: 2, title: 'B', thumbnailUrl: null, totalViews: 80, hotScore: null },
      ],
    }
    const result = sortWorks(WORKS, 'views', ranking).map((w) => w.seriesId)
    expect(result).toEqual([3, 1, 2])
  })

  it('test_sort_options_deterministic: new ソートは seriesId 降順', () => {
    const result = sortWorks(WORKS, 'new', null).map((w) => w.seriesId)
    expect(result).toEqual([3, 2, 1])
  })

  it('test_kana_sort_row_then_title: kana ソートが行順＋タイトル順', () => {
    const result = sortWorks(WORKS, 'kana', null)
    // さ行 (3=A, 2=B) → や行 (1=Z)
    expect(result[0].colKey).toBe('さ')
    expect(result[1].colKey).toBe('さ')
    expect(result[2].colKey).toBe('や')
    // さ行内: title 'A' < 'B'
    expect(result[0].title).toBe('A')
    expect(result[1].title).toBe('B')
  })

  it('ranking なしで hot ソートを呼んでも例外を投げない', () => {
    expect(() => sortWorks(WORKS, 'hot', null)).not.toThrow()
  })

  it('ランキング外の作品は末尾に積まれる', () => {
    const ranking: RankingJson = {
      ...BASE_RANKING,
      hot: [{ seriesId: 1, title: '', thumbnailUrl: null, totalViews: 100, hotScore: 5 }],
    }
    const result = sortWorks(WORKS, 'hot', ranking).map((w) => w.seriesId)
    expect(result[0]).toBe(1) // ランキングあり
    // 残り2件はランキング外（末尾側）
  })
})

describe('filterWorks - favIds/watchedIds (F-0034)', () => {
  const WORKS: Work[] = [
    { ...BASE_WORK, seriesId: 1, title: 'A' },
    { ...BASE_WORK, seriesId: 2, title: 'B' },
    { ...BASE_WORK, seriesId: 3, title: 'C' },
  ]

  it('favIds が指定されると お気に入りのみに絞れる', () => {
    const opts: FilterOpts = { favIds: new Set([1, 3]) }
    const result = filterWorks(WORKS, BASE_STATE, opts)
    expect(result.map((w) => w.seriesId)).toEqual([1, 3])
  })

  it('watchedIds が指定されると 見た作品が除外される（未視聴だけ）', () => {
    const opts: FilterOpts = { watchedIds: new Set([2]) }
    const result = filterWorks(WORKS, BASE_STATE, opts)
    expect(result.map((w) => w.seriesId)).toEqual([1, 3])
  })

  it('favIds + watchedIds を組み合わせられる', () => {
    const opts: FilterOpts = { favIds: new Set([1, 2, 3]), watchedIds: new Set([2]) }
    const result = filterWorks(WORKS, BASE_STATE, opts)
    expect(result.map((w) => w.seriesId)).toEqual([1, 3])
  })

  it('opts なしは既存動作を維持する', () => {
    const result = filterWorks(WORKS, BASE_STATE)
    expect(result).toHaveLength(3)
  })
})

describe('paginateWorks', () => {
  const works: Work[] = Array.from({ length: 50 }, (_, i) => ({
    ...BASE_WORK,
    seriesId: i + 1,
    title: `作品${i + 1}`,
  }))

  it('1ページ目は最初の PAGE_SIZE 件', () => {
    const { items, totalCount, totalPages } = paginateWorks(works, 1)
    expect(items).toHaveLength(PAGE_SIZE)
    expect(items[0].seriesId).toBe(1)
    expect(totalCount).toBe(50)
    expect(totalPages).toBe(Math.ceil(50 / PAGE_SIZE))
  })

  it('2ページ目は PAGE_SIZE 番以降', () => {
    const { items } = paginateWorks(works, 2)
    expect(items[0].seriesId).toBe(PAGE_SIZE + 1)
  })

  it('空のリストでも totalPages が 1 になる', () => {
    const { totalPages } = paginateWorks([], 1)
    expect(totalPages).toBe(1)
  })

  it('page が範囲外でもクランプされる', () => {
    const { items } = paginateWorks(works, 99)
    expect(items.length).toBeGreaterThan(0) // 最後のページ
  })
})
