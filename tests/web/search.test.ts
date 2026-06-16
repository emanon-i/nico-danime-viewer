// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initHeaderSearch } from '../../web/src/features/shared/search'
import { renderList } from '../../web/src/features/list/list'
import type { ListState } from '../../web/src/features/router'

const BASE_STATE: ListState = { q: '', row: '', tag: '', cours: '', sort: 'hot', page: 1 }

describe('initHeaderSearch (F-0027)', () => {
  let wrapper: HTMLDivElement
  let searchBtn: HTMLButtonElement
  let navigated: string

  beforeEach(() => {
    wrapper = document.createElement('div')
    searchBtn = document.createElement('button')
    searchBtn.className = 'header-search-btn'
    wrapper.appendChild(searchBtn)
    document.body.appendChild(wrapper)
    navigated = ''
    initHeaderSearch(searchBtn, (url) => {
      navigated = url
    })
  })

  afterEach(() => {
    document.body.removeChild(wrapper)
  })

  it('test_search_expand_collapse: 初期状態で検索バーは非表示', () => {
    const bar = wrapper.querySelector('.header-search-bar')
    expect(bar?.getAttribute('hidden') !== null || (bar as HTMLElement | null)?.hidden).toBe(true)
  })

  it('test_search_expand_collapse: 🔍クリックで検索バーが展開する', () => {
    searchBtn.click()
    const bar = wrapper.querySelector<HTMLElement>('.header-search-bar')
    expect(bar?.hidden).toBe(false)
    expect(searchBtn.getAttribute('aria-expanded')).toBe('true')
  })

  it('test_search_expand_collapse: 再クリックで折畳む', () => {
    searchBtn.click()
    searchBtn.click()
    const bar = wrapper.querySelector<HTMLElement>('.header-search-bar')
    expect(bar?.hidden).toBe(true)
    expect(searchBtn.getAttribute('aria-expanded')).toBe('false')
  })

  it('test_search_expand_collapse: ×ボタンで閉じる', () => {
    searchBtn.click()
    const closeBtn = wrapper.querySelector<HTMLElement>('.header-search-close')
    closeBtn?.click()
    const bar = wrapper.querySelector<HTMLElement>('.header-search-bar')
    expect(bar?.hidden).toBe(true)
  })

  it('test_search_expand_collapse: Esc キーで閉じる', () => {
    searchBtn.click()
    const input = wrapper.querySelector<HTMLInputElement>('.header-search-input')
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    const bar = wrapper.querySelector<HTMLElement>('.header-search-bar')
    expect(bar?.hidden).toBe(true)
  })

  it('test_search_routes_to_list: Enter でクエリ付き URL へ遷移する', () => {
    searchBtn.click()
    const input = wrapper.querySelector<HTMLInputElement>('.header-search-input')!
    input.value = 'ゆるキャン'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(navigated).toContain('q=')
    expect(navigated).toContain('%E3%82%86%E3%82%8B%E3%82%AD%E3%83%A3%E3%83%B3')
  })

  it('空クエリでは遷移しない', () => {
    searchBtn.click()
    const input = wrapper.querySelector<HTMLInputElement>('.header-search-input')!
    input.value = '  '
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(navigated).toBe('')
  })
})

describe('test_single_search_input (F-0027)', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  it('test_single_search_input: 一覧画面の入力欄は1本のみ', () => {
    renderList(container, { state: BASE_STATE, works: [], totalCount: 0, totalPages: 1 })
    const inputs = container.querySelectorAll('input[type="search"]')
    expect(inputs.length).toBe(1)
  })
})
