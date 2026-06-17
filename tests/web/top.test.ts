// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderTop } from '../../web/src/features/top/top'
import { card as createSeriesCard } from '../../web/src/components/card'
import type { TopData } from '../../web/src/features/top/top'
import type { RankingEntry, Work } from '../../web/src/data/types'

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
  episodeCount: 12 + i,
  relatedSeries: [],
}))

// 最近更新のあったシリーズ（§73・別列）
const UPDATED_SERIES: Work[] = Array.from({ length: 3 }, (_, i) => ({
  seriesId: 200 + i,
  title: `更新シリーズ${i + 1}`,
  thumbnailUrl: null,
  descriptionFirst: null,
  tags: [],
  cours: null,
  franchiseKey: null,
  colKey: null,
  episodeCount: 5 + i,
  relatedSeries: [],
}))

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
  updatedSeries: UPDATED_SERIES,
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

  it('クイックアクセスは固定5ボタン（今期/前期/人気/Hot/お気に入り）＝§50', () => {
    const btns = container.querySelectorAll('[data-section="quick-access"] .quick-btn')
    expect(btns.length).toBe(5)
    expect(Array.from(btns).map((b) => b.textContent)).toEqual([
      '今期',
      '前期',
      '人気',
      'Hot',
      'お気に入り',
    ])
  })

  it('クイックアクセスは nav（サイトナビゲーション・ランドマーク）である', () => {
    const qa = container.querySelector('[data-section="quick-access"]')
    expect(qa?.tagName.toLowerCase()).toBe('nav')
  })

  it('ヒーロー直下に「一覧で探す」独立プライマリボタン（?screen=list）がある', () => {
    const browse = container.querySelector<HTMLAnchorElement>('.hero .btn-primary.hero-browse-btn')
    expect(browse).not.toBeNull()
    expect(browse?.getAttribute('href')).toBe('?screen=list')
  })

  it('共通ヘッダ（banner）と main#main-content ランドマークがある', () => {
    expect(container.querySelector('header[role="banner"]')).not.toBeNull()
    expect(container.querySelector('main#main-content')).not.toBeNull()
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

  it('test_quick_access_presets: 厳選プリセットが所定URLを持つ（今期/人気/Hot）', () => {
    renderTop(container)
    const btns = container.querySelectorAll('[data-section="quick-access"] .quick-btn')
    const hrefs = Array.from(btns).map((b) => b.getAttribute('href'))
    // 今期＝勢い順プリセット
    expect(hrefs.some((h) => h?.includes('cours=current') && h?.includes('sort=hot'))).toBe(true)
    // 人気＝累計再生数順
    expect(hrefs).toContain('?sort=views')
    // Hot＝勢い順
    expect(hrefs).toContain('?sort=hot')
    // 新着・五十音はクイックアクセスに置かない（⑤セクション・一覧ナビで担保）
    expect(hrefs).not.toContain('?sort=new')
    expect(hrefs).not.toContain('?sort=kana')
  })

  it('データ供給時は下段マーキーにランダムタグ（タグチップ型ピル）が流れる（§36）', () => {
    renderTop(container, SAMPLE_DATA)
    const track = container.querySelector('.quick-marquee-track')
    expect(track).not.toBeNull()
    const quickTags = track!.querySelectorAll('.quick-tag')
    // シームレスループのため同じ並びを 2 回敷く＝偶数・2 以上
    expect(quickTags.length).toBeGreaterThanOrEqual(2)
    expect(quickTags.length % 2).toBe(0)
    quickTags.forEach((t) => {
      expect(t.getAttribute('href')).toContain('tag=')
      expect(t.textContent?.startsWith('#')).toBe(true)
    })
    // 複製分は読み上げ対象外（前半は可視・後半は aria-hidden）
    const half = quickTags.length / 2
    expect(quickTags[half].getAttribute('aria-hidden')).toBe('true')
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

  it('test_new_two_kinds: 新着セクションに「新規シリーズ」と「最近更新」の2列が出る（§73）', () => {
    renderTop(container, SAMPLE_DATA)
    const recent = container.querySelector('[data-section="recent"]')
    expect(recent?.querySelector('[data-subsection="new-series"]')).not.toBeNull()
    expect(recent?.querySelector('[data-subsection="updated-series"]')).not.toBeNull()
    // 旧「最新の動画（個別エピソード）」列は廃止（§73/§74）
    expect(recent?.querySelector('[data-subsection="new-episodes"]')).toBeNull()
  })

  it('両列とも各列に「すべて見る」が1つずつ・別ソートへ飛ぶ（§73）', () => {
    renderTop(container, SAMPLE_DATA)
    const newCol = container.querySelector('[data-subsection="new-series"]')
    const updCol = container.querySelector('[data-subsection="updated-series"]')
    // 新規→?sort=created / 最近更新→?sort=new
    expect(newCol?.querySelector<HTMLAnchorElement>('.see-all')?.getAttribute('href')).toBe(
      '?sort=created'
    )
    expect(updCol?.querySelector<HTMLAnchorElement>('.see-all')?.getAttribute('href')).toBe(
      '?sort=new'
    )
  })

  it('新規シリーズ列はシリーズ型（kind=series・[film]N話・本体=詳細・↗ で公式＝§24/§73）', () => {
    renderTop(container, SAMPLE_DATA)
    const row = container.querySelector('[data-subsection="new-series"] .recent-item.list-row')
    expect(row?.getAttribute('data-kind')).toBe('series')
    expect(row?.querySelector('.list-row-badge')?.textContent).toContain('シリーズ')
    expect(row?.querySelector('.list-row-meta')?.textContent).toBe('12話')
    const body = row?.querySelector<HTMLAnchorElement>('.list-row-body')
    expect(body?.getAttribute('href')).toBe('?series=100')
    const ext = row?.querySelector<HTMLAnchorElement>('.list-row-external')
    expect(ext?.getAttribute('href')).toBe('https://www.nicovideo.jp/series/100')
  })

  it('最近更新列もシリーズ型（kind=series・本体=詳細・↗ で公式＝§73）', () => {
    renderTop(container, SAMPLE_DATA)
    const row = container.querySelector('[data-subsection="updated-series"] .recent-item.list-row')
    expect(row?.getAttribute('data-kind')).toBe('series')
    const body = row?.querySelector<HTMLAnchorElement>('.list-row-body')
    expect(body?.getAttribute('href')).toBe('?series=200') // UPDATED_SERIES 先頭
    const ext = row?.querySelector<HTMLAnchorElement>('.list-row-external')
    expect(ext?.getAttribute('href')).toBe('https://www.nicovideo.jp/series/200')
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
