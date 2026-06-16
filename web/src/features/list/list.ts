import type { Work, Tag, CoursGroup } from '../../data/types'
import type { ListState } from '../router'
import { buildListUrl } from '../router'
import { seriesLink } from '../../shared/deeplink'
import { card as createCard } from '../../components/card'
import { icon } from '../../components/icon'

export interface ListData {
  tags: Tag[]
  cours: CoursGroup[]
}

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
    data?: ListData
    favFilter?: boolean
    unwatchedFilter?: boolean
  }
): void {
  const {
    state,
    works,
    totalCount,
    totalPages,
    data,
    favFilter = false,
    unwatchedFilter = false,
  } = options
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
    const a = document.createElement('a')
    const isAll = row === '全'
    const isActive = state.row === (isAll ? '' : row)
    a.className = 'kana-btn' + (isActive ? ' active' : '')
    a.textContent = row
    a.dataset.row = row
    a.href = buildListUrl({ ...state, row: isAll ? '' : row, page: 1 })
    kanaDiv.appendChild(a)
  })
  container.appendChild(kanaDiv)

  // ── モバイル用フィルタ開閉ボタン（ドロワー・screens 準拠）──────
  const filterToggle = document.createElement('button')
  filterToggle.type = 'button'
  filterToggle.className = 'list-filter-toggle'
  filterToggle.textContent = '絞り込み・並び'
  filterToggle.setAttribute('aria-expanded', 'false')
  container.appendChild(filterToggle)

  // ── 本体（左フィルタ＋右グリッド）────────────────────────────
  const body = document.createElement('div')
  body.className = 'list-body'

  // ── 左フィルタ ───────────────────────────────────────────────
  const filterDiv = document.createElement('div')
  filterDiv.className = 'list-filter'
  filterDiv.dataset.part = 'filter'

  const sortSection = document.createElement('div')
  sortSection.className = 'filter-sort'
  const sortH3 = document.createElement('h3')
  sortH3.textContent = '並び替え '
  const sortInfo = document.createElement('button')
  sortInfo.className = 'info-btn'
  sortInfo.setAttribute('aria-label', '並び替えについて')
  sortInfo.title =
    '勢い順＝今の勢い（再生数と公開からの日数からの目安・正確な期間集計ではありません）／累計再生数順＝全期間の定番'
  sortInfo.appendChild(icon('info', 14))
  sortH3.appendChild(sortInfo)
  sortSection.appendChild(sortH3)
  ;(['hot', 'views', 'new', 'kana'] as const).forEach((s) => {
    const label = document.createElement('label')
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'sort'
    radio.value = s
    if (state.sort === s) radio.checked = true
    label.appendChild(radio)
    label.appendChild(document.createTextNode(' ' + sortLabel(s)))
    sortSection.appendChild(label)
  })
  filterDiv.appendChild(sortSection)

  // タグフィルタ（フラット1系統・別 facet なし）
  const tagsSection = document.createElement('div')
  tagsSection.className = 'filter-tags'
  const tagsH3 = document.createElement('h3')
  tagsH3.textContent = 'タグ'
  tagsSection.appendChild(tagsH3)
  if (data?.tags && data.tags.length > 0) {
    const tagList = document.createElement('ul')
    tagList.className = 'filter-tag-list'
    data.tags.slice(0, 30).forEach((tag) => {
      const li = document.createElement('li')
      const a = document.createElement('a')
      a.className = 'filter-tag-item' + (state.tag === tag.name ? ' active' : '')
      a.href = buildListUrl({ ...state, tag: state.tag === tag.name ? '' : tag.name, page: 1 })
      a.textContent = tag.name
      li.appendChild(a)
      tagList.appendChild(li)
    })
    tagsSection.appendChild(tagList)
  }
  filterDiv.appendChild(tagsSection)

  // クールフィルタ
  const coursSection = document.createElement('div')
  coursSection.className = 'filter-cours'
  const coursH3 = document.createElement('h3')
  coursH3.textContent = 'クール'
  coursSection.appendChild(coursH3)
  if (data?.cours && data.cours.length > 0) {
    const coursList = document.createElement('ul')
    coursList.className = 'filter-cours-list'
    data.cours.forEach((cg) => {
      const li = document.createElement('li')
      const a = document.createElement('a')
      a.className = 'filter-cours-item' + (state.cours === cg.cours ? ' active' : '')
      a.href = buildListUrl({ ...state, cours: state.cours === cg.cours ? '' : cg.cours, page: 1 })
      a.textContent = cg.cours
      li.appendChild(a)
      coursList.appendChild(li)
    })
    coursSection.appendChild(coursList)
  }
  filterDiv.appendChild(coursSection)

  const markSection = document.createElement('div')
  markSection.className = 'filter-mark'
  const favLabel = document.createElement('label')
  const favCb = document.createElement('input')
  favCb.type = 'checkbox'
  favCb.name = 'fav'
  favCb.checked = favFilter
  favLabel.appendChild(favCb)
  favLabel.appendChild(document.createTextNode(' ♥ お気に入りだけ'))
  const unwatchedLabel = document.createElement('label')
  const unwatchedCb = document.createElement('input')
  unwatchedCb.type = 'checkbox'
  unwatchedCb.name = 'unwatched'
  unwatchedCb.checked = unwatchedFilter
  unwatchedLabel.appendChild(unwatchedCb)
  unwatchedLabel.appendChild(document.createTextNode(' ✓ 未視聴だけ'))
  markSection.appendChild(favLabel)
  markSection.appendChild(unwatchedLabel)
  filterDiv.appendChild(markSection)

  body.appendChild(filterDiv)

  // モバイル: トグルでフィルタ（ドロワー）を開閉
  filterToggle.addEventListener('click', () => {
    const open = filterDiv.classList.toggle('open')
    filterToggle.setAttribute('aria-expanded', open ? 'true' : 'false')
  })

  // ── 右側: 件数＋グリッド＋ページング ─────────────────────────
  const results = document.createElement('div')
  results.className = 'list-results'

  const countInfo = document.createElement('p')
  countInfo.className = 'list-count'
  countInfo.textContent = `${totalCount}件`
  results.appendChild(countInfo)

  // ── 作品グリッド ─────────────────────────────────────────────
  const grid = document.createElement('div')
  grid.className = 'list-grid'
  grid.dataset.part = 'grid'

  if (works.length === 0) {
    // 0 件は空白を出さず、リセット誘導つきメッセージを出す（§18 状態マトリクス）
    const empty = document.createElement('p')
    empty.className = 'list-empty'
    empty.dataset.part = 'empty'
    const resetUrl = buildListUrl({ sort: state.sort })
    empty.appendChild(document.createTextNode('条件に一致する作品が見つかりませんでした。'))
    const resetLink = document.createElement('a')
    resetLink.className = 'list-empty-reset'
    resetLink.href = resetUrl
    resetLink.textContent = 'フィルタをリセット'
    empty.appendChild(resetLink)
    grid.appendChild(empty)
  } else {
    works.forEach((work) => {
      const officialHref = seriesLink(work.seriesId) ?? ''
      const card = createCard(work.seriesId, work.title, work.thumbnailUrl, officialHref)
      grid.appendChild(card)
    })
  }
  results.appendChild(grid)

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
  results.appendChild(paginationDiv)

  body.appendChild(results)
  container.appendChild(body)
}
