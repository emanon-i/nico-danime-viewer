import type { Screen, ListState } from '../router'
import { buildListUrl } from '../router'

function listStateLabel(state: ListState): string {
  if (state.q) return `検索「${state.q}」`
  if (state.tag) return `タグ「${state.tag}」`
  if (state.cours === 'current') return '今期'
  if (state.cours) return `クール「${state.cours}」`
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
