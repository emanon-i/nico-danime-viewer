import { icon } from './icon'
import { seriesLink } from '../shared/deeplink'

/** シリーズカード DOM を生成する */
export function card(
  seriesId: number,
  title: string,
  thumbnailUrl: string | null,
  officialHref?: string
): HTMLElement {
  const el = document.createElement('div')
  el.className = 'series-card'
  el.dataset.seriesId = String(seriesId)

  const bodyLink = document.createElement('a')
  bodyLink.className = 'card-body'
  bodyLink.href = `?series=${seriesId}`

  const img = document.createElement('img')
  img.src = thumbnailUrl ?? ''
  img.alt = title
  img.loading = 'lazy'
  img.width = 160
  img.height = 90
  bodyLink.appendChild(img)

  const titleEl = document.createElement('div')
  titleEl.className = 'card-title'
  titleEl.textContent = title
  bodyLink.appendChild(titleEl)

  el.appendChild(bodyLink)

  const actions = document.createElement('div')
  actions.className = 'card-actions'

  const favBtn = document.createElement('button')
  favBtn.className = 'icon-btn card-favorite'
  favBtn.setAttribute('aria-label', 'お気に入り')
  favBtn.appendChild(icon('heart', 15))
  actions.appendChild(favBtn)

  const watchedBtn = document.createElement('button')
  watchedBtn.className = 'icon-btn card-watched'
  watchedBtn.setAttribute('aria-label', '見た')
  watchedBtn.appendChild(icon('check', 15))
  actions.appendChild(watchedBtn)

  const href = officialHref ?? seriesLink(seriesId) ?? ''
  if (href) {
    const extLink = document.createElement('a')
    extLink.className = 'icon-btn card-external'
    extLink.href = href
    extLink.target = '_blank'
    extLink.rel = 'noopener noreferrer'
    extLink.setAttribute('aria-label', '公式シリーズページを開く')
    extLink.appendChild(icon('external-link', 15))
    actions.appendChild(extLink)
  }

  el.appendChild(actions)
  return el
}
