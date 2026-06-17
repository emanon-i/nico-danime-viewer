import { describe, it, expect } from 'vitest'
import { parseScreen, buildListUrl, buildDetailUrl } from '../../web/src/features/router'
import type { ListState } from '../../web/src/features/router'

describe('parseScreen (F-0022)', () => {
  it('test_list_state_in_url: 一覧状態が URL クエリから復元できる', () => {
    const params = new URLSearchParams('q=テスト&tag=日常&cours=2026春&sort=views&page=2')
    const screen = parseScreen(params)
    expect(screen.type).toBe('list')
    if (screen.type !== 'list') return
    expect(screen.state.q).toBe('テスト')
    expect(screen.state.tags).toEqual(['日常'])
    expect(screen.state.cours).toBe('2026春')
    expect(screen.state.sort).toBe('views')
    expect(screen.state.page).toBe(2)
  })

  it('test_list_state_in_url: row パラメータも復元できる', () => {
    const params = new URLSearchParams('row=あ')
    const screen = parseScreen(params)
    expect(screen.type).toBe('list')
    if (screen.type !== 'list') return
    expect(screen.state.row).toBe('あ')
  })

  it('test_url_reproduces_state: 同じ URL で同じ状態を再現する（決定的）', () => {
    const url = 'q=foo&tag=bar&sort=hot&page=3'
    const s1 = parseScreen(new URLSearchParams(url))
    const s2 = parseScreen(new URLSearchParams(url))
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2))
  })

  it('?series=<id> で detail 画面', () => {
    const screen = parseScreen(new URLSearchParams('series=123'))
    expect(screen.type).toBe('detail')
    if (screen.type !== 'detail') return
    expect(screen.seriesId).toBe(123)
  })

  it('パラメータなしで top 画面', () => {
    expect(parseScreen(new URLSearchParams()).type).toBe('top')
  })

  it('不正な sort は hot にフォールバックする', () => {
    const screen = parseScreen(new URLSearchParams('sort=invalid'))
    expect(screen.type).toBe('list')
    if (screen.type !== 'list') return
    expect(screen.state.sort).toBe('hot')
  })

  it('page は 1 以上にクランプされる', () => {
    const screen = parseScreen(new URLSearchParams('page=-5'))
    expect(screen.type).toBe('list')
    if (screen.type !== 'list') return
    expect(screen.state.page).toBe(1)
  })
})

describe('buildListUrl (F-0022)', () => {
  it('状態を URL クエリに変換する', () => {
    const url = buildListUrl({ q: 'テスト', tags: ['日常'], page: 2 })
    const params = new URLSearchParams(url.slice(1))
    expect(params.get('q')).toBe('テスト')
    expect(params.get('tag')).toBe('日常')
    expect(params.get('page')).toBe('2')
  })

  it('デフォルト値は省略される（hot ソート・1ページ目）', () => {
    const url = buildListUrl({ sort: 'hot', dir: 'desc', size: 48, page: 1 })
    const params = new URLSearchParams(url.slice(1))
    expect(params.has('sort')).toBe(false)
    expect(params.has('page')).toBe(false)
  })
})

describe('test_history_navigation (F-0022)', () => {
  it('buildListUrl → parseScreen でラウンドトリップが成立する', () => {
    const state: ListState = {
      q: 'foo',
      tags: ['bar'],
      cours: '2026春',
      sort: 'views',
      dir: 'desc',
      size: 48,
      page: 2,
      row: 'さ',
    }
    const url = buildListUrl(state)
    const restored = parseScreen(new URLSearchParams(url.slice(1)))
    expect(restored.type).toBe('list')
    if (restored.type !== 'list') return
    expect(restored.state.q).toBe(state.q)
    expect(restored.state.tags).toEqual(state.tags)
    expect(restored.state.cours).toBe(state.cours)
    expect(restored.state.sort).toBe(state.sort)
    expect(restored.state.page).toBe(state.page)
    expect(restored.state.row).toBe(state.row)
  })

  it('buildDetailUrl → parseScreen で detail 画面に遷移する', () => {
    const url = buildDetailUrl(42)
    const screen = parseScreen(new URLSearchParams(url.slice(1)))
    expect(screen.type).toBe('detail')
    if (screen.type !== 'detail') return
    expect(screen.seriesId).toBe(42)
  })
})
