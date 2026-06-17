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
    const tagChips = container.querySelectorAll('.detail-tags .tag-chip')
    expect(tagChips.length).toBe(2)
    const firstHref = tagChips[0].getAttribute('href')
    expect(firstHref).toContain('tag=')
  })

  it('各話ドロワーに各話タグがチップ表示され、クール由来タグは除外される（§77）', () => {
    const withEpTags: SeriesDetail = {
      ...SERIES,
      episodes: [
        {
          ...SERIES.episodes[0],
          description: '各話あらすじ本文',
          tags: ['監督名', 'アクション/バトル', '2006年春アニメ'],
        },
        SERIES.episodes[1],
      ],
    }
    renderDetail(container, withEpTags)
    const tagsRow = container.querySelector('.episode-detail-tags')
    expect(tagsRow).not.toBeNull()
    const chips = [...tagsRow!.querySelectorAll('.tag-chip')].map((c) => c.textContent)
    // クールタグ「2006年春アニメ」は除外され、残り 2 件のみ
    expect(chips).toEqual(['監督名', 'アクション/バトル'])
    // クリックで ?tag= へ
    expect(tagsRow!.querySelector('.tag-chip')?.getAttribute('href')).toContain('tag=')
  })

  it('各話タグの構造的定番（最終回）は除外・神回や内容タグは残す（§C）', () => {
    const withStructural: SeriesDetail = {
      ...SERIES,
      episodes: [
        { ...SERIES.episodes[0], tags: ['最終回', '神回', '水着回', 'アクション/バトル'] },
        SERIES.episodes[1],
      ],
    }
    renderDetail(container, withStructural)
    const chips = [...container.querySelectorAll('.episode-detail-tags .tag-chip')].map(
      (c) => c.textContent
    )
    // 最終回（全作品共通の構造）は消え、神回・水着回・ジャンルは残る
    expect(chips).toEqual(['神回', '水着回', 'アクション/バトル'])
  })

  it('各話タグが全てクール由来なら tags 行を出さない（§77）', () => {
    const onlyCours: SeriesDetail = {
      ...SERIES,
      episodes: [
        { ...SERIES.episodes[0], tags: ['2006年春アニメ', '2007年冬アニメ'] },
        SERIES.episodes[1],
      ],
    }
    renderDetail(container, onlyCours)
    expect(container.querySelector('.episode-detail-tags')).toBeNull()
  })

  it('シリーズメタに 1 話あたり平均（再生数・コメント）が表示される（§81）', () => {
    const withCounts: SeriesDetail = {
      ...SERIES,
      episodes: [
        { ...SERIES.episodes[0], viewCounter: 1000, commentCounter: 40 },
        { ...SERIES.episodes[1], viewCounter: 800, commentCounter: 20 },
      ],
    }
    renderDetail(container, withCounts)
    const labels = [...container.querySelectorAll('.detail-series-meta .meta')].map((e) =>
      e.getAttribute('aria-label')
    )
    // 平均再生数 = round((1000+800)/2)=900、平均コメント = round((40+20)/2)=30
    expect(labels.some((l) => l?.includes('平均再生数') && l?.includes('900'))).toBe(true)
    expect(labels.some((l) => l?.includes('平均コメント数') && l?.includes('30'))).toBe(true)
  })
})
