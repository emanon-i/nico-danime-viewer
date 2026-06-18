import type { Work, Tag, CoursGroup } from '../../data/types'
import type { ListState } from '../router'
import { buildListUrl, PAGE_SIZE_OPTIONS } from '../router'
import { seriesLink } from '../../shared/deeplink'
import { card as createCard } from '../../components/card'
import { icon } from '../../components/icon'
import { metaSpan, formatViews, formatRelativeTimeLatest } from '../../components/meta'
import type { MetaSpec } from '../../components/meta'
import { progressiveReveal } from '../../components/reveal'
import { coursList, toggleCours } from './filter'

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
      return '累計再生数'
    case 'new':
      return '最近更新'
    case 'created':
      return '新規'
    case 'kana':
      return '五十音順'
    case 'comments':
      return '累計コメント数'
    case 'avgViews':
      return '平均再生数'
    case 'avgComments':
      return '平均コメント数'
  }
}

const KANA_ROWS = ['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ', '全']

/** レンジスライダーの停止点（離散スナップ）。value=フィルタ値、label=読み上げ表示、tick=目盛り表示（任意） */
export interface RangeStop {
  value: number
  label: string
  tick?: string
}

/** レンジ絞り込み 1 本分の仕様（main.ts が状態とフィルタを持ち、ここは描画と通知のみ） */
export interface SliderSpec {
  name: string
  stops: RangeStop[]
  lowerIdx: number
  upperIdx: number
  onChange: (lowerIdx: number, upperIdx: number) => void
  /** ラベル横の ⓘ ツールチップ注記（§89・カスタムツールチップ）。任意。 */
  info?: string
}

/**
 * 2 ハンドルの離散レンジスライダー（CSP 準拠＝クラス/トークン）。
 * 0..n-1 のインデックスを取る range input を 2 つ重ね、停止点だけにスナップ（step=1）する。
 * トラック＋選択区間フィル＋（任意の）目盛りを描画。キーボード ←→ で停止点移動、
 * aria（valuemin/max/now/valuetext）対応、下限≦上限を保証する。確定時に onChange(loIdx,hiIdx)。
 */
function rangeSlider(opts: {
  label: string
  stops: RangeStop[]
  lowerIdx: number
  upperIdx: number
  onChange: (lowerIdx: number, upperIdx: number) => void
  info?: string
}): HTMLElement {
  const n = opts.stops.length
  const last = n - 1
  const pct = (i: number) => (last === 0 ? 0 : (i / last) * 100)

  const wrap = document.createElement('div')
  wrap.className = 'range-filter'
  const h = document.createElement('h3')
  h.appendChild(document.createTextNode(opts.label))
  // ラベル横の ⓘ 注記（§89・§46 カスタムツールチップ＝hover/focus/タップ開閉で統一）
  if (opts.info) {
    const infoBtn = document.createElement('button')
    infoBtn.type = 'button'
    infoBtn.className = 'info-btn'
    infoBtn.setAttribute('aria-label', `${opts.label}について`)
    infoBtn.dataset.tooltip = opts.info
    infoBtn.appendChild(icon('info', 14))
    h.appendChild(infoBtn)
  }
  wrap.appendChild(h)

  const slider = document.createElement('div')
  slider.className = 'range-slider'

  const track = document.createElement('div')
  track.className = 'range-track'
  const fill = document.createElement('div')
  fill.className = 'range-fill'
  slider.appendChild(track)
  slider.appendChild(fill)

  const mk = (val: number, cls: string, aria: string) => {
    const i = document.createElement('input')
    i.type = 'range'
    i.min = '0'
    i.max = String(last)
    i.step = '1'
    i.value = String(val)
    i.className = `range-input ${cls}`
    i.setAttribute('aria-label', aria)
    return i
  }
  const lower = mk(opts.lowerIdx, 'range-lower', `${opts.label} 下限`)
  const upper = mk(opts.upperIdx, 'range-upper', `${opts.label} 上限`)

  const readout = document.createElement('div')
  readout.className = 'range-readout'

  // 目盛り（停止点に tick があるときだけラベルを置く）
  const hasTicks = opts.stops.some((s) => s.tick)
  let ticks: HTMLElement | null = null
  if (hasTicks) {
    ticks = document.createElement('div')
    ticks.className = 'range-ticks'
    opts.stops.forEach((s, i) => {
      if (!s.tick) return // ラベルの無い停止点は描かない（年スライダーの中間など）
      const t = document.createElement('span')
      t.className = 'range-tick'
      // 両端ラベルは枠外にはみ出さないよう内側寄せ（左端=左寄せ／右端=右寄せ）
      if (i === 0) t.classList.add('range-tick-first')
      else if (i === last) t.classList.add('range-tick-last')
      t.style.setProperty('--at', `${pct(i)}%`)
      t.textContent = s.tick
      ticks!.appendChild(t)
    })
  }

  const idxs = (): [number, number] => {
    let a = Number(lower.value)
    let b = Number(upper.value)
    if (a > b) [a, b] = [b, a]
    return [a, b]
  }
  const render = () => {
    const [a, b] = idxs()
    fill.style.setProperty('--from', `${pct(a)}%`)
    fill.style.setProperty('--to', `${pct(b)}%`)
    lower.setAttribute('aria-valuetext', opts.stops[a].label)
    upper.setAttribute('aria-valuetext', opts.stops[b].label)
    readout.textContent = `${opts.stops[a].label} 〜 ${opts.stops[b].label}`
  }
  // 交差ガード: 動かしている側を相手側でクランプ（下限≦上限）
  const guard = (moved: 'lower' | 'upper') => {
    const a = Number(lower.value)
    const b = Number(upper.value)
    if (a > b) {
      if (moved === 'lower') lower.value = String(b)
      else upper.value = String(a)
    }
  }
  const commit = () => {
    const [a, b] = idxs()
    opts.onChange(a, b)
  }
  lower.addEventListener('input', () => {
    guard('lower')
    render()
  })
  upper.addEventListener('input', () => {
    guard('upper')
    render()
  })
  lower.addEventListener('change', commit)
  upper.addEventListener('change', commit)

  slider.appendChild(lower)
  slider.appendChild(upper)
  wrap.appendChild(slider)
  if (ticks) wrap.appendChild(ticks)
  wrap.appendChild(readout)
  render()
  return wrap
}

/**
 * タグ・トークン入力（オートコンプリート付き）＝§35。
 * - 確定タグはピル表示・[×]で個別削除。複数タグは AND（router/filter 側）。
 * - 入力が `#` 始まりでタグモード（候補ドロップダウン）。プレーンテキストは作品名検索(q)。
 * - キーボード: ↑↓ で候補移動 / Enter で確定 / Esc で閉じる / 空 Backspace で末尾ピル削除。
 * - role=combobox + listbox（aria-expanded / aria-activedescendant）。
 * - 候補はクライアントのタグ一覧（出現頻度＝seriesCount 降順）から前方/部分一致で。
 * - サイドバー選択・適用中バー(§16)とは同じ state.tags を見るため自動同期。
 */
function buildTagSearch(
  state: ListState,
  tags: Tag[],
  onNavigate: (next: ListState) => void
): HTMLElement {
  const root = document.createElement('div')
  root.className = 'tag-search'

  const field = document.createElement('div')
  field.className = 'tag-search-field'
  root.appendChild(field)

  const makePill = (text: string, aria: string, onRemove: () => void): HTMLElement => {
    const pill = document.createElement('span')
    pill.className = 'tag-pill'
    const label = document.createElement('span')
    label.className = 'tag-pill-label'
    label.textContent = text
    pill.appendChild(label)
    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'tag-pill-x'
    x.textContent = '×'
    x.setAttribute('aria-label', `${aria} を外す`)
    x.addEventListener('click', onRemove)
    pill.appendChild(x)
    return pill
  }

  // ピル: 作品名検索(q) ＋ 選択タグ群
  if (state.q) {
    field.appendChild(
      makePill(`「${state.q}」`, `検索 ${state.q}`, () => onNavigate({ ...state, q: '', page: 1 }))
    )
  }
  for (const t of state.tags) {
    field.appendChild(
      makePill(`#${t}`, `タグ ${t}`, () =>
        onNavigate({ ...state, tags: state.tags.filter((x) => x !== t), page: 1 })
      )
    )
  }

  const input = document.createElement('input')
  // type=search＋enterKeyHint=search で、モバイルのソフトキーボードに「次へ」ではなく
  // 「検索」アクションを出す（§83）。text のままだと確定でフォーカスが次要素＝件数 select に
  // 飛んでしまう。Top のヒーロー検索（type=search）と同作法に揃える。
  input.type = 'search'
  input.enterKeyHint = 'search'
  input.className = 'tag-search-input'
  input.autocomplete = 'off'
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-expanded', 'false')
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-controls', 'tag-search-listbox')
  input.setAttribute('aria-label', '作品名で検索、または # でタグを絞り込み')
  input.placeholder =
    state.q || state.tags.length > 0 ? 'さらに絞り込む（#タグ可）…' : '作品・#タグで検索…'
  field.appendChild(input)

  const listbox = document.createElement('ul')
  listbox.className = 'tag-search-listbox'
  listbox.id = 'tag-search-listbox'
  listbox.setAttribute('role', 'listbox')
  listbox.hidden = true
  root.appendChild(listbox)

  let options: Tag[] = []
  let active = -1
  const optId = (i: number) => `tag-opt-${i}`

  const close = () => {
    listbox.hidden = true
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
    active = -1
  }

  const addTag = (name: string) =>
    onNavigate({
      ...state,
      tags: state.tags.includes(name) ? state.tags : [...state.tags, name],
      page: 1,
    })

  const setActive = (i: number) => {
    const items = listbox.querySelectorAll<HTMLElement>('.tag-search-option')
    items.forEach((el, idx) => {
      el.classList.toggle('active', idx === i)
      el.setAttribute('aria-selected', idx === i ? 'true' : 'false')
    })
    active = i
    if (i >= 0 && items[i]) {
      input.setAttribute('aria-activedescendant', optId(i))
      items[i].scrollIntoView({ block: 'nearest' })
    } else {
      input.removeAttribute('aria-activedescendant')
    }
  }

  const renderOptions = (term: string) => {
    const q = term.toLowerCase().trim()
    const selected = new Set(state.tags)
    options = tags
      .filter((t) => !selected.has(t.name) && t.name.toLowerCase().includes(q))
      .sort((a, b) => b.seriesCount - a.seriesCount)
      .slice(0, 10)
    listbox.innerHTML = ''
    if (options.length === 0) {
      close()
      return
    }
    options.forEach((t, i) => {
      const li = document.createElement('li')
      li.className = 'tag-search-option'
      li.id = optId(i)
      li.setAttribute('role', 'option')
      li.setAttribute('aria-selected', 'false')
      const name = document.createElement('span')
      name.className = 'opt-name'
      name.textContent = `#${t.name}`
      const cnt = document.createElement('span')
      cnt.className = 'opt-count'
      cnt.textContent = `${t.seriesCount}作品`
      li.appendChild(name)
      li.appendChild(cnt)
      // mousedown（click より先・preventDefault で input の blur を防ぐ）で確定
      li.addEventListener('mousedown', (e) => {
        e.preventDefault()
        addTag(t.name)
      })
      listbox.appendChild(li)
    })
    active = -1
    listbox.hidden = false
    input.setAttribute('aria-expanded', 'true')
  }

  input.addEventListener('input', () => {
    const v = input.value
    if (v.startsWith('#')) renderOptions(v.slice(1))
    else close()
  })

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' && !listbox.hidden) {
      e.preventDefault()
      setActive(Math.min(active + 1, options.length - 1))
    } else if (e.key === 'ArrowUp' && !listbox.hidden) {
      e.preventDefault()
      setActive(Math.max(active - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (!listbox.hidden && active >= 0 && options[active]) {
        addTag(options[active].name)
        return
      }
      const v = input.value.trim()
      if (v.startsWith('#')) {
        const term = v.slice(1).trim()
        if (!term) return
        const exact = tags.find((t) => t.name === term && !state.tags.includes(t.name))
        if (exact) addTag(exact.name)
        else if (options[0]) addTag(options[0].name)
      } else if (v) {
        onNavigate({ ...state, q: v, page: 1 })
      }
    } else if (e.key === 'Escape' && !listbox.hidden) {
      e.preventDefault()
      close()
    } else if (e.key === 'Backspace' && input.value === '') {
      // 空で Backspace → 末尾ピル（タグ優先、無ければ検索クエリ）を外す
      if (state.tags.length > 0) {
        e.preventDefault()
        onNavigate({ ...state, tags: state.tags.slice(0, -1), page: 1 })
      } else if (state.q) {
        e.preventDefault()
        onNavigate({ ...state, q: '', page: 1 })
      }
    }
  })

  // フィールド余白クリックで入力へフォーカス・blur で候補を閉じる（外側クリック対策）
  field.addEventListener('click', (e) => {
    if (e.target === field) input.focus()
  })
  input.addEventListener('blur', () => {
    // option の mousedown は preventDefault でフォーカス維持するため、ここは外側クリック時のみ
    window.setTimeout(close, 0)
  })

  return root
}

/**
 * ページネーション用の数列を生成する（数字 + '…' 省略）。
 * 両端（1 / total）と current±delta の範囲を表示し、間が 2 以上あれば '…' を挿入する。
 */
function paginationPages(current: number, total: number, delta: number): (number | '…')[] {
  if (total <= 1) return []
  const set = new Set<number>([1, total])
  for (let p = Math.max(1, current - delta); p <= Math.min(total, current + delta); p++) set.add(p)
  const sorted = [...set].sort((a, b) => a - b)
  const result: (number | '…')[] = []
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) result.push('…')
    result.push(sorted[i])
  }
  return result
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
    /** 空シェル（中身のない項目）も表示するか（§63・既定 false） */
    showEmptyFilter?: boolean
    /** 選択中の並び替えに応じたカード下キャプション指標（Hot＝[flame]数値・新着＝[clock]投稿時間 等・§5） */
    cardMetric?: (work: Work) => MetaSpec | null
    /** お気に入り/未視聴フィルタ解除（適用中バーの [×]・§16） */
    onClearFav?: () => void
    onClearUnwatched?: () => void
    onClearShowEmpty?: () => void
    /** 再生時間（離散スナップ・上限なし可）/ 投稿年 のレンジ絞り込み（§23・停止点インデックス方式） */
    sliders?: { duration: SliderSpec; year: SliderSpec }
    /** タグ・トークン検索の確定時に呼ぶ遷移（§35）。未指定時はプレーン入力にフォールバック */
    onSearch?: (next: ListState) => void
    /** サイドバーのタグ/クール選択を SPA 遷移する（§91）。指定時は全リロードせず再描画＝
     * モバイルのドロワーを開いたまま連続選択できる。未指定なら従来の `<a href>` 全リロード。 */
    onNavigate?: (next: ListState) => void
    /** モバイルのフィルタ/並びドロワーの開閉状態（§91・再描画をまたいで保持）。 */
    filterOpen?: boolean
    /** ドロワー開閉トグル通知（§91・呼び出し側が状態を保持して次の描画に反映する）。 */
    onToggleFilter?: (open: boolean) => void
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
    showEmptyFilter = false,
    cardMetric,
    onClearFav,
    onClearUnwatched,
    onClearShowEmpty,
    sliders,
    onSearch,
    onNavigate,
    filterOpen = false,
    onToggleFilter,
  } = options
  // フィルタ再描画前にスクロール位置を保持（再描画後に復元）
  const savedTagScroll = container.querySelector<HTMLElement>('.filter-tag-list')?.scrollTop ?? 0
  const savedCoursScroll =
    container.querySelector<HTMLElement>('.filter-cours-list')?.scrollTop ?? 0
  container.innerHTML = ''

  // サイドバーのタグ/クール選択を SPA 遷移化（§91）。onNavigate 指定時は全リロードせず
  // 再描画に切替＝モバイルのドロワーを開いたまま連続選択できる。修飾キー/中クリックは素通し
  // （新規タブを尊重）。href は維持＝アクセシビリティ/共有も従来どおり。
  const wireSpaLink = (a: HTMLAnchorElement, next: ListState): void => {
    if (!onNavigate) return
    a.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      e.preventDefault()
      onNavigate(next)
    })
  }

  // ── 検索バー（タグ・トークン入力＝§35）────────────────────────
  const searchBar = document.createElement('div')
  searchBar.className = 'list-search'
  searchBar.dataset.part = 'search'
  if (onSearch) {
    searchBar.appendChild(buildTagSearch(state, data?.tags ?? [], onSearch))
  } else {
    // フォールバック（onSearch 未指定）＝従来のプレーン検索入力
    const searchInput = document.createElement('input')
    searchInput.type = 'search'
    searchInput.className = 'list-search-input'
    searchInput.value = state.q
    searchInput.placeholder = '作品・タグで検索…'
    searchInput.setAttribute('aria-label', '作品・タグで検索')
    searchBar.appendChild(searchInput)
  }
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
  sortInfo.dataset.tooltip =
    'Hot＝今の勢い（再生数と公開からの日数からの目安・正確な期間集計ではありません）／累計再生数順＝全期間の定番'
  sortInfo.appendChild(icon('info', 14))
  sortH3.appendChild(sortInfo)
  sortSection.appendChild(sortH3)
  // 並び替え選択肢（CSS で 2 列に並べる＝§21）
  const sortGrid = document.createElement('div')
  sortGrid.className = 'sort-options'
  ;(
    ['hot', 'views', 'avgViews', 'new', 'created', 'comments', 'avgComments', 'kana'] as const
  ).forEach((s) => {
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

  // 並び替え方向の共通トグル（§41）。選択中キーに対して 1 つだけ・既定 降順。
  const dirToggle = document.createElement('button')
  dirToggle.type = 'button'
  dirToggle.className = 'sort-dir-toggle'
  dirToggle.dataset.part = 'sort-dir'
  dirToggle.setAttribute('aria-pressed', state.dir === 'asc' ? 'true' : 'false')
  dirToggle.textContent = state.dir === 'asc' ? '昇順 ▲' : '降順 ▼'
  dirToggle.setAttribute(
    'aria-label',
    `並び順の方向: 現在 ${state.dir === 'asc' ? '昇順' : '降順'}（押すと切替）`
  )
  sortSection.appendChild(dirToggle)
  // ※ filterDiv への追加は末尾でまとめて順序制御（§66）

  // タグフィルタ（フラット1系統・別 facet なし）
  const tagsSection = document.createElement('div')
  tagsSection.className = 'filter-tags'
  const tagsH3 = document.createElement('h3')
  tagsH3.textContent = 'タグ'
  tagsSection.appendChild(tagsH3)
  if (data?.tags && data.tags.length > 0) {
    // 頻度順で一定数だけ表示＋もっと見る/閉じる（クールと同一作法＝§33/§34）
    const tagList = document.createElement('ul')
    tagList.className = 'filter-tag-list'
    const tags = data.tags
    const makeTagItem = (i: number): HTMLElement => {
      const tag = tags[i]
      const li = document.createElement('li')
      li.className = 'filter-tag-li'
      const a = document.createElement('a')
      const active = state.tags.includes(tag.name)
      a.className = 'filter-tag-item' + (active ? ' active' : '')
      // クリックでタグの ON/OFF をトグル（複数選択＝AND・§35）。サイドバー選択と
      // 検索トークン/適用中バーは同じ state.tags を見るので自動で同期する。
      const next: ListState = {
        ...state,
        tags: active ? state.tags.filter((t) => t !== tag.name) : [...state.tags, tag.name],
        page: 1,
      }
      a.href = buildListUrl(next)
      a.textContent = tag.name
      wireSpaLink(a, next) // §91: モバイルのドロワーを開いたまま連続選択
      li.appendChild(a)
      return li
    }
    progressiveReveal(tagList, tags.length, makeTagItem, {
      initial: 12,
      step: 18,
      itemClass: 'filter-tag-li',
      stateKey: 'reveal:list-tags', // 展開件数をページ移動間で保持（§B）
    })
    tagsSection.appendChild(tagList)
  }
  // ※ filterDiv への追加は末尾でまとめて順序制御（§66）

  // クールフィルタ
  const coursSection = document.createElement('div')
  coursSection.className = 'filter-cours'
  const coursH3 = document.createElement('h3')
  coursH3.textContent = 'クール'
  coursSection.appendChild(coursH3)
  if (data?.cours && data.cours.length > 0) {
    // 直近の数件だけ表示＋もっと見る/閉じる（Top「クールから探す」と同一作法＝§30/§34）
    const coursListEl = document.createElement('ul')
    coursListEl.className = 'filter-cours-list'
    const cours = data.cours
    const makeCoursItem = (i: number): HTMLElement => {
      const cg = cours[i]
      const li = document.createElement('li')
      li.className = 'filter-cours-li'
      const a = document.createElement('a')
      const selected = coursList(state.cours).includes(cg.cours)
      a.className = 'filter-cours-item' + (selected ? ' active' : '')
      // 複数選択＝追加式トグル（§90）。含まれていれば外し、無ければ足す。
      const next: ListState = { ...state, cours: toggleCours(state.cours, cg.cours), page: 1 }
      a.href = buildListUrl(next)
      a.textContent = cg.cours
      wireSpaLink(a, next) // §91: ドロワーを開いたまま連続選択
      li.appendChild(a)
      return li
    }
    progressiveReveal(coursListEl, cours.length, makeCoursItem, {
      initial: 8,
      step: 12,
      itemClass: 'filter-cours-li',
      stateKey: 'reveal:list-cours', // 展開件数をページ移動間で保持（§B）
    })
    coursSection.appendChild(coursListEl)
  }
  // ※ filterDiv への追加は末尾でまとめて順序制御（§66）

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
  // 「取得できていないシリーズも表示」(§63/§67) は設定(⚙)へ移動したのでサイドバーには出さない。
  markSection.appendChild(favLabel)
  markSection.appendChild(unwatchedLabel)

  // ── 再生時間／投稿年 レンジ絞り込み（§23）。個別に並べ替えできるよう要素化（§66）──
  const mkSlider = (spec: SliderSpec): HTMLElement =>
    rangeSlider({
      label: spec.name,
      stops: spec.stops,
      lowerIdx: spec.lowerIdx,
      upperIdx: spec.upperIdx,
      onChange: spec.onChange,
      info: spec.info,
    })
  const durationSlider = sliders ? mkSlider(sliders.duration) : null
  const yearSlider = sliders ? mkSlider(sliders.year) : null

  // サイドバーのセクション順（§66）: 並び替え → マーク(お気に入り/未視聴) → 再生時間 →
  // 投稿年 → クール → タグ。
  filterDiv.appendChild(sortSection)
  filterDiv.appendChild(markSection)
  if (durationSlider) filterDiv.appendChild(durationSlider)
  if (yearSlider) filterDiv.appendChild(yearSlider)
  filterDiv.appendChild(coursSection)
  filterDiv.appendChild(tagsSection)

  body.appendChild(filterDiv)

  // モバイル: トグルでフィルタ（ドロワー）を開閉。開閉状態は再描画をまたいで保持する（§91）＝
  // タグ/クールを選んでも（SPA 再描画されても）ドロワーが閉じず連続選択できる。
  if (filterOpen) {
    filterDiv.classList.add('open')
    filterToggle.setAttribute('aria-expanded', 'true')
  }
  filterToggle.addEventListener('click', () => {
    const open = filterDiv.classList.toggle('open')
    filterToggle.setAttribute('aria-expanded', open ? 'true' : 'false')
    onToggleFilter?.(open)
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
  // 並び替えキー＋方向を反映（§41）。五十音は方向語が不自然なので順序の昇降のみ付す。
  sortChip.textContent = `${sortLabel(state.sort)}・${state.dir === 'asc' ? '昇順' : '降順'}`
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
  // タグは選択ごとに 1 チップ。[×] はそのタグだけ外す（§35）。
  for (const t of state.tags) {
    addLinkChip(`タグ「${t}」`, { ...state, tags: state.tags.filter((x) => x !== t) })
  }
  // クールは選択ごとに 1 チップ。[×] はそのクールだけ外す（複数選択＝§90）。
  for (const c of coursList(state.cours)) {
    const coursLabel = c === 'current' ? '今期' : c === 'previous' ? '前期' : `クール「${c}」`
    addLinkChip(coursLabel, { ...state, cours: toggleCours(state.cours, c) })
  }
  if (state.row) addLinkChip(`${state.row}行`, { ...state, row: '' })
  if (favFilter) addBtnChip('♥ お気に入り', onClearFav)
  if (unwatchedFilter) addBtnChip('✓ 未視聴', onClearUnwatched)
  if (showEmptyFilter) addBtnChip('取得できていないシリーズも表示', onClearShowEmpty)
  if (sliders) {
    for (const spec of [sliders.duration, sliders.year]) {
      const lastIdx = spec.stops.length - 1
      // 既定（下限 0・上限 末尾）以外なら適用中チップ＋[×]（既定に戻す）
      if (spec.lowerIdx > 0 || spec.upperIdx < lastIdx) {
        const label = `${spec.name} ${spec.stops[spec.lowerIdx].label}〜${spec.stops[spec.upperIdx].label}`
        addBtnChip(label, () => spec.onChange(0, lastIdx))
      }
    }
  }

  // 表示件数セレクタ（§42）。選択中＝state.size。変更で 1 ページ目から再描画。
  const sizeWrap = document.createElement('label')
  sizeWrap.className = 'list-size'
  sizeWrap.appendChild(document.createTextNode('表示件数 '))
  const sizeSelect = document.createElement('select')
  sizeSelect.className = 'list-size-select'
  sizeSelect.dataset.part = 'size'
  for (const opt of PAGE_SIZE_OPTIONS) {
    const o = document.createElement('option')
    o.value = String(opt)
    o.textContent = `${opt}件`
    if (opt === state.size) o.selected = true
    sizeSelect.appendChild(o)
  }
  sizeWrap.appendChild(sizeSelect)
  applied.appendChild(sizeWrap)

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
      // カード外枠下の常時メタ（§93）＝[film]話数 ＋ [play]総再生回数 ＋ [history]投稿日(最新話)。
      // この 3 点は常に出す。並び替え連動メタ（§32）は、現在の sort 値がこの 3 点に
      // 含まれない場合だけ追加する（views=総再生 / new=投稿日 は二重表示しないため cardMetric が
      // null を返す。created=初話 / comments / 平均系 / hot は別値なので追加）。
      const metas: MetaSpec[] = []
      if (work.episodeCount) {
        metas.push({
          icon: 'film',
          value: `${work.episodeCount}話`,
          label: `全${work.episodeCount}話`,
        })
      }
      if (typeof work.totalViews === 'number' && work.totalViews > 0) {
        const v = formatViews(work.totalViews)
        metas.push({ icon: 'play', value: v, label: `総再生回数 ${v}` })
      }
      if (work.latestAt) {
        const rel = formatRelativeTimeLatest(work.latestAt)
        if (rel) metas.push({ icon: 'history', value: rel, label: `最新話投稿 ${rel}` })
      }
      const metric = cardMetric?.(work)
      // 並び替え連動メタは、表示文字列(value)が常時メタのいずれかと一致する場合は描画しない
      // （重複排除・§E）。例: created(初話)で firstAt===latestAt のとき投稿日と同一表示になる→抑制。
      if (metric && !metas.some((m) => m.value === metric.value)) {
        metas.push({ ...metric, emphasize: true })
      }
      if (metas.length > 0) {
        const cap = document.createElement('div')
        cap.className = 'card-caption'
        for (const m of metas) cap.appendChild(metaSpan(m))
        cell.appendChild(cap)
      }
      grid.appendChild(cell)
    })
  }
  results.appendChild(grid)

  // ── ページング ───────────────────────────────────────────────
  const paginationNav = document.createElement('nav')
  paginationNav.className = 'list-pagination'
  paginationNav.setAttribute('aria-label', 'ページネーション')
  paginationNav.dataset.part = 'pagination'

  // 表示範囲（N–M件 / 全K件）
  const rangeEl = document.createElement('span')
  rangeEl.className = 'pagination-range'
  if (totalCount > 0) {
    const s = (state.page - 1) * state.size + 1
    const e = Math.min(state.page * state.size, totalCount)
    rangeEl.textContent = `${s}–${e}件 / 全${totalCount}件`
  }
  paginationNav.appendChild(rangeEl)

  // ページボタン群
  const btnRow = document.createElement('div')
  btnRow.className = 'pagination-btns'
  btnRow.setAttribute('role', 'group')
  btnRow.setAttribute('aria-label', 'ページ選択')

  // ページ遷移の SPA wiring + 再描画後に一覧先頭へスクロール
  const wirePaginate = (a: HTMLAnchorElement, next: ListState): void => {
    if (!onNavigate) return
    a.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      e.preventDefault()
      onNavigate(next)
      // render() は await ensureData() 後に同期的に実行される（キャッシュ温）ため
      // rAF タイミングでは DOM 確定済み → 一覧先頭へスクロール
      requestAnimationFrame(() => container.scrollIntoView({ block: 'start' }))
    })
  }

  // 前後・両端ナビボタン（« ‹ › »）
  const makeNavBtn = (
    label: string,
    symbol: string,
    targetPage: number,
    disabled: boolean
  ): HTMLAnchorElement => {
    const a = document.createElement('a')
    a.className = 'pagination-btn pagination-nav' + (disabled ? ' disabled' : '')
    a.setAttribute('aria-label', label)
    if (disabled) {
      a.setAttribute('aria-disabled', 'true')
    } else {
      const next = { ...state, page: targetPage }
      a.href = buildListUrl(next)
      wirePaginate(a, next)
    }
    const sym = document.createElement('span')
    sym.textContent = symbol
    sym.setAttribute('aria-hidden', 'true')
    a.appendChild(sym)
    return a
  }

  btnRow.appendChild(makeNavBtn('最初のページ', '«', 1, state.page <= 1))
  btnRow.appendChild(makeNavBtn('前のページ', '‹', state.page - 1, state.page <= 1))

  // 数字ページ＋省略（デスクトップ delta=2 / モバイル delta=1）
  const delta = window.innerWidth < 768 ? 1 : 2
  for (const p of paginationPages(state.page, totalPages, delta)) {
    if (p === '…') {
      const el = document.createElement('span')
      el.className = 'pagination-ellipsis'
      el.textContent = '…'
      el.setAttribute('aria-hidden', 'true')
      btnRow.appendChild(el)
    } else {
      const isCurrent = p === state.page
      const a = document.createElement('a')
      a.className = 'pagination-btn pagination-num' + (isCurrent ? ' current' : '')
      a.textContent = String(p)
      if (isCurrent) {
        a.setAttribute('aria-current', 'page')
        a.setAttribute('aria-label', `${p}ページ（現在）`)
      } else {
        const next = { ...state, page: p }
        a.href = buildListUrl(next)
        a.setAttribute('aria-label', `${p}ページへ`)
        wirePaginate(a, next)
      }
      btnRow.appendChild(a)
    }
  }

  btnRow.appendChild(makeNavBtn('次のページ', '›', state.page + 1, state.page >= totalPages))
  btnRow.appendChild(makeNavBtn('最後のページ', '»', totalPages, state.page >= totalPages))

  paginationNav.appendChild(btnRow)
  results.appendChild(paginationNav)

  body.appendChild(results)
  container.appendChild(body)

  // スクロール位置を復元（再描画後に DOM が確定した時点で）
  const restoredTagList = container.querySelector<HTMLElement>('.filter-tag-list')
  if (restoredTagList && savedTagScroll > 0) restoredTagList.scrollTop = savedTagScroll
  const restoredCoursList = container.querySelector<HTMLElement>('.filter-cours-list')
  if (restoredCoursList && savedCoursScroll > 0) restoredCoursList.scrollTop = savedCoursScroll
}
