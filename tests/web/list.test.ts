// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderList } from '../../web/src/features/list/list'
import type { Work } from '../../web/src/data/types'
import type { ListState } from '../../web/src/features/router'

const BASE_STATE: ListState = { q: '', row: '', tag: '', cours: '', sort: 'hot', page: 1 }

const SAMPLE_WORKS: Work[] = [
  {
    seriesId: 1,
    title: '作品A',
    thumbnailUrl: null,
    descriptionFirst: null,
    tags: ['日常'],
    cours: '2026春',
    franchiseKey: null,
    colKey: 'sa',
    relatedSeries: [],
  },
  {
    seriesId: 2,
    title: '作品B',
    thumbnailUrl: null,
    descriptionFirst: null,
    tags: [],
    cours: null,
    franchiseKey: null,
    colKey: 'sa',
    relatedSeries: [],
  },
]

describe('renderList (F-0024)', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  it('test_list_layout_render: 検索バー・五十音・フィルタ・グリッド・ページングが描画される', () => {
    renderList(container, { state: BASE_STATE, works: SAMPLE_WORKS, totalCount: 2, totalPages: 1 })
    expect(container.querySelector('[data-part="search"]')).not.toBeNull()
    expect(container.querySelector('[data-part="kana"]')).not.toBeNull()
    expect(container.querySelector('[data-part="filter"]')).not.toBeNull()
    expect(container.querySelector('[data-part="grid"]')).not.toBeNull()
    expect(container.querySelector('[data-part="pagination"]')).not.toBeNull()
  })

  it('test_card_primary_secondary_action: カードの主副アクションが分離している', () => {
    renderList(container, { state: BASE_STATE, works: SAMPLE_WORKS, totalCount: 2, totalPages: 1 })
    const card = container.querySelector('.series-card')
    expect(card).not.toBeNull()
    // 主: カード本体 → 詳細（?series=<id>）
    const primaryLink = card?.querySelector('.card-body')
    expect(primaryLink?.getAttribute('href')).toContain('series=')
    // 副: [↗] → 公式 series
    const extLink = card?.querySelector('.card-external')
    expect(extLink?.getAttribute('href')).toContain('nicovideo.jp/series/')
  })

  it('test_pagination_not_infinite_scroll: ページングは前/次ボタンで、無限スクロール要素なし', () => {
    renderList(container, {
      state: { ...BASE_STATE, page: 2 },
      works: SAMPLE_WORKS,
      totalCount: 20,
      totalPages: 5,
    })
    const pagination = container.querySelector('[data-part="pagination"]')
    expect(pagination?.querySelector('[data-nav="prev"]')).not.toBeNull()
    expect(pagination?.querySelector('[data-nav="next"]')).not.toBeNull()
    // 無限スクロールセンチネルが存在しない
    expect(container.querySelector('[data-infinite-scroll]')).toBeNull()
    expect(container.querySelector('.infinite-scroll-trigger')).toBeNull()
  })

  it('五十音ボタンが全行分ある（あ〜わ + 全 = 11個）', () => {
    renderList(container, { state: BASE_STATE, works: [], totalCount: 0, totalPages: 1 })
    const kanaBtns = container.querySelectorAll('[data-part="kana"] .kana-btn')
    expect(kanaBtns.length).toBe(11)
  })

  it('cards が 0 件でも描画がクラッシュしない', () => {
    expect(() =>
      renderList(container, { state: BASE_STATE, works: [], totalCount: 0, totalPages: 1 })
    ).not.toThrow()
  })
})
