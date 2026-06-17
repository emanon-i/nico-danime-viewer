/**
 * 横マーキー（§60）。`overflow-x` でネイティブに手動スクロール/スワイプできるビューポートを、
 * JS（requestAnimationFrame で scrollLeft を加算）でゆっくり自動送りする。
 *
 * - タッチ＝スワイプ（ネイティブ overflow）、PC＝縦ホイールを横スクロールに変換。
 * - hover / pointerdown / touch / スクロール操作中は自動送りを一時停止し、離すと再開。
 * - `prefers-reduced-motion: reduce` では自動送りせず手動スクロールのみ。
 * - track は同じ並びを 2 回敷いてある前提＝半分送ったら戻してシームレスにループ。
 * - CSP: 位置は scrollLeft（CSSOM 相当）で操作し inline style 属性を使わない。
 */
export function initMarquee(viewport: HTMLElement, track: HTMLElement): void {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const SPEED = 28 // px/sec
  let interacting = false
  let last = 0
  let raf = 0

  const half = () => track.scrollWidth / 2 // 1 セットぶんの幅

  const wrap = () => {
    const h = half()
    if (h <= 0) return
    if (viewport.scrollLeft >= h) viewport.scrollLeft -= h
    else if (viewport.scrollLeft < 0) viewport.scrollLeft += h
  }

  const step = (ts: number) => {
    if (!viewport.isConnected) {
      cancelAnimationFrame(raf) // 再レンダリングで切り離されたら停止（rAF の累積を防ぐ）
      return
    }
    if (last === 0) last = ts
    const dt = (ts - last) / 1000
    last = ts
    // reduced-motion は自動送りしない（手動スクロールのみ）。操作中も止める。
    if (!reduce && !interacting) {
      viewport.scrollLeft += SPEED * dt
      wrap()
    }
    raf = requestAnimationFrame(step)
  }

  const pause = () => {
    interacting = true
  }
  const resume = () => {
    interacting = false
  }

  // PC hover / ポインタ操作
  viewport.addEventListener('pointerenter', pause)
  viewport.addEventListener('pointerleave', resume)
  viewport.addEventListener('pointerdown', pause)
  window.addEventListener('pointerup', resume)
  // タッチスワイプ
  viewport.addEventListener('touchstart', pause, { passive: true })
  viewport.addEventListener('touchend', resume)

  // 縦ホイールを横スクロールに変換（PC で送れるように）
  viewport.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        viewport.scrollLeft += e.deltaY
        e.preventDefault()
      }
    },
    { passive: false }
  )

  // 手動スクロール後もシームレス（操作が落ち着いてから巻き戻し）
  let wrapTimer = 0
  viewport.addEventListener('scroll', () => {
    if (interacting) {
      window.clearTimeout(wrapTimer)
      wrapTimer = window.setTimeout(wrap, 120)
    }
  })

  raf = requestAnimationFrame(step)
}
