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
  opts: { initial: number; step: number; itemClass: string; moreLabel?: string }
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
  // もっと見る＝続きを step 件ずつ累積追加
  more.addEventListener('click', () => grow(Math.min(count, shown + opts.step)))
  // 閉じる＝initial を超えた分だけ畳む
  less.addEventListener('click', () => {
    const items = container.querySelectorAll('.' + opts.itemClass)
    for (let i = items.length - 1; i >= opts.initial; i--) items[i].remove()
    shown = opts.initial
    sync()
  })
  grow(Math.min(opts.initial, count))
}
