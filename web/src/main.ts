import { parseScreen, buildListUrl } from './features/router'
import type { SortKey } from './features/router'
import { renderTop } from './features/top/top'
import type { TopData } from './features/top/top'
import { renderList } from './features/list/list'
import { renderDetail } from './features/detail/detail'
import { renderBreadcrumb } from './features/shared/breadcrumb'
import { initHeaderSearch } from './features/shared/search'
import { filterWorks, sortWorks, paginateWorks } from './features/list/filter'
import { loadWorks, loadRanking, loadTags, loadCours, loadNew } from './data/loader'
import type { WorksJson, RankingJson, TagsJson, CoursJson, NewJson } from './data/types'

const app = document.querySelector<HTMLDivElement>('#app')!

let cache: {
  works: WorksJson | null
  ranking: RankingJson | null
  tags: TagsJson | null
  cours: CoursJson | null
  newData: NewJson | null
} = { works: null, ranking: null, tags: null, cours: null, newData: null }

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
  } else if (screen.type === 'list') {
    const allWorks = cache.works?.works ?? []
    const filtered = filterWorks(allWorks, screen.state)
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
  } else {
    const bcContainer = document.createElement('div')
    app.appendChild(bcContainer)
    renderBreadcrumb(bcContainer, screen)

    renderDetail(app, null)
  }
}

window.addEventListener('popstate', () => {
  void render()
})
void render()
