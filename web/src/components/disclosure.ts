import { icon } from './icon'

let disclosureSeq = 0

/**
 * 自前ディスクロージャ（§62 堅牢化）。`<details>` の UA 挙動（新しい Chrome は
 * `::details-content`＋`content-visibility` で本文を隠すため、子への `display:block`
 * 上書きが効かない）に依存せず、**クラストグル＋JS で開閉を明示制御**する。
 *
 * - 開閉は `.disclosure.open` クラスのみで決まる（CSS の詳細度勝負をしない）。
 * - 既定状態は `matchMedia(openQuery)` で分岐（デスクトップ＝開 / モバイル＝閉）。
 *   `change` イベントでリサイズにも追従（再レンダリングで切り離されたら何もしない）。
 * - 本文要素（body）は常に DOM に存在（閉時は CSS で非表示にするだけ＝空にしない）。
 * - a11y: トグルは `<button aria-expanded aria-controls>`、本文に id を付与。
 *
 * @param label トグルの見出し（例「あらすじ」）
 * @param body 本文要素（テキストは呼び出し側で設定済み）
 * @param openQuery 既定で開く画面幅の media query（既定 `(min-width: 768px)`）
 */
export function buildDisclosure(
  label: string,
  body: HTMLElement,
  openQuery = '(min-width: 768px)'
): HTMLElement {
  const root = document.createElement('div')
  root.className = 'disclosure'

  const id = `disclosure-body-${++disclosureSeq}`
  body.id = id
  body.classList.add('disclosure-body')

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'disclosure-toggle'
  btn.setAttribute('aria-controls', id)
  const labelEl = document.createElement('span')
  labelEl.className = 'disclosure-label'
  labelEl.textContent = label
  btn.appendChild(labelEl)
  btn.appendChild(icon('chevron-right', 16))

  const setOpen = (open: boolean) => {
    root.classList.toggle('open', open)
    btn.setAttribute('aria-expanded', open ? 'true' : 'false')
  }

  // 既定: デスクトップ幅=開 / モバイル幅=閉（UA に依存しない）
  const mq = window.matchMedia(openQuery)
  setOpen(mq.matches)
  mq.addEventListener('change', (e) => {
    if (!root.isConnected) return // 再レンダリングで切り離されたら追従しない（リーク防止）
    setOpen(e.matches)
  })

  btn.addEventListener('click', () => setOpen(!root.classList.contains('open')))

  root.appendChild(btn)
  root.appendChild(body)
  return root
}
