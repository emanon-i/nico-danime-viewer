import type { Screen, ListState } from '../router'
import { buildListUrl } from '../router'

function listStateLabel(state: ListState): string {
  if (state.q) return `検索「${state.q}」`
  if (state.tags.length > 0) return `タグ「${state.tags.join('・')}」`
  if (state.cours) {
    // 複数クール（§90・カンマ区切り）。プリセット(current/previous)は今期/前期。
    const disp = (c: string): string => (c === 'current' ? '今期' : c === 'previous' ? '前期' : c)
    const list = state.cours.split(',').filter(Boolean)
    if (list.length === 1) {
      const c = list[0]
      return c === 'current' ? '今期' : c === 'previous' ? '前期' : `クール「${c}」`
    }
    return `クール「${list.map(disp).join('・')}」`
  }
  if (state.sort === 'views') return '人気TOP'
  if (state.sort === 'new') return '新着'
  return ''
}

export function renderBreadcrumb(
  container: HTMLElement,
  screen: Screen,
  seriesTitle?: string
): void {
  container.innerHTML = ''
  if (screen.type === 'top') return

  const nav = document.createElement('nav')
  nav.className = 'breadcrumb'
  nav.setAttribute('aria-label', 'パンくずナビ')

  const homeLink = document.createElement('a')
  homeLink.className = 'breadcrumb-home'
  homeLink.href = '?'
  homeLink.textContent = 'ホーム'
  nav.appendChild(homeLink)

  const sep1 = document.createElement('span')
  sep1.className = 'breadcrumb-sep'
  sep1.textContent = ' / '
  nav.appendChild(sep1)

  if (screen.type === 'list') {
    const label = listStateLabel(screen.state)
    const cur = document.createElement('span')
    cur.className = 'breadcrumb-current'
    cur.setAttribute('aria-current', 'page')
    cur.textContent = label ? `一覧：${label}` : '一覧'
    nav.appendChild(cur)
  } else if (screen.type === 'detail') {
    const listLink = document.createElement('a')
    listLink.className = 'breadcrumb-list'
    listLink.href = buildListUrl({})
    listLink.textContent = '一覧'
    nav.appendChild(listLink)

    if (seriesTitle) {
      const sep2 = document.createElement('span')
      sep2.className = 'breadcrumb-sep'
      sep2.textContent = ' / '
      nav.appendChild(sep2)

      const cur = document.createElement('span')
      cur.className = 'breadcrumb-current'
      cur.setAttribute('aria-current', 'page')
      cur.textContent = seriesTitle
      nav.appendChild(cur)
    }
  }

  container.appendChild(nav)
}
