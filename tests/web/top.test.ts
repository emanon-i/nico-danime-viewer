// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderTop } from '../../web/src/features/top/top'
import { card as createSeriesCard } from '../../web/src/components/card'
import type { TopData } from '../../web/src/features/top/top'
import type { RankingEntry, NewItem, Work } from '../../web/src/data/types'

const POPULAR_10: RankingEntry[] = Array.from({ length: 12 }, (_, i) => ({
  seriesId: i + 1,
  title: `作品${i + 1}`,
  thumbnailUrl: null,
  totalViews: 1000 - i * 10,
  hotScore: null,
}))

const NEW_SERIES: Work[] = Array.from({ length: 3 }, (_, i) => ({
  seriesId: 100 + i,
  title: `新シリーズ${i + 1}`,
  thumbnailUrl: null,
  descriptionFirst: null,
  tags: [],
  cours: null,
  franchiseKey: null,
  colKey: null,
  relatedSeries: [],
}))

const NEW_EPISODES: NewItem[] = [
  {
    watchId: 'w1',
    title: '最新話A',
    pubDate: '2026-06-16T00:00:00Z',
    resolvedContentId: 'lv123',
    resolutionStatus: 'resolved',
  },
  {
    watchId: 'w2',
    title: '最新話B（未解決）',
    pubDate: '2026-06-15T00:00:00Z',
    resolvedContentId: null,
    resolutionStatus: 'rss_only',
  },
]

const SAMPLE_DATA: TopData = {
  popular: POPULAR_10,
  hotTags: ['ラブコメ', '学園'],
  popularTags: ['ファンタジー', '異世界'],
  allTags: Array.from({ length: 10 }, (_, i) => ({
    name: `タグ${i}`,
    isCurated: false,
    seriesCount: i + 1,
  })),
  cours: [{ cours: '2026-春', seriesIds: [1, 2, 3] }],
  newSeries: NEW_SERIES,
  newEpisodes: NEW_EPISODES,
}

describe('renderTop (F-0023)', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    renderTop(container)
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  it('test_top_sections_render_in_order: 7セクションが所定順で描画される', () => {
    const sections = container.querySelectorAll('[data-section]')
    const names = Array.from(sections).map((el) => el.getAttribute('data-section'))
    expect(names).toEqual([
      'header',
      'hero-search',
      'quick-access',
      'top10',
      'recent',
      'cours',
      'tags',
    ])
  })

  it('test_header_search_appears_after_hero: ヘッダ🔍は初期状態で aria-hidden="true"', () => {
    const searchBtn = container.querySelector('[data-section="header"] .header-search-btn')
    expect(searchBtn).not.toBeNull()
    expect(searchBtn?.getAttribute('aria-hidden')).toBe('true')
  })

  it('ヒーロー検索入力が存在する', () => {
    const heroInput = container.querySelector('[data-section="hero-search"] input')
    expect(heroInput).not.toBeNull()
  })

  it('クイックアクセスに5つのボタンがある（今期/新着/Hot/人気TOP/五十音）', () => {
    const btns = container.querySelectorAll('[data-section="quick-access"] .quick-btn')
    expect(btns.length).toBe(5)
    expect(Array.from(btns).map((b) => b.textContent)).toEqual([
      '今期',
      '新着',
      'Hot',
      '人気TOP',
      '五十音',
    ])
  })
})

describe('createSeriesCard (F-0023)', () => {
  it('test_card_icons: カードは♥/✓/[↗]を持ち、ⓘを持たない', () => {
    const card = createSeriesCard(1, 'テスト', null, 'https://www.nicovideo.jp/series/1')
    expect(card.querySelector('.card-favorite')).not.toBeNull()
    expect(card.querySelector('.card-watched')).not.toBeNull()
    expect(card.querySelector('.card-external')).not.toBeNull()
    expect(card.querySelector('.info-btn')).toBeNull()
    expect(card.querySelector('[aria-label="説明"]')).toBeNull()
  })

  it('カード本体リンクが詳細ページへ向く', () => {
    const card = createSeriesCard(42, 'テスト', null, 'https://www.nicovideo.jp/series/42')
    const bodyLink = card.querySelector('.card-body')
    expect(bodyLink?.getAttribute('href')).toBe('?series=42')
  })

  it('外部リンクが公式シリーズページへ向く', () => {
    const card = createSeriesCard(42, 'テスト', null, 'https://www.nicovideo.jp/series/42')
    const extLink = card.querySelector('.card-external')
    expect(extLink?.getAttribute('href')).toBe('https://www.nicovideo.jp/series/42')
    expect(extLink?.getAttribute('rel')).toContain('noopener')
  })
})

describe('renderTop with data (F-0032)', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  it('test_quick_access_presets: 5プリセットが所定URLを持つ', () => {
    renderTop(container)
    const btns = container.querySelectorAll('[data-section="quick-access"] .quick-btn')
    const hrefs = Array.from(btns).map((b) => b.getAttribute('href'))
    expect(hrefs.some((h) => h?.includes('cours=current') && h?.includes('sort=hot'))).toBe(true)
    expect(hrefs).toContain('?sort=new')
    expect(hrefs).toContain('?sort=hot')
    expect(hrefs).toContain('?sort=views')
    expect(hrefs).toContain('?sort=kana')
  })

  it('test_header_order: ヘッダ右側は 🔍 → テーマ → 設定 の順（慣例＝設定が右端）', () => {
    renderTop(container)
    const header = container.querySelector('[data-section="header"]')!
    const iconBtns = Array.from(header.querySelectorAll('.icon-btn'))
    const classOrder = iconBtns.map((b) =>
      b.classList.contains('header-search-btn')
        ? 'search'
        : b.classList.contains('theme-btn')
          ? 'theme'
          : b.classList.contains('settings-btn')
            ? 'settings'
            : 'other'
    )
    expect(classOrder).toEqual(['search', 'theme', 'settings'])
  })

  it('test_top10_by_total_views: TOP10が popular の上位10件を表示する', () => {
    renderTop(container, SAMPLE_DATA)
    const cards = container.querySelectorAll('.top10-rail .series-card')
    expect(cards.length).toBe(10) // 12件あっても 10件に切る
    // 先頭が popular[0] (seriesId=1)
    expect(cards[0].getAttribute('data-series-id')).toBe('1')
  })

  it('test_new_two_kinds: 新着セクションに新着シリーズと最新の動画の2系統が出る', () => {
    renderTop(container, SAMPLE_DATA)
    const recent = container.querySelector('[data-section="recent"]')
    expect(recent?.querySelector('[data-subsection="new-series"]')).not.toBeNull()
    expect(recent?.querySelector('[data-subsection="new-episodes"]')).not.toBeNull()
  })

  it('最新の動画は resolved のみ表示する', () => {
    renderTop(container, SAMPLE_DATA)
    const epSec = container.querySelector('[data-subsection="new-episodes"]')
    // 未解決(rss_only)は除外されるので 1件のみ
    const items = epSec?.querySelectorAll('.recent-item')
    expect(items?.length).toBe(1)
  })

  it('test_top_tag_chip_navigates: タグチップが ?tag=... の一覧へリンクする', () => {
    renderTop(container, SAMPLE_DATA)
    const chip = container.querySelector('[data-section="tags"] .tag-chip')
    expect(chip).not.toBeNull()
    expect(chip?.getAttribute('href')).toContain('tag=')
  })

  it('test_random_tag_reshuffle: シャッフルボタンクリックでランダムタグが再描画される', () => {
    renderTop(container, SAMPLE_DATA)
    const randomDiv = container.querySelector('.tag-random')
    const shuffleBtn = randomDiv?.querySelector('.shuffle-btn')
    // 初期描画後にチップが存在する
    const beforeChips = randomDiv?.querySelectorAll('.tag-chip').length ?? 0
    expect(beforeChips).toBeGreaterThan(0)
    // シャッフル後もチップが存在する
    shuffleBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const afterChips = randomDiv?.querySelectorAll('.tag-chip').length ?? 0
    expect(afterChips).toBeGreaterThan(0)
  })

  it('クールボタンが ?cours=...&sort=hot の URL を持つ', () => {
    renderTop(container, SAMPLE_DATA)
    const coursBtn = container.querySelector('.cours-btn')
    expect(coursBtn).not.toBeNull()
    expect(coursBtn?.getAttribute('href')).toContain('cours=')
    expect(coursBtn?.getAttribute('href')).toContain('sort=hot')
  })

  it('データなしでも 7セクション構造が壊れない', () => {
    renderTop(container)
    const sections = container.querySelectorAll('[data-section]')
    expect(sections.length).toBe(7)
  })
})
