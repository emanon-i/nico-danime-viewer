// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderTop } from '../../web/src/features/top/top'
import { renderList } from '../../web/src/features/list/list'
import type { ListState } from '../../web/src/features/router'

const BASE_STATE: ListState = { q: '', row: '', tags: [], cours: '', sort: 'hot', page: 1 }

describe('F-0038: レスポンシブ構造', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  it('test_grid_columns_by_breakpoint: 一覧グリッドコンテナが .list-grid クラスを持つ', () => {
    renderList(container, { state: BASE_STATE, works: [], totalCount: 0, totalPages: 1 })
    const grid = container.querySelector('[data-part="grid"]')
    expect(grid).not.toBeNull()
    expect(grid?.classList.contains('list-grid')).toBe(true)
  })

  it('test_mobile_filter_drawer: フィルタ部分が .list-filter を持つ', () => {
    renderList(container, { state: BASE_STATE, works: [], totalCount: 0, totalPages: 1 })
    const filter = container.querySelector('.list-filter')
    expect(filter).not.toBeNull()
    expect(filter?.getAttribute('data-part')).toBe('filter')
  })

  it('test_grid_vertical_top10_horizontal: TOP10 レールが .top10-rail クラスを持つ', () => {
    renderTop(container)
    const rail = container.querySelector('.top10-rail')
    expect(rail).not.toBeNull()
  })

  it('test_grid_vertical_top10_horizontal: 一覧グリッドは横スクロールしない（overflow-x クラスなし）', () => {
    renderList(container, { state: BASE_STATE, works: [], totalCount: 0, totalPages: 1 })
    const grid = container.querySelector('[data-part="grid"]')
    // CSS で overflow-x:hidden/auto ではなくグリッドのみ
    expect(grid?.classList.contains('scroll-x')).toBe(false)
    expect(grid?.classList.contains('overflow-x-auto')).toBe(false)
  })

  it('フィルタがお気に入り/未視聴チェックボックスを含む', () => {
    renderList(container, { state: BASE_STATE, works: [], totalCount: 0, totalPages: 1 })
    expect(container.querySelector('input[name="fav"]')).not.toBeNull()
    expect(container.querySelector('input[name="unwatched"]')).not.toBeNull()
  })

  it('favFilter=true のとき fav チェックボックスが checked になる', () => {
    renderList(container, {
      state: BASE_STATE,
      works: [],
      totalCount: 0,
      totalPages: 1,
      favFilter: true,
    })
    const favCb = container.querySelector<HTMLInputElement>('input[name="fav"]')
    expect(favCb?.checked).toBe(true)
  })

  it('unwatchedFilter=true のとき unwatched チェックボックスが checked になる', () => {
    renderList(container, {
      state: BASE_STATE,
      works: [],
      totalCount: 0,
      totalPages: 1,
      unwatchedFilter: true,
    })
    const unwatchedCb = container.querySelector<HTMLInputElement>('input[name="unwatched"]')
    expect(unwatchedCb?.checked).toBe(true)
  })

  it('ヘッダが .site-header を持つ', () => {
    renderTop(container)
    const header = container.querySelector('.site-header')
    expect(header).not.toBeNull()
  })
})
