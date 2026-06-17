import type { Work, Tag, CoursGroup } from '../../data/types'
import type { ListState } from '../router'
import { buildListUrl } from '../router'
import { seriesLink } from '../../shared/deeplink'
import { card as createCard } from '../../components/card'
import { icon } from '../../components/icon'
import { metaSpan } from '../../components/meta'
import type { MetaSpec } from '../../components/meta'

export interface ListData {
  tags: Tag[]
  cours: CoursGroup[]
}

type SortKey = ListState['sort']

function sortLabel(sort: SortKey): string {
  switch (sort) {
    case 'hot':
      return 'Hot'
    case 'views':
      return '再生数(累計)'
    case 'new':
      return '新着'
    case 'kana':
      return '五十音順'
    case 'comments':
      return '総コメント数'
  }
}

const KANA_ROWS = ['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ', '全']

/**
 * 2 ハンドルのレンジスライダー（CSP 準拠＝クラス/トークン・a11y は range input ネイティブ）。
 * 下限/上限の 2 つの range input を重ね、確定時に onChange(a,b) を呼ぶ。
 */
function rangeSlider(opts: {
  label: string
  bound: [number, number]
  min: number
  max: number
  fmt: (n: number) => string
  onChange: (a: number, b: number) => void
}): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'range-filter'
  const h = document.createElement('h3')
  h.textContent = opts.label
  wrap.appendChild(h)

  const slider = document.createElement('div')
  slider.className = 'range-slider'
  const [lo, hi] = opts.bound
  const mk = (val: number, cls: string, aria: string) => {
    const i = document.createElement('input')
    i.type = 'range'
    i.min = String(lo)
    i.max = String(hi)
    i.value = String(val)
    i.className = cls
    i.setAttribute('aria-label', aria)
    return i
  }
  const lower = mk(opts.min, 'range-lower', `${opts.label} 下限`)
  const upper = mk(opts.max, 'range-upper', `${opts.label} 上限`)
  const readout = document.createElement('div')
  readout.className = 'range-readout'
  const pair = () => {
    let a = Number(lower.value)
    let b = Number(upper.value)
    if (a > b) [a, b] = [b, a]
    return [a, b] as [number, number]
  }
  const sync = () => {
    const [a, b] = pair()
    readout.textContent = `${opts.fmt(a)} 〜 ${opts.fmt(b)}`
  }
  const commit = () => {
    const [a, b] = pair()
    opts.onChange(a, b)
  }
  lower.addEventListener('input', sync)
  upper.addEventListener('input', sync)
  lower.addEventListener('change', commit)
  upper.addEventListener('change', commit)
  slider.appendChild(lower)
  slider.appendChild(upper)
  wrap.appendChild(slider)
  wrap.appendChild(readout)
  sync()
  return wrap
}

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
    /** 選択中の並び替えに応じたカード下キャプション指標（Hot＝[flame]数値・新着＝[clock]投稿時間 等・§5） */
    cardMetric?: (work: Work) => MetaSpec | null
    /** お気に入り/未視聴フィルタ解除（適用中バーの [×]・§16） */
    onClearFav?: () => void
    onClearUnwatched?: () => void
    /** 再生時間（平均話長・分）/ 投稿年 のレンジ絞り込み（§23） */
    sliders?: {
      len: {
        min: number
        max: number
        bound: [number, number]
        onChange: (a: number, b: number) => void
      }
      year: {
        min: number
        max: number
        bound: [number, number]
        onChange: (a: number, b: number) => void
      }
    }
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
    cardMetric,
    onClearFav,
    onClearUnwatched,
    sliders,
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
    'Hot＝今の勢い（再生数と公開からの日数からの目安・正確な期間集計ではありません）／累計再生数順＝全期間の定番'
  sortInfo.appendChild(icon('info', 14))
  sortH3.appendChild(sortInfo)
  sortSection.appendChild(sortH3)
  // 並び替え選択肢（CSS で 2 列に並べる＝§21）
  const sortGrid = document.createElement('div')
  sortGrid.className = 'sort-options'
  ;(['hot', 'views', 'new', 'comments', 'kana'] as const).forEach((s) => {
    const label = document.createElement('label')
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'sort'
    radio.value = s
    if (state.sort === s) radio.checked = true
    label.appendChild(radio)
    label.appendChild(document.createTextNode(' ' + sortLabel(s)))
    sortGrid.appendChild(label)
  })
  sortSection.appendChild(sortGrid)
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
  favLabel.appendChild(document.createTextNode(' ♥ お気に入り'))
  const unwatchedLabel = document.createElement('label')
  const unwatchedCb = document.createElement('input')
  unwatchedCb.type = 'checkbox'
  unwatchedCb.name = 'unwatched'
  unwatchedCb.checked = unwatchedFilter
  unwatchedLabel.appendChild(unwatchedCb)
  unwatchedLabel.appendChild(document.createTextNode(' ✓ 未視聴'))
  markSection.appendChild(favLabel)
  markSection.appendChild(unwatchedLabel)
  filterDiv.appendChild(markSection)

  // ── 再生時間（平均話長・分）／投稿年 レンジ絞り込み（§23）──────────
  if (sliders) {
    filterDiv.appendChild(
      rangeSlider({
        label: '再生時間',
        bound: sliders.len.bound,
        min: sliders.len.min,
        max: sliders.len.max,
        fmt: (n) => `${n}分`,
        onChange: sliders.len.onChange,
      })
    )
    filterDiv.appendChild(
      rangeSlider({
        label: '投稿年',
        bound: sliders.year.bound,
        min: sliders.year.min,
        max: sliders.year.max,
        fmt: (n) => `${n}`,
        onChange: sliders.year.onChange,
      })
    )
  }

  body.appendChild(filterDiv)

  // モバイル: トグルでフィルタ（ドロワー）を開閉
  filterToggle.addEventListener('click', () => {
    const open = filterDiv.classList.toggle('open')
    filterToggle.setAttribute('aria-expanded', open ? 'true' : 'false')
  })

  // ── 右側: 件数＋グリッド＋ページング ─────────────────────────
  const results = document.createElement('div')
  results.className = 'list-results'

  // ── 適用中バー（並び替え・フィルタ・件数を可視化＝§16）──────────
  const applied = document.createElement('div')
  applied.className = 'list-applied'
  applied.dataset.part = 'applied'

  const countEl = document.createElement('span')
  countEl.className = 'applied-count'
  countEl.textContent = `${totalCount}件`
  applied.appendChild(countEl)

  const sortChip = document.createElement('span')
  sortChip.className = 'applied-chip applied-sort'
  sortChip.textContent = `${sortLabel(state.sort)}順`
  applied.appendChild(sortChip)

  const addLinkChip = (label: string, removeState: Partial<ListState>) => {
    const chip = document.createElement('span')
    chip.className = 'applied-chip'
    const t = document.createElement('span')
    t.textContent = label
    chip.appendChild(t)
    const x = document.createElement('a')
    x.className = 'applied-x'
    x.href = buildListUrl({ ...removeState, page: 1 })
    x.textContent = '×'
    x.setAttribute('aria-label', `${label} を解除`)
    chip.appendChild(x)
    applied.appendChild(chip)
  }
  const addBtnChip = (label: string, onClear?: () => void) => {
    const chip = document.createElement('span')
    chip.className = 'applied-chip'
    const t = document.createElement('span')
    t.textContent = label
    chip.appendChild(t)
    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'applied-x'
    x.textContent = '×'
    x.setAttribute('aria-label', `${label} を解除`)
    if (onClear) x.addEventListener('click', onClear)
    chip.appendChild(x)
    applied.appendChild(chip)
  }

  if (state.q) addLinkChip(`検索「${state.q}」`, { ...state, q: '' })
  if (state.tag) addLinkChip(`タグ「${state.tag}」`, { ...state, tag: '' })
  if (state.cours) addLinkChip(`クール「${state.cours}」`, { ...state, cours: '' })
  if (state.row) addLinkChip(`${state.row}行`, { ...state, row: '' })
  if (favFilter) addBtnChip('♥ お気に入り', onClearFav)
  if (unwatchedFilter) addBtnChip('✓ 未視聴', onClearUnwatched)
  if (sliders) {
    const l = sliders.len
    if (l.min > l.bound[0] || l.max < l.bound[1])
      addBtnChip(`再生時間 ${l.min}〜${l.max}分`, () => l.onChange(l.bound[0], l.bound[1]))
    const y = sliders.year
    if (y.min > y.bound[0] || y.max < y.bound[1])
      addBtnChip(`投稿年 ${y.min}〜${y.max}`, () => y.onChange(y.bound[0], y.bound[1]))
  }

  results.appendChild(applied)

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
      const cell = document.createElement('div')
      cell.className = 'card-cell'
      cell.appendChild(createCard(work.seriesId, work.title, work.thumbnailUrl, officialHref))
      // カード外枠下に、選択中の並び替えに応じた指標を表示（§5）
      const metric = cardMetric?.(work)
      if (metric) {
        const cap = document.createElement('div')
        cap.className = 'card-caption'
        cap.appendChild(metaSpan(metric))
        cell.appendChild(cap)
      }
      grid.appendChild(cell)
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
