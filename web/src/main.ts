import { parseScreen } from './features/router'
import { renderTop } from './features/top/top'
import { renderList } from './features/list/list'
import { renderDetail } from './features/detail/detail'

const app = document.querySelector<HTMLDivElement>('#app')!

function render(): void {
  const params = new URLSearchParams(location.search)
  const screen = parseScreen(params)
  app.innerHTML = ''

  if (screen.type === 'top') {
    renderTop(app)
  } else if (screen.type === 'list') {
    // データ結線は PH-0004 以降
    renderList(app, { state: screen.state, works: [], totalCount: 0, totalPages: 1 })
  } else {
    // データ結線は PH-0004 以降
    renderDetail(app, null)
  }
}

window.addEventListener('popstate', render)
render()
