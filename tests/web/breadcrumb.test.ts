// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderBreadcrumb } from '../../web/src/features/shared/breadcrumb'
import type { Screen } from '../../web/src/features/router'

const LIST_SCREEN: Screen = {
  type: 'list',
  state: {
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
  },
}

describe('renderBreadcrumb (F-0033)', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  it('top 画面では何も描画しない', () => {
    renderBreadcrumb(container, { type: 'top' })
    expect(container.innerHTML).toBe('')
  })

  it('test_breadcrumb_reflects_state: 一覧（デフォルト）はパンくずに「一覧」が出る', () => {
    renderBreadcrumb(container, LIST_SCREEN)
    expect(container.querySelector('.breadcrumb-current')?.textContent).toBe('一覧')
  })

  it('test_breadcrumb_reflects_state: q フィルタが反映される', () => {
    renderBreadcrumb(container, {
      type: 'list',
      state: { ...LIST_SCREEN.state, q: 'ゆるキャン' },
    })
    expect(container.querySelector('.breadcrumb-current')?.textContent).toContain(
      '検索「ゆるキャン」'
    )
  })

  it('test_breadcrumb_reflects_state: tag フィルタが反映される', () => {
    renderBreadcrumb(container, {
      type: 'list',
      state: { ...LIST_SCREEN.state, tags: ['日常'] },
    })
    expect(container.querySelector('.breadcrumb-current')?.textContent).toContain('タグ「日常」')
  })

  it('test_breadcrumb_reflects_state: cours=current は「今期」と表示される', () => {
    renderBreadcrumb(container, {
      type: 'list',
      state: { ...LIST_SCREEN.state, cours: 'current' },
    })
    expect(container.querySelector('.breadcrumb-current')?.textContent).toContain('今期')
  })

  it('test_breadcrumb_reflects_state: cours が具体値の場合はクール名が出る', () => {
    renderBreadcrumb(container, {
      type: 'list',
      state: { ...LIST_SCREEN.state, cours: '2026-春' },
    })
    expect(container.querySelector('.breadcrumb-current')?.textContent).toContain(
      'クール「2026-春」'
    )
  })

  it('test_breadcrumb_navigation: ホームリンクが ? へ向く', () => {
    renderBreadcrumb(container, LIST_SCREEN)
    const homeLink = container.querySelector('.breadcrumb-home')
    expect(homeLink?.getAttribute('href')).toBe('?')
  })

  it('test_breadcrumb_navigation: 詳細画面には「一覧」リンクがある', () => {
    renderBreadcrumb(container, { type: 'detail', seriesId: 42 })
    const listLink = container.querySelector('.breadcrumb-list')
    expect(listLink).not.toBeNull()
    expect(listLink?.getAttribute('href')).toContain('screen=list')
  })

  it('test_breadcrumb_navigation: 詳細画面にシリーズタイトルが出る', () => {
    renderBreadcrumb(container, { type: 'detail', seriesId: 42 }, 'ゆるキャン△')
    const cur = container.querySelector('.breadcrumb-current')
    expect(cur?.textContent).toBe('ゆるキャン△')
    expect(cur?.getAttribute('aria-current')).toBe('page')
  })

  it('test_breadcrumb_truncate_mobile: breadcrumb に aria-label が設定されている（CSS 省略構造対応）', () => {
    renderBreadcrumb(container, LIST_SCREEN)
    const nav = container.querySelector('nav.breadcrumb')
    expect(nav).not.toBeNull()
    expect(nav?.getAttribute('aria-label')).toBe('パンくずナビ')
  })

  it('sort=views のラベルが「人気TOP」と出る', () => {
    renderBreadcrumb(container, {
      type: 'list',
      state: { ...LIST_SCREEN.state, sort: 'views' },
    })
    expect(container.querySelector('.breadcrumb-current')?.textContent).toContain('人気TOP')
  })

  it('sort=new のラベルが「新着」と出る', () => {
    renderBreadcrumb(container, {
      type: 'list',
      state: { ...LIST_SCREEN.state, sort: 'new' },
    })
    expect(container.querySelector('.breadcrumb-current')?.textContent).toContain('新着')
  })
})
