/**
 * 段階表示＋折りたたみトグル（§26/§34）。Top・一覧で共通利用。
 *
 * - `もっと見る ▾` を押すたび step 件ずつ「続きを順に」累積追加する（一気に全部出さない）。
 * - 末尾まで出たら `もっと見る` は消え、`閉じる ▴` で initial 件まで畳む。
 * - makeItem(i) は `itemClass` を持つ要素を返すこと（閉じる時の除去対象になる）。
 */
export function progressiveReveal(
  container: HTMLElement,
  count: number,
  makeItem: (i: number) => HTMLElement,
  opts: { initial: number; step: number; itemClass: string; moreLabel?: string; stateKey?: string }
): void {
  const more = document.createElement('button')
  more.type = 'button'
  more.className = 'reveal-more-btn'
  more.textContent = `${opts.moreLabel ?? 'もっと見る'} ▾`
  const less = document.createElement('button')
  less.type = 'button'
  less.className = 'reveal-less-btn'
  less.textContent = '閉じる ▴'
  container.appendChild(more)
  container.appendChild(less)

  // 展開件数の保持（§B）。stateKey 指定時は sessionStorage に「何件まで開いているか」を記録し、
  // 再描画/ページ移動（全リロード）をまたいで展開状態を復元する。
  const readStored = (): number | null => {
    if (!opts.stateKey) return null
    try {
      const v = sessionStorage.getItem(opts.stateKey)
      return v != null ? Number(v) : null
    } catch {
      return null
    }
  }
  const writeStored = (n: number): void => {
    if (!opts.stateKey) return
    try {
      sessionStorage.setItem(opts.stateKey, String(n))
    } catch {
      /* storage 不可環境は黙って無視（保持しないだけ） */
    }
  }

  let shown = 0
  const sync = () => {
    more.hidden = shown >= count
    less.hidden = shown <= opts.initial
  }
  const grow = (to: number) => {
    for (let i = shown; i < to; i++) container.insertBefore(makeItem(i), more)
    shown = to
    sync()
  }
  // もっと見る＝続きを step 件ずつ累積追加（展開件数を保持）
  more.addEventListener('click', () => {
    grow(Math.min(count, shown + opts.step))
    writeStored(shown)
  })
  // 閉じる＝initial を超えた分だけ畳む（保持も initial に戻す）
  less.addEventListener('click', () => {
    const items = container.querySelectorAll('.' + opts.itemClass)
    for (let i = items.length - 1; i >= opts.initial; i--) items[i].remove()
    shown = opts.initial
    sync()
    writeStored(shown)
  })
  // 初期表示＝保持された展開件数があれば復元（無ければ initial）。
  const restored = readStored()
  grow(
    restored != null
      ? Math.min(count, Math.max(opts.initial, restored))
      : Math.min(opts.initial, count)
  )
}
