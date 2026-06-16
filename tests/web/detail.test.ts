// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderDetail } from '../../web/src/features/detail/detail'
import type { SeriesDetail } from '../../web/src/data/types'

const SERIES: SeriesDetail = {
  seriesId: 1,
  title: 'ゆるキャン△',
  thumbnailUrl: null,
  descriptionFirst: '第1話のあらすじテスト',
  tags: ['日常', 'ほのぼの'],
  cours: '2026春',
  colKey: 'yu',
  relatedSeries: [{ seriesId: 2, title: '続編', thumbnailUrl: null }],
  episodes: [
    {
      contentId: 'so1001',
      episodeNo: 1,
      title: '第1話',
      viewCounter: 1000,
      startTime: '2026-01-01T00:00:00+09:00',
      thumbnailUrl: null,
    },
    {
      contentId: 'so1002',
      episodeNo: 2,
      title: '第2話',
      viewCounter: 800,
      startTime: '2026-01-08T00:00:00+09:00',
      thumbnailUrl: null,
    },
  ],
}

describe('renderDetail (F-0025)', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  it('test_detail_episode_list_order: 各話が話順で描画され、各話に公式 watch リンクがある', () => {
    renderDetail(container, SERIES)
    const episodes = container.querySelectorAll('[data-part="episode"]')
    expect(episodes.length).toBe(2)
    expect(episodes[0].getAttribute('data-episode-no')).toBe('1')
    expect(episodes[1].getAttribute('data-episode-no')).toBe('2')
    // 各話に watch リンク
    const watchLink = episodes[0].querySelector('[data-action="watch"]')
    expect(watchLink?.getAttribute('href')).toBe('https://www.nicovideo.jp/watch/so1001')
  })

  it('test_detail_no_genre: genre 欄を表示しない', () => {
    renderDetail(container, SERIES)
    expect(container.querySelector('[data-field="genre"]')).toBeNull()
    expect(container.textContent).not.toMatch(/ジャンル/)
  })

  it('test_detail_related_series_render_and_hide: 関連シリーズが非空なら描画される', () => {
    renderDetail(container, SERIES)
    const relatedSection = container.querySelector('[data-section="related"]')
    expect(relatedSection).not.toBeNull()
    expect(relatedSection?.getAttribute('hidden')).toBeNull()
  })

  it('test_detail_related_series_render_and_hide: 関連シリーズが空なら hidden になる', () => {
    renderDetail(container, { ...SERIES, relatedSeries: [] })
    const relatedSection = container.querySelector('[data-section="related"]')
    const isHidden = !relatedSection || relatedSection.getAttribute('hidden') !== null
    expect(isHidden).toBe(true)
  })

  it('test_detail_related_series_links: 関連シリーズのリンクがシリーズ詳細へ遷移する', () => {
    renderDetail(container, SERIES)
    const links = container.querySelectorAll(
      '[data-section="related"] [data-action="related-series"]'
    )
    expect(links.length).toBeGreaterThan(0)
    expect(links[0].getAttribute('href')).toContain('series=2')
  })

  it('test_detail_empty_state: 各話なしで empty 表示になる', () => {
    renderDetail(container, { ...SERIES, episodes: [] })
    const emptyEl = container.querySelector('[data-part="empty"]')
    expect(emptyEl).not.toBeNull()
  })

  it('series が null でも empty 表示になる', () => {
    renderDetail(container, null)
    const emptyEl = container.querySelector('[data-part="empty"]')
    expect(emptyEl).not.toBeNull()
  })

  it('タグチップが一覧のタグ絞りへリンクする', () => {
    renderDetail(container, SERIES)
    const tagChips = container.querySelectorAll('.tag-chip')
    expect(tagChips.length).toBe(2)
    const firstHref = tagChips[0].getAttribute('href')
    expect(firstHref).toContain('tag=')
  })
})
