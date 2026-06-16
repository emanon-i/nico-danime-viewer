import type { Work } from '../../data/types'
import type { ListState } from '../router'
import { buildListUrl } from '../router'
import { seriesLink } from '../../shared/deeplink'
import { createSeriesCard } from '../top/top'

type SortKey = ListState['sort']

function sortLabel(sort: SortKey): string {
  switch (sort) {
    case 'hot':
      return '勢い順'
    case 'views':
      return '再生数(累計)'
    case 'new':
      return '新着'
    case 'kana':
      return '五十音順'
  }
}

const KANA_ROWS = ['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ', '全']

/** 一覧画面（検索バー／五十音／フィルタ／グリッド／ページング）を描画する */
export function renderList(
  container: HTMLElement,
  options: {
    state: ListState
    works: Work[]
    totalCount: number
    totalPages: number
  }
): void {
  const { state, works, totalCount, totalPages } = options
  container.innerHTML = ''

  // ── 検索バー ────────────────────────────────────────────────
  const searchBar = document.createElement('div')
  searchBar.className = 'list-search'
  searchBar.dataset.part = 'search'
  const searchInput = document.createElement('input')
  searchInput.type = 'search'
  searchInput.className = 'list-search-input'
  searchInput.value = state.q
  searchInput.placeholder = '作品・タグで検索…'
  searchInput.setAttribute('aria-label', '作品・タグで検索')
  searchBar.appendChild(searchInput)
  container.appendChild(searchBar)

  // ── 五十音ボタン ─────────────────────────────────────────────
  const kanaDiv = document.createElement('div')
  kanaDiv.className = 'list-kana'
  kanaDiv.dataset.part = 'kana'
  KANA_ROWS.forEach((row) => {
    const btn = document.createElement('button')
    btn.className = 'kana-btn' + (state.row === (row === '全' ? '' : row) ? ' active' : '')
    btn.textContent = row
    btn.dataset.row = row
    kanaDiv.appendChild(btn)
  })
  container.appendChild(kanaDiv)

  // ── 左フィルタ ───────────────────────────────────────────────
  const filterDiv = document.createElement('div')
  filterDiv.className = 'list-filter'
  filterDiv.dataset.part = 'filter'
  filterDiv.innerHTML = `
    <div class="filter-sort">
      <h3>並び替え <button class="info-btn" aria-label="並び替えについて">ⓘ</button></h3>
      ${(['hot', 'views', 'new', 'kana'] as const)
        .map(
          (s) =>
            `<label><input type="radio" name="sort" value="${s}" ${state.sort === s ? 'checked' : ''}> ${sortLabel(s)}</label>`
        )
        .join('')}
    </div>
    <div class="filter-tags"><h3>タグ</h3></div>
    <div class="filter-cours"><h3>クール</h3></div>
    <div class="filter-mark">
      <label><input type="checkbox" name="fav"> ♥ お気に入りだけ</label>
      <label><input type="checkbox" name="unwatched"> ✓ 未視聴だけ</label>
    </div>
  `
  container.appendChild(filterDiv)

  // ── 作品グリッド ─────────────────────────────────────────────
  const grid = document.createElement('div')
  grid.className = 'list-grid'
  grid.dataset.part = 'grid'

  const countInfo = document.createElement('p')
  countInfo.className = 'list-count'
  countInfo.textContent = `${totalCount}件`
  grid.appendChild(countInfo)

  works.forEach((work) => {
    const officialHref = seriesLink(work.seriesId) ?? ''
    const card = createSeriesCard(work.seriesId, work.title, work.thumbnailUrl, officialHref)
    grid.appendChild(card)
  })
  container.appendChild(grid)

  // ── ページング ───────────────────────────────────────────────
  const paginationDiv = document.createElement('div')
  paginationDiv.className = 'list-pagination'
  paginationDiv.dataset.part = 'pagination'

  const prevBtn = document.createElement('a')
  prevBtn.className = 'pagination-prev'
  prevBtn.dataset.nav = 'prev'
  prevBtn.textContent = '← 前'
  if (state.page > 1) {
    prevBtn.href = buildListUrl({ ...state, page: state.page - 1 })
  } else {
    prevBtn.setAttribute('aria-disabled', 'true')
  }

  const pageInfo = document.createElement('span')
  pageInfo.className = 'pagination-info'
  pageInfo.textContent = ` ${state.page} / ${totalPages} `

  const nextBtn = document.createElement('a')
  nextBtn.className = 'pagination-next'
  nextBtn.dataset.nav = 'next'
  nextBtn.textContent = '次 →'
  if (state.page < totalPages) {
    nextBtn.href = buildListUrl({ ...state, page: state.page + 1 })
  } else {
    nextBtn.setAttribute('aria-disabled', 'true')
  }

  paginationDiv.appendChild(prevBtn)
  paginationDiv.appendChild(pageInfo)
  paginationDiv.appendChild(nextBtn)
  container.appendChild(paginationDiv)
}
