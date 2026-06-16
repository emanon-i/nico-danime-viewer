import { buildListUrl } from '../router'

/** ヘッダ🔍の展開/折畳みを初期化する。戻り値は collapse 関数。 */
export function initHeaderSearch(
  searchBtn: HTMLElement,
  navigate: (url: string) => void
): () => void {
  const searchBar = document.createElement('div')
  searchBar.className = 'header-search-bar'
  searchBar.hidden = true

  const input = document.createElement('input')
  input.type = 'search'
  input.className = 'header-search-input'
  input.placeholder = '作品・タグで検索…'
  input.setAttribute('aria-label', '作品・タグで検索')

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'header-search-close'
  closeBtn.textContent = '×'
  closeBtn.setAttribute('aria-label', '検索を閉じる')

  searchBar.appendChild(input)
  searchBar.appendChild(closeBtn)
  searchBtn.parentElement?.appendChild(searchBar)

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

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      collapse()
    } else if (e.key === 'Enter') {
      const q = input.value.trim()
      if (q) navigate(buildListUrl({ q }))
    }
  })

  return collapse
}
