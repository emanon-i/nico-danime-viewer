// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderTop, createSeriesCard } from '../../web/src/features/top/top'

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

  it('クイックアクセスに4つのボタンがある', () => {
    const btns = container.querySelectorAll('[data-section="quick-access"] .quick-btn')
    expect(btns.length).toBe(4)
  })
})

describe('createSeriesCard (F-0023)', () => {
  it('test_card_icons: カードは♥/✓/[↗]を持ち、ⓘを持たない', () => {
    const card = createSeriesCard(1, 'テスト', null, 'https://www.nicovideo.jp/series/1')
    expect(card.querySelector('.card-favorite')).not.toBeNull()
    expect(card.querySelector('.card-watched')).not.toBeNull()
    expect(card.querySelector('.card-external')).not.toBeNull()
    // ⓘ はカードに付けない
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
