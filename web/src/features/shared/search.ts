import { buildListUrl } from '../router'
import type { Tag } from '../../data/types'
import { attachTagAutocomplete } from './tag-autocomplete'

/** ヘッダ🔍の展開/折畳みを初期化する。戻り値は collapse 関数。 */
export function initHeaderSearch(
  searchBtn: HTMLElement,
  navigate: (url: string) => void,
  tags: Tag[] = []
): () => void {
  // 再レンダリングで重複しないよう既存オーバーレイを除去（body 直下に残るため）
  document.querySelectorAll('.header-search-overlay').forEach((e) => e.remove())

  // ヘッダ直下に被さる固定オーバーレイ（他要素を押し出さない＝展開でレイアウトが崩れない）
  const searchBar = document.createElement('div')
  searchBar.className = 'header-search-overlay'
  searchBar.hidden = true

  // 補完ドロップダウンを input 幅に揃えるための position:relative ラッパ（§35 共通）
  const acWrap = document.createElement('div')
  acWrap.className = 'header-search-acwrap'

  const input = document.createElement('input')
  input.type = 'search'
  input.className = 'header-search-input'
  input.placeholder = '作品・#タグで検索…'
  input.setAttribute('aria-label', '作品・タグで検索')

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'header-search-close icon-btn'
  closeBtn.textContent = '×'
  closeBtn.setAttribute('aria-label', '検索を閉じる')

  acWrap.appendChild(input)
  searchBar.appendChild(acWrap)
  searchBar.appendChild(closeBtn)
  // header の中ではなく body 直下に置く（fixed オーバーレイ・header のレイアウトに影響しない）
  document.body.appendChild(searchBar)

  const expand = () => {
    searchBar.hidden = false
    searchBtn.setAttribute('aria-expanded', 'true')
    input.focus()
  }

  const collapse = () => {
    searchBar.hidden = true
    searchBtn.setAttribute('aria-expanded', 'false')
    // 閉じたら検索ボタン（トリガー）へフォーカス復帰（§17.1）
    searchBtn.focus()
  }

  searchBtn.addEventListener('click', () => {
    if (searchBar.hidden) expand()
    else collapse()
  })

  closeBtn.addEventListener('click', collapse)

  // Escape: 補完ドロップダウンが開いていれば（aria-expanded=true）まずそれを閉じる
  // （attachTagAutocomplete 側）。閉じている時のみオーバーレイ自体を畳む。
  // このリスナを補完より「先」に登録し、補完が aria-expanded を false にする前に判定する
  // （後だと同一 Escape で dropdown を閉じた直後に overlay まで畳んでしまう）。
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && input.getAttribute('aria-expanded') !== 'true') {
      collapse()
    }
  })

  // `#` タグ補完を付与（list 検索と共通）。確定＝一覧へ遷移しオーバーレイを畳む。
  attachTagAutocomplete(input, tags, {
    anchor: acWrap,
    onSelectTag: (name) => navigate(buildListUrl({ tags: [name] })),
    onSubmitText: (text) => {
      if (text) navigate(buildListUrl({ q: text }))
    },
  })

  return collapse
}
