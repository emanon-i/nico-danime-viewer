// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderDetail } from '../../web/src/features/detail/detail'
import type { SeriesDetail } from '../../web/src/data/types'

const FULL_SERIES: SeriesDetail = {
  seriesId: 1,
  title: 'ゆるキャン△',
  thumbnailUrl: null,
  descriptionFirst: null,
  tags: ['日常', 'ほのぼの'],
  cours: '2026-春',
  colKey: 'yu',
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

describe('F-0039: empty／欠損表示', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  it('test_empty_message_render: series=null で empty メッセージが表示される', () => {
    renderDetail(container, null)
    const emptyEl = container.querySelector('[data-part="empty"]')
    expect(emptyEl).not.toBeNull()
    expect(emptyEl?.textContent).toMatch(/取得できません|配信終了/)
  })

  it('test_empty_message_render: episodes が空のとき各話 empty メッセージが出る', () => {
    renderDetail(container, { ...FULL_SERIES, episodes: [] })
    const emptyEl = container.querySelector('[data-part="empty"]')
    expect(emptyEl).not.toBeNull()
  })

  it('test_empty_shows_partial_only: タグありの作品は各話が空でもタグが表示される', () => {
    renderDetail(container, { ...FULL_SERIES, episodes: [] })
    const tagChips = container.querySelectorAll('.tag-chip')
    expect(tagChips.length).toBeGreaterThan(0)
  })

  it('test_empty_shows_partial_only: 生存している公式リンクが表示される', () => {
    renderDetail(container, { ...FULL_SERIES, episodes: [] })
    const officialLink = container.querySelector('.official-series-link')
    expect(officialLink).not.toBeNull()
  })

  it('test_empty_shows_partial_only: series=null のとき各話リンクが存在しない', () => {
    renderDetail(container, null)
    expect(container.querySelector('.watch-link')).toBeNull()
    expect(container.querySelector('[data-action="watch"]')).toBeNull()
  })

  it('test_empty_does_not_break_app: series=null でも renderDetail が例外を投げない', () => {
    expect(() => renderDetail(container, null)).not.toThrow()
  })

  it('test_empty_does_not_break_app: episodes 空でも例外を投げない', () => {
    expect(() => renderDetail(container, { ...FULL_SERIES, episodes: [] })).not.toThrow()
  })

  it('test_empty_does_not_break_app: tags 空でも例外を投げない', () => {
    expect(() => renderDetail(container, { ...FULL_SERIES, tags: [] })).not.toThrow()
  })

  it('test_empty_does_not_break_app: descriptionFirst null でも例外を投げない', () => {
    expect(() => renderDetail(container, { ...FULL_SERIES, descriptionFirst: null })).not.toThrow()
  })
})
