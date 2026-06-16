import './style.css'
import { parseScreen, buildListUrl } from './features/router'
import type { SortKey } from './features/router'
import { renderTop } from './features/top/top'
import type { TopData } from './features/top/top'
import { renderList } from './features/list/list'
import { renderDetail } from './features/detail/detail'
import { renderBreadcrumb } from './features/shared/breadcrumb'
import { initHeaderSearch } from './features/shared/search'
import { filterWorks, sortWorks, paginateWorks } from './features/list/filter'
import {
  isFavorite,
  isWatched,
  toggleFavorite,
  toggleWatched,
  getFavoriteIds,
  getWatchedIds,
} from './features/shared/user-state'
import { initTheme, toggleTheme } from './features/shared/theme'
import { initSettingsModal } from './features/shared/settings-modal'
import { loadWorks, loadRanking, loadTags, loadCours, loadNew, loadSeries } from './data/loader'
import type { WorksJson, RankingJson, TagsJson, CoursJson, NewJson } from './data/types'

const app = document.querySelector<HTMLDivElement>('#app')!

let cache: {
  works: WorksJson | null
  ranking: RankingJson | null
  tags: TagsJson | null
  cours: CoursJson | null
  newData: NewJson | null
} = { works: null, ranking: null, tags: null, cours: null, newData: null }

// お気に入り/未視聴フィルタの状態（インメモリ・URLに出さない）
let favFilter = false
let unwatchedFilter = false

async function ensureData(): Promise<void> {
  if (cache.works !== null) return
  try {
    const [works, ranking, tags, cours, newData] = await Promise.all([
      loadWorks(),
      loadRanking(),
      loadTags(),
      loadCours(),
      loadNew(),
    ])
    cache = { works, ranking, tags, cours, newData }
  } catch {
    // データ未生成の場合はスケルトンのまま続行
  }
}

function buildTopData(): TopData | undefined {
  if (!cache.works) return undefined
  const worksArr = cache.works.works
  return {
    popular: cache.ranking?.popular ?? [],
    hotTags: cache.tags?.topHotTags ?? [],
    popularTags: cache.tags?.topPopularTags ?? [],
    allTags: cache.tags?.tags ?? [],
    cours: cache.cours?.cours ?? [],
    newSeries: [...worksArr].sort((a, b) => b.seriesId - a.seriesId).slice(0, 10),
    newEpisodes: cache.newData?.items ?? [],
  }
}

/** カードの ♥/✓ ボタンを localStorage と同期させる */
function wireCards(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>('.series-card').forEach((card) => {
    const seriesId = Number(card.dataset.seriesId)
    if (!seriesId) return

    const favBtn = card.querySelector<HTMLButtonElement>('.card-favorite')
    const watchedBtn = card.querySelector<HTMLButtonElement>('.card-watched')

    if (favBtn) {
      if (isFavorite(seriesId)) favBtn.classList.add('active')
      favBtn.addEventListener('click', () => {
        const nowFav = toggleFavorite(seriesId)
        favBtn.classList.toggle('active', nowFav)
      })
    }
    if (watchedBtn) {
      if (isWatched(seriesId)) watchedBtn.classList.add('active')
      watchedBtn.addEventListener('click', () => {
        const nowWatched = toggleWatched(seriesId)
        watchedBtn.classList.toggle('active', nowWatched)
      })
    }
  })
}

/** 詳細画面の ♥/✓ ボタンを localStorage と同期させる */
function wireDetailMarks(container: HTMLElement, seriesId: number): void {
  const favBtn = container.querySelector<HTMLButtonElement>('.btn-favorite')
  const watchedBtn = container.querySelector<HTMLButtonElement>('.btn-watched')

  if (favBtn) {
    if (isFavorite(seriesId)) favBtn.classList.add('active')
    favBtn.addEventListener('click', () => {
      const nowFav = toggleFavorite(seriesId)
      favBtn.classList.toggle('active', nowFav)
    })
  }
  if (watchedBtn) {
    if (isWatched(seriesId)) watchedBtn.classList.add('active')
    watchedBtn.addEventListener('click', () => {
      const nowWatched = toggleWatched(seriesId)
      watchedBtn.classList.toggle('active', nowWatched)
    })
  }
}

function navigate(url: string): void {
  history.pushState(null, '', url)
  void render()
}

async function render(): Promise<void> {
  await ensureData()

  const params = new URLSearchParams(location.search)
  const screen = parseScreen(params)
  app.innerHTML = ''

  if (screen.type === 'top') {
    renderTop(app, buildTopData())

    const heroInput = app.querySelector<HTMLInputElement>('.hero-search-input')
    heroInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = heroInput.value.trim()
        if (q) navigate(`?q=${encodeURIComponent(q)}`)
      }
    })

    const headerBtn = app.querySelector<HTMLElement>('.header-search-btn')
    if (headerBtn) initHeaderSearch(headerBtn, navigate)

    const themeBtn = app.querySelector<HTMLElement>('.theme-btn')
    themeBtn?.addEventListener('click', () => toggleTheme())

    const settingsBtn = app.querySelector<HTMLElement>('.settings-btn')
    if (settingsBtn) {
      initSettingsModal(settingsBtn, app, {
        lastUpdated: cache.ranking?.lastUpdated ?? null,
        onRerender: () => void render(),
      })
    }

    wireCards(app)
  } else if (screen.type === 'list') {
    const allWorks = cache.works?.works ?? []
    const favIds = favFilter ? new Set(getFavoriteIds()) : undefined
    const watchedIds = unwatchedFilter ? new Set(getWatchedIds()) : undefined
    const filtered = filterWorks(allWorks, screen.state, { favIds, watchedIds })
    const sorted = sortWorks(filtered, screen.state.sort, cache.ranking ?? null)
    const { items, totalCount, totalPages } = paginateWorks(sorted, screen.state.page)

    const bcContainer = document.createElement('div')
    app.appendChild(bcContainer)
    renderBreadcrumb(bcContainer, screen)

    renderList(app, {
      state: screen.state,
      works: items,
      totalCount,
      totalPages,
      data: {
        tags: cache.tags?.tags ?? [],
        cours: cache.cours?.cours ?? [],
      },
      favFilter,
      unwatchedFilter,
    })

    const searchInput = app.querySelector<HTMLInputElement>('.list-search-input')
    searchInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = searchInput.value.trim()
        if (q) navigate(buildListUrl({ ...screen.state, q, page: 1 }))
      }
    })

    const sortRadios = app.querySelectorAll<HTMLInputElement>('input[name="sort"]')
    sortRadios.forEach((radio) => {
      radio.addEventListener('change', () => {
        if (radio.checked)
          navigate(buildListUrl({ ...screen.state, sort: radio.value as SortKey, page: 1 }))
      })
    })

    const favCb = app.querySelector<HTMLInputElement>('input[name="fav"]')
    const unwatchedCb = app.querySelector<HTMLInputElement>('input[name="unwatched"]')
    if (favCb) {
      favCb.checked = favFilter
      favCb.addEventListener('change', () => {
        favFilter = favCb.checked
        void render()
      })
    }
    if (unwatchedCb) {
      unwatchedCb.checked = unwatchedFilter
      unwatchedCb.addEventListener('change', () => {
        unwatchedFilter = unwatchedCb.checked
        void render()
      })
    }

    wireCards(app)
  } else {
    const bcContainer = document.createElement('div')
    app.appendChild(bcContainer)
    renderBreadcrumb(bcContainer, screen)

    let seriesDetail = null
    try {
      const seriesData = await loadSeries()
      seriesDetail = seriesData.series.find((s) => s.seriesId === screen.seriesId) ?? null
    } catch {
      // series.json 未生成 or ネットワークエラー
    }
    renderDetail(app, seriesDetail)
    wireDetailMarks(app, screen.seriesId)
  }
}

// テーマを最初に適用（FOUC を防ぐ）
initTheme()

window.addEventListener('popstate', () => {
  void render()
})
void render()
