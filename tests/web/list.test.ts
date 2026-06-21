// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderList } from '../../web/src/features/list/list'
import type { Work } from '../../web/src/data/types'
import type { ListState } from '../../web/src/features/router'

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
    episodeCount: 0,
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
    episodeCount: 0,
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
    const primaryLink = card?.querySelector('.card-body')
    expect(primaryLink?.getAttribute('href')).toContain('series=')
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

  it('カード常時メタ＝話数・総再生回数・投稿日（マイリスは出さない・§93）', () => {
    const work: Work = {
      seriesId: 10,
      title: 'メタ確認',
      thumbnailUrl: null,
      descriptionFirst: null,
      tags: [],
      cours: null,
      franchiseKey: null,
      colKey: 'sa',
      episodeCount: 12,
      latestAt: '2026-01-01T00:00:00+09:00',
      totalViews: 3080000,
      mylistFirst: 2707,
      relatedSeries: [],
    }
    renderList(container, { state: BASE_STATE, works: [work], totalCount: 1, totalPages: 1 })
    const cap = container.querySelector('.card-caption')
    const labels = [...(cap?.querySelectorAll('.meta') ?? [])].map((e) =>
      e.getAttribute('aria-label')
    )
    expect(labels.some((l) => l?.includes('全12話'))).toBe(true)
    expect(labels.some((l) => l?.includes('総再生回数'))).toBe(true)
    expect(labels.some((l) => l?.includes('投稿'))).toBe(true)
    // マイリスは常時メタから外れた（§93）
    expect(labels.some((l) => l?.includes('マイリスト'))).toBe(false)
  })
})

describe('renderList - フィルタ・ソートUI (F-0028/0029/0030/0031)', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  it('五十音ボタンが ?row=... の href を持つ（F-0028）', () => {
    renderList(container, { state: BASE_STATE, works: [], totalCount: 0, totalPages: 1 })
    const saBtn = Array.from(container.querySelectorAll('.kana-btn')).find(
      (b) => b.textContent === 'さ'
    )
    expect(saBtn?.getAttribute('href')).toContain('row=%E3%81%95')
  })

  it('全ボタンは row なしのリスト URL を持つ（F-0028）', () => {
    renderList(container, {
      state: { ...BASE_STATE, row: 'さ' },
      works: [],
      totalCount: 0,
      totalPages: 1,
    })
    const allBtn = Array.from(container.querySelectorAll('.kana-btn')).find(
      (b) => b.textContent === '全'
    )
    const href = allBtn?.getAttribute('href') ?? ''
    expect(href).not.toContain('row=')
  })

  it('選択中の五十音ボタンが active クラスを持つ（F-0028）', () => {
    renderList(container, {
      state: { ...BASE_STATE, row: 'さ' },
      works: [],
      totalCount: 0,
      totalPages: 1,
    })
    const activeBtn = container.querySelector('.kana-btn.active')
    expect(activeBtn?.textContent).toBe('さ')
  })

  it('test_tags_are_flat: タグフィルタに別 facet セクションがない（F-0029）', () => {
    const data = {
      tags: [
        { name: '日常', isCurated: true, seriesCount: 10 },
        { name: 'ほのぼの', isCurated: false, seriesCount: 5 },
      ],
      cours: [],
    }
    renderList(container, { state: BASE_STATE, works: [], totalCount: 0, totalPages: 1, data })
    const filterTags = container.querySelector('.filter-tags')
    expect(filterTags?.querySelector('.filter-curated')).toBeNull()
    expect(filterTags?.querySelector('[data-curated-only]')).toBeNull()
    const items = filterTags?.querySelectorAll('.filter-tag-item')
    expect(items?.length).toBe(2)
  })

  it('test_no_period_selector: 期間セレクタが存在しない（F-0031）', () => {
    renderList(container, { state: BASE_STATE, works: [], totalCount: 0, totalPages: 1 })
    expect(container.querySelector('.period-selector')).toBeNull()
    expect(container.querySelector('[data-period]')).toBeNull()
    expect(container.querySelector('select[name="period"]')).toBeNull()
  })

  it('sort ラジオボタンが5種あり選択状態が反映される（§19・総コメント数追加）', () => {
    renderList(container, {
      state: { ...BASE_STATE, sort: 'views' },
      works: [],
      totalCount: 0,
      totalPages: 1,
    })
    const radios = container.querySelectorAll<HTMLInputElement>('input[name="sort"]')
    // kana/hot/views/avgViews/new/created/comments/avgComments の 8 種（行優先順・§21/§86）
    expect(radios.length).toBe(8)
    const values = Array.from(radios).map((r) => r.value)
    expect(values).toContain('comments')
    expect(values).toContain('created')
    expect(values).toContain('avgViews')
    expect(values).toContain('avgComments')
    const checked = Array.from(radios).find((r) => r.checked)
    expect(checked?.value).toBe('views')
  })

  it('クールフィルタが ListData から描画される（F-0030）', () => {
    const data = {
      tags: [],
      cours: [
        { cours: '2026-春', seriesIds: [1, 2] },
        { cours: '2025-秋', seriesIds: [3] },
      ],
    }
    renderList(container, { state: BASE_STATE, works: [], totalCount: 0, totalPages: 1, data })
    const coursItems = container.querySelectorAll('.filter-cours-item')
    expect(coursItems.length).toBe(2)
  })
})
