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
/**
 * 自動送り中のマーキーでも「タップで確実にチップへ遷移」させる（§94）。指がほぼ動かない
 * タップは、横スクロール可能コンテナのスクロールジェスチャ判定に吸われて click が発火しない
 * ことがある（特に内容が動いている時）。そこで touchend を見て、移動が小さければタップと
 * みなし、対象アンカーへ明示遷移する（ゴーストクリックは preventDefault で抑止＝二重遷移防止）。
 * スワイプ（移動大）は素通し＝手動スクロールと両立。アンカー以外（シャッフルボタン等）は不介入。
 */
function wireTapNavigation(viewport: HTMLElement): void {
  let sx = 0
  let sy = 0
  let moved = false
  viewport.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0]
      if (!t) return
      sx = t.clientX
      sy = t.clientY
      moved = false
    },
    { passive: true }
  )
  viewport.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0]
      if (!t) return
      if (Math.abs(t.clientX - sx) > 8 || Math.abs(t.clientY - sy) > 8) moved = true
    },
    { passive: true }
  )
  viewport.addEventListener(
    'touchend',
    (e) => {
      if (moved) return // スワイプ＝スクロール意図 → 遷移しない
      const target = e.target instanceof Element ? e.target : null
      const a = target?.closest('a[href]') as HTMLAnchorElement | null
      if (!a) return // アンカー以外（ボタン等）は素のタップに任せる
      e.preventDefault() // 後続のゴーストクリックを抑止（二重遷移防止）
      location.href = a.href
    },
    { passive: false }
  )
}

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

  wireTapNavigation(viewport) // 自動送り中でもタップで確実に遷移（§94）
  raf = requestAnimationFrame(step)
}

/**
 * 自動横スクロール（§70・ピンポン型）。track の複製を前提とせず、overflow-x スクロール
 * コンテナの scrollLeft を rAF で進め、端で向きを反転（行ったり来たり）する。手動スクロール/
 * スワイプと両立し、hover / pointer / touch / フォーカス / 操作中は一時停止して離すと再開、
 * `prefers-reduced-motion: reduce` では自動送りなし（手動のみ）。スクロール範囲が無ければ無動作。
 */
export function initAutoScroll(viewport: HTMLElement): void {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const SPEED = 26 // px/sec
  let interacting = false
  let dir = 1
  let last = 0
  let raf = 0

  const maxScroll = () => viewport.scrollWidth - viewport.clientWidth

  const step = (ts: number) => {
    if (!viewport.isConnected) {
      cancelAnimationFrame(raf)
      return
    }
    if (last === 0) last = ts
    const dt = (ts - last) / 1000
    last = ts
    const max = maxScroll()
    if (!reduce && !interacting && max > 1) {
      viewport.scrollLeft += SPEED * dt * dir
      if (viewport.scrollLeft >= max) {
        viewport.scrollLeft = max
        dir = -1 // 端で反転（ピンポン）
      } else if (viewport.scrollLeft <= 0) {
        viewport.scrollLeft = 0
        dir = 1
      }
    }
    raf = requestAnimationFrame(step)
  }

  const pause = () => {
    interacting = true
  }
  const resume = () => {
    interacting = false
  }
  viewport.addEventListener('pointerenter', pause)
  viewport.addEventListener('pointerleave', resume)
  viewport.addEventListener('pointerdown', pause)
  window.addEventListener('pointerup', resume)
  viewport.addEventListener('touchstart', pause, { passive: true })
  viewport.addEventListener('touchend', resume)
  viewport.addEventListener('focusin', pause)
  viewport.addEventListener('focusout', resume)
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

  wireTapNavigation(viewport) // 自動送り中でもタップで確実に遷移（§94）
  raf = requestAnimationFrame(step)
}
