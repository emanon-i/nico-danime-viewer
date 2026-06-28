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

  it('credits を「演者/制作」1 行・全タグ均一クリック可・重複除去・?credit=key リンク', () => {
    renderDetail(container, {
      ...SERIES,
      // 声優・スタッフ人名・制作会社・原作者を統合した1列。全タグ均一クリック可・key で照合。
      // 重複（杉山紀彰/ufotable は key で1つに）。TYPE-MOON は表示名と key（正規化）が異なる。
      // 三浦貴博は他作品に出ない人物でも同じくクリック可能（recurrence で差別化しない）。
      credits: [
        { name: '杉山紀彰', key: '杉山紀彰' },
        { name: '川澄綾子', key: '川澄綾子' },
        { name: '杉山紀彰', key: '杉山紀彰' },
        { name: '奈須きのこ', key: '奈須きのこ' },
        { name: 'TYPE-MOON', key: 'type-moon' },
        { name: 'ufotable', key: 'ufotable' },
        { name: 'ufotable', key: 'ufotable' },
        { name: '三浦貴博', key: '三浦貴博' },
      ],
    })
    // 行は1つ（演者/制作の統合）。見出しに「演者/制作」。
    const rows = container.querySelectorAll('.detail-credit-row')
    expect(rows.length).toBe(1)
    const label = (rows[0].querySelector('.detail-credit-label')?.textContent || '').trim()
    expect(label).toContain('演者/制作')
    // 全チップが統合・重複除去された名前列で並ぶ
    const chips = [...rows[0].querySelectorAll('.credit-chip')].map((c) => c.textContent)
    expect(chips).toEqual([
      '杉山紀彰',
      '川澄綾子',
      '奈須きのこ',
      'TYPE-MOON',
      'ufotable',
      '三浦貴博',
    ])
    // (i) は1つ（統合した見出しに1つ）
    expect(container.querySelectorAll('.detail-credits .info-btn').length).toBe(1)
    // 全タグが <a> でクリック可（singleton 非クリックは廃止）。href は ?credit=<key>。
    const links = [...rows[0].querySelectorAll('a.credit-chip')]
    expect(links.length).toBe(6)
    expect(container.querySelector('.credit-chip--singleton')).toBeNull()
    const typeMoon = links.find((c) => c.textContent === 'TYPE-MOON') as HTMLAnchorElement
    expect(decodeURIComponent(typeMoon.getAttribute('href') || '')).toContain('credit=type-moon')
    // 他作品に出ない人物も同じくクリック可能（<a>）。
    const lone = links.find((c) => c.textContent === '三浦貴博') as HTMLAnchorElement
    expect(lone.tagName).toBe('A')
    expect(decodeURIComponent(lone.getAttribute('href') || '')).toContain('credit=三浦貴博')
  })

  it('credits が空なら credits セクション自体を出さない', () => {
    renderDetail(container, { ...SERIES, credits: [] })
    expect(container.querySelector('.detail-credits')).toBeNull()
  })

  it('旧 JSON（credits フィールド無し）でも例外を投げない', () => {
    expect(() => renderDetail(container, SERIES)).not.toThrow()
    expect(container.querySelector('.detail-credits')).toBeNull()
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

  it('シリーズメタが実値ラベル表示（総再生数カンマ区切り＋1話あたり平均・§81/§F）', () => {
    const withCounts: SeriesDetail = {
      ...SERIES,
      episodes: [
        { ...SERIES.episodes[0], viewCounter: 1000000, commentCounter: 40 },
        { ...SERIES.episodes[1], viewCounter: 800000, commentCounter: 20 },
      ],
    }
    renderDetail(container, withCounts)
    const labels = [...container.querySelectorAll('.detail-series-meta .detail-meta-item')].map(
      (e) => e.getAttribute('aria-label')
    )
    // 総再生数は丸めずカンマ区切り実値（1,800,000）
    expect(labels.some((l) => l?.includes('総再生数') && l?.includes('1,800,000'))).toBe(true)
    // 平均再生数 = (1000000+800000)/2 = 900,000 を実値で
    expect(labels.some((l) => l?.includes('平均再生数') && l?.includes('900,000'))).toBe(true)
    // 平均コメント数 = (40+20)/2 = 30
    expect(labels.some((l) => l?.includes('平均コメント数') && l?.includes('30'))).toBe(true)
  })
})
