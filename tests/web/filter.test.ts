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
  episodeCount: 12, // 既定は有効な作品（§59 の空シェル除外＝episodeCount 0 に該当しない）
  relatedSeries: [],
}

const BASE_STATE: ListState = {
  q: '',
  row: '',
  tags: [],
  cours: '',
  sort: 'hot',
  dir: 'desc',
  size: 48,
  page: 1,
  dur: '',
  year: '',
}

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
    const result = filterWorks(WORKS, { ...BASE_STATE, tags: ['日常'] })
    expect(result).toHaveLength(2)
    expect(result.map((w) => w.seriesId).sort()).toEqual([1, 3])
  })

  it('タグ照合は NFKC で半角/全角カナのズレを吸収する（§82）', () => {
    const works: Work[] = [
      { ...BASE_WORK, seriesId: 1, tags: ['2期→ﾘｽﾞ≒誓い移動用'] }, // 格納＝半角カナ
      { ...BASE_WORK, seriesId: 2, tags: ['無関係'] },
    ]
    // URL 由来 state.tags が全角カナでも一致する
    const r = filterWorks(works, { ...BASE_STATE, tags: ['2期→リズ≒誓い移動用'] })
    expect(r.map((w) => w.seriesId)).toEqual([1])
  })

  it('タグ照合は全角/半角括弧のズレを吸収する（§82）', () => {
    const works: Work[] = [{ ...BASE_WORK, seriesId: 1, tags: ['総集編（届け）'] }] // 全角括弧
    const r = filterWorks(works, { ...BASE_STATE, tags: ['総集編(届け)'] }) // 半角括弧
    expect(r.map((w) => w.seriesId)).toEqual([1])
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
    const result = filterWorks(WORKS, { ...BASE_STATE, row: 'は', tags: ['日常'] })
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

  it('avgViews ソートは 1 話あたり平均で並ぶ＝短尺高人気が累計順より上位（§86）', () => {
    const w: Work[] = [
      // 累計は多いが多話＝平均低
      { ...BASE_WORK, seriesId: 1, totalViews: 1200, episodeCount: 12 }, // 平均 100
      // 累計は少ないが少話＝平均高
      { ...BASE_WORK, seriesId: 2, totalViews: 600, episodeCount: 2 }, // 平均 300
      { ...BASE_WORK, seriesId: 3, totalViews: 300, episodeCount: 3 }, // 平均 100
    ]
    const byViews = sortWorks(w, 'views', null).map((x) => x.seriesId)
    const byAvg = sortWorks(w, 'avgViews', null).map((x) => x.seriesId)
    expect(byViews[0]).toBe(1) // 累計順は seriesId 1（1200）が先頭
    expect(byAvg[0]).toBe(2) // 平均順は seriesId 2（平均300）が先頭＝別順序
  })

  it('avgComments ソートは 1 話あたり平均コメントで並ぶ（§86）', () => {
    const w: Work[] = [
      { ...BASE_WORK, seriesId: 1, commentTotal: 100, episodeCount: 10 }, // 平均 10
      { ...BASE_WORK, seriesId: 2, commentTotal: 50, episodeCount: 1 }, // 平均 50
    ]
    expect(sortWorks(w, 'avgComments', null).map((x) => x.seriesId)).toEqual([2, 1])
  })

  it('avg ソートは話数 0 を 0 として扱う（除算ガード・§86）', () => {
    const w: Work[] = [
      { ...BASE_WORK, seriesId: 1, totalViews: 1000, episodeCount: 0 },
      { ...BASE_WORK, seriesId: 2, totalViews: 10, episodeCount: 1 },
    ]
    expect(sortWorks(w, 'avgViews', null).map((x) => x.seriesId)).toEqual([2, 1])
  })

  it('views ソートは totalViews（全作品横断・§79）を ranking より優先する', () => {
    const worksWithViews: Work[] = [
      { ...BASE_WORK, seriesId: 3, totalViews: 50 },
      { ...BASE_WORK, seriesId: 1, totalViews: 999 }, // ranking 外でも totalViews 最大なら先頭
      { ...BASE_WORK, seriesId: 2, totalViews: 200 },
    ]
    // ranking.popular は別順だが totalViews が優先される
    const ranking: RankingJson = {
      ...BASE_RANKING,
      popular: [{ seriesId: 3, title: '', thumbnailUrl: null, totalViews: 50, hotScore: null }],
    }
    const result = sortWorks(worksWithViews, 'views', ranking).map((w) => w.seriesId)
    expect(result).toEqual([1, 2, 3])
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

  it('§59: episodeCount 0 の空シェルは一覧から除外される', () => {
    const works = [
      { ...BASE_WORK, seriesId: 1, episodeCount: 12 },
      { ...BASE_WORK, seriesId: 2, episodeCount: 0 }, // 空シェル
      { ...BASE_WORK, seriesId: 3, episodeCount: 3 },
    ]
    const result = filterWorks(works, BASE_STATE)
    expect(result.map((w) => w.seriesId)).toEqual([1, 3])
  })
})

describe('paginateWorks', () => {
  // PAGE_SIZE 変更に追従するよう件数は PAGE_SIZE 相対（2 ページ目が必ず存在する数）
  const TOTAL = PAGE_SIZE + 10
  const works: Work[] = Array.from({ length: TOTAL }, (_, i) => ({
    ...BASE_WORK,
    seriesId: i + 1,
    title: `作品${i + 1}`,
  }))

  it('1ページ目は最初の PAGE_SIZE 件', () => {
    const { items, totalCount, totalPages } = paginateWorks(works, 1)
    expect(items).toHaveLength(PAGE_SIZE)
    expect(items[0].seriesId).toBe(1)
    expect(totalCount).toBe(TOTAL)
    expect(totalPages).toBe(Math.ceil(TOTAL / PAGE_SIZE))
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
