import type { Tag } from '../../data/types'

/**
 * `#` 始まりの入力に対するタグ・オートコンプリートを `<input>` に付与する（§35 共通化）。
 *
 * 一覧検索（list.ts）の補完ロジックをここに集約し、ヘッダ検索・Top ヒーロー検索でも
 * 同じ作法（候補ドロップダウン・↑↓/Enter/Esc・出現頻度降順・前方/部分一致）で再利用する。
 *
 * - 入力が `#` 始まりでタグモード（候補ドロップダウン）。プレーンテキストは `onSubmitText`。
 * - キーボード: ↑↓ で候補移動 / Enter で確定 / Esc で閉じる / 空 Backspace は `onBackspaceEmpty`。
 * - role=combobox + listbox（aria-expanded / aria-activedescendant）を input/listbox に付与。
 * - 候補はクライアントのタグ一覧（seriesCount 降順）から `excluded` を除いて最大 10 件。
 */
let acSeq = 0

export interface TagAutocompleteOptions {
  /** タグ確定時（候補選択 or `#完全一致` の Enter）に呼ぶ。 */
  onSelectTag: (name: string) => void
  /** プレーンテキストの Enter 確定（空文字含む）。省略時はテキスト確定を行わない。 */
  onSubmitText?: (text: string) => void
  /** 候補から除外する（既に選択済みの）タグ名集合を返す。 */
  excluded?: () => Set<string>
  /** 入力が空での Backspace。処理した場合 true を返すと preventDefault する。 */
  onBackspaceEmpty?: () => boolean
  /** 候補ドロップダウンを差し込む親（position:relative 必須）。既定は input.parentElement。 */
  anchor?: HTMLElement | null
}

export interface TagAutocompleteHandle {
  /** 候補ドロップダウンを閉じる。 */
  close: () => void
}

export function attachTagAutocomplete(
  input: HTMLInputElement,
  tags: Tag[],
  opts: TagAutocompleteOptions
): TagAutocompleteHandle {
  const anchor = opts.anchor ?? input.parentElement
  const listboxId = `tag-ac-listbox-${acSeq++}`
  const optId = (i: number) => `${listboxId}-opt-${i}`

  const listbox = document.createElement('ul')
  listbox.className = 'tag-ac-listbox'
  listbox.id = listboxId
  listbox.setAttribute('role', 'listbox')
  listbox.hidden = true
  anchor?.appendChild(listbox)

  input.autocomplete = 'off'
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-expanded', 'false')
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-controls', listboxId)

  let options: Tag[] = []
  let active = -1

  const close = () => {
    listbox.hidden = true
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
    active = -1
  }

  const setActive = (i: number) => {
    const items = listbox.querySelectorAll<HTMLElement>('.tag-ac-option')
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
    const selected = opts.excluded?.() ?? new Set<string>()
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
      li.className = 'tag-ac-option'
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
        opts.onSelectTag(t.name)
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
      if (!listbox.hidden && active >= 0 && options[active]) {
        e.preventDefault()
        opts.onSelectTag(options[active].name)
        return
      }
      const v = input.value.trim()
      if (v.startsWith('#')) {
        e.preventDefault()
        const term = v.slice(1).trim()
        if (!term) return
        const selected = opts.excluded?.() ?? new Set<string>()
        const exact = tags.find((t) => t.name === term && !selected.has(t.name))
        if (exact) opts.onSelectTag(exact.name)
        else if (options[0]) opts.onSelectTag(options[0].name)
      } else if (opts.onSubmitText) {
        e.preventDefault()
        opts.onSubmitText(v)
      }
    } else if (e.key === 'Escape' && !listbox.hidden) {
      e.preventDefault()
      close()
    } else if (e.key === 'Backspace' && input.value === '' && opts.onBackspaceEmpty) {
      if (opts.onBackspaceEmpty()) e.preventDefault()
    }
  })

  // option の mousedown は preventDefault でフォーカス維持するため、ここは外側クリック時のみ
  input.addEventListener('blur', () => {
    window.setTimeout(close, 0)
  })

  return { close }
}
