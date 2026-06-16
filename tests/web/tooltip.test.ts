// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderTop } from '../../web/src/features/top/top'
import { renderList } from '../../web/src/features/list/list'
import { renderDetail } from '../../web/src/features/detail/detail'
import type { ListState } from '../../web/src/features/router'
import { card as createSeriesCard } from '../../web/src/components/card'
import type { SeriesDetail } from '../../web/src/data/types'

const BASE_STATE: ListState = { q: '', row: '', tag: '', cours: '', sort: 'hot', page: 1 }

const SERIES: SeriesDetail = {
  seriesId: 1,
  title: 'テスト',
  thumbnailUrl: null,
  descriptionFirst: null,
  tags: [],
  cours: null,
  colKey: null,
  relatedSeries: [],
  episodes: [
    {
      contentId: 'so1',
      episodeNo: 1,
      title: 'ep1',
      viewCounter: 100,
      startTime: '',
      thumbnailUrl: null,
    },
  ],
}

describe('F-0037: ⓘ ツールチップ（各画面1か所集約）', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  it('test_info_tooltip_single_per_screen: トップ画面の .info-btn が1個', () => {
    renderTop(container)
    const infoBtns = container.querySelectorAll('.info-btn')
    expect(infoBtns.length).toBe(1)
  })

  it('test_info_tooltip_single_per_screen: 一覧画面の .info-btn が1個', () => {
    renderList(container, { state: BASE_STATE, works: [], totalCount: 0, totalPages: 1 })
    const infoBtns = container.querySelectorAll('.info-btn')
    expect(infoBtns.length).toBe(1)
  })

  it('test_info_tooltip_single_per_screen: 詳細画面の .info-btn が1個', () => {
    renderDetail(container, SERIES)
    const infoBtns = container.querySelectorAll('.info-btn')
    expect(infoBtns.length).toBe(1)
  })

  it('test_info_tooltip_copy: トップ画面の ⓘ は TOP10 見出しにある', () => {
    renderTop(container)
    const top10Section = container.querySelector('[data-section="top10"]')
    expect(top10Section?.querySelector('.info-btn')).not.toBeNull()
  })

  it('test_info_tooltip_copy: 一覧画面の ⓘ は並び替えセクションにある', () => {
    renderList(container, { state: BASE_STATE, works: [], totalCount: 0, totalPages: 1 })
    const sortSection = container.querySelector('.filter-sort')
    expect(sortSection?.querySelector('.info-btn')).not.toBeNull()
  })

  it('test_info_tooltip_copy: 詳細画面の ⓘ はメタセクション (h1) にある', () => {
    renderDetail(container, SERIES)
    const metaSection = container.querySelector('[data-section="meta"]')
    expect(metaSection?.querySelector('.info-btn')).not.toBeNull()
  })

  it('test_no_per_field_tooltip: シリーズカード内に .info-btn がない', () => {
    renderTop(container)
    const cards = container.querySelectorAll('.series-card')
    cards.forEach((card) => {
      expect(card.querySelector('.info-btn')).toBeNull()
    })
  })

  it('test_no_per_field_tooltip: タグチップに .info-btn がない', () => {
    renderDetail(container, { ...SERIES, tags: ['日常', 'ほのぼの'] })
    const chips = container.querySelectorAll('.tag-chip')
    chips.forEach((chip) => {
      expect(chip.querySelector('.info-btn')).toBeNull()
    })
  })

  it('test_info_tooltip_copy: トップ画面の ⓘ に利用者向け文言が含まれる（screens.md 指定）', () => {
    renderTop(container)
    const infoBtn = container.querySelector('.info-btn')
    const title = infoBtn?.getAttribute('title') ?? ''
    expect(title).toContain('Hot')
    expect(title).toContain('人気TOP')
    expect(title).toContain('目安')
  })

  it('test_info_tooltip_copy: 一覧の ⓘ に利用者向け文言が含まれる（screens.md 指定）', () => {
    renderList(container, { state: BASE_STATE, works: [], totalCount: 0, totalPages: 1 })
    const infoBtn = container.querySelector('.info-btn')
    const title = infoBtn?.getAttribute('title') ?? ''
    expect(title).toContain('Hot')
    expect(title).toContain('目安')
  })

  it('test_info_tooltip_copy: 詳細画面の ⓘ に利用者向け文言が含まれる（screens.md 指定）', () => {
    renderDetail(container, SERIES)
    const infoBtn = container.querySelector('.info-btn')
    const title = infoBtn?.getAttribute('title') ?? ''
    expect(title).toContain('第1話のあらすじ')
    expect(title).toContain('ニコニコ')
  })

  it('test_tap_targets_separate: .card-favorite（左上）と .card-external（右上）は別要素', () => {
    const card = createSeriesCard(1, 'テスト', null, 'https://nicovideo.jp/series/1')
    const favEl = card.querySelector('.card-favorite')
    const extEl = card.querySelector('.card-external')
    expect(favEl).not.toBeNull()
    expect(extEl).not.toBeNull()
    expect(favEl).not.toBe(extEl)
    // ♥ は card-external クラスを持たず、↗ は card-favorite クラスを持たない
    expect(favEl?.classList.contains('card-external')).toBe(false)
    expect(extEl?.classList.contains('card-favorite')).toBe(false)
  })
})
