/**
 * カスタムツールチップ（§46）。ネイティブ `title` を置換し、デザイントークンに沿った
 * 見た目＋スマホ対応（タップ開閉）を提供する。
 *
 * - トリガー＝`[data-tooltip]` を持つ要素（ボタン/リンク等・フォーカス可能が望ましい）。
 * - デスクトップ: hover（マウス）＋ focus（キーボード）で表示。
 * - タッチ: タップでトグル。外側タップ / Esc で閉じる。
 * - 位置: 既定は対象の上、画面外に出るなら下へフリップ。左右は画面内にクランプ。
 * - a11y: 単一の role=tooltip 要素を使い、表示中だけ aria-describedby で結びつける。
 * - CSP: 位置指定は CSSOM（el.style.setProperty）で行い inline 属性を使わない。
 */
let tip: HTMLElement | null = null
let activeTrigger: HTMLElement | null = null
let lastPointerType = ''

function ensureTip(): HTMLElement {
  if (tip) return tip
  const el = document.createElement('div')
  el.className = 'tooltip'
  el.id = 'app-tooltip'
  el.setAttribute('role', 'tooltip')
  el.hidden = true
  document.body.appendChild(el)
  tip = el
  return el
}

function place(el: HTMLElement, trigger: HTMLElement): void {
  const margin = 8
  const tr = trigger.getBoundingClientRect()
  const er = el.getBoundingClientRect()
  let left = tr.left + tr.width / 2 - er.width / 2
  let top = tr.top - er.height - margin
  let placement = 'top'
  if (top < margin) {
    top = tr.bottom + margin // 上に入らなければ下へフリップ
    placement = 'bottom'
  }
  left = Math.max(margin, Math.min(left, window.innerWidth - er.width - margin))
  el.dataset.placement = placement
  // position: fixed（ビューポート座標）。CSSOM で設定＝CSP の style-src に抵触しない。
  el.style.setProperty('left', `${Math.round(left)}px`)
  el.style.setProperty('top', `${Math.round(top)}px`)
}

function show(trigger: HTMLElement): void {
  const text = trigger.dataset.tooltip
  if (!text) return
  const el = ensureTip()
  el.textContent = text
  el.hidden = false
  trigger.setAttribute('aria-describedby', el.id)
  activeTrigger = trigger
  place(el, trigger)
}

function hide(): void {
  if (tip) tip.hidden = true
  if (activeTrigger) activeTrigger.removeAttribute('aria-describedby')
  activeTrigger = null
}

function triggerOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? (target.closest('[data-tooltip]') as HTMLElement | null) : null
}

/** ツールチップのグローバル配線を 1 回だけ初期化する。 */
export function initTooltips(): void {
  if ((initTooltips as { done?: boolean }).done) return
  ;(initTooltips as { done?: boolean }).done = true

  document.addEventListener(
    'pointerdown',
    (e) => {
      lastPointerType = (e as PointerEvent).pointerType
    },
    true
  )

  // マウス hover（タッチは click 側で扱う）
  document.addEventListener('pointerover', (e) => {
    if ((e as PointerEvent).pointerType === 'touch') return
    const t = triggerOf(e.target)
    if (t) show(t)
  })
  document.addEventListener('pointerout', (e) => {
    if ((e as PointerEvent).pointerType === 'touch') return
    const t = triggerOf(e.target)
    if (t && t === activeTrigger) hide()
  })

  // キーボードフォーカス
  document.addEventListener('focusin', (e) => {
    const t = triggerOf(e.target)
    if (t) show(t)
    else if (activeTrigger) hide()
  })
  document.addEventListener('focusout', (e) => {
    const t = triggerOf(e.target)
    if (t && t === activeTrigger) hide()
  })

  // タッチ/クリック: タッチ端末はタップでトグル、外側で閉じる
  document.addEventListener('click', (e) => {
    const t = triggerOf(e.target)
    if (t) {
      if (lastPointerType === 'touch') {
        if (activeTrigger === t) hide()
        else show(t)
        e.preventDefault()
      }
      return
    }
    hide() // 外側クリック/タップで閉じる
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide()
  })
  window.addEventListener('scroll', hide, true)
  window.addEventListener('resize', hide)
}

/**
 * 省略されたピル（scrollWidth > clientWidth）に全文ツールチップを付ける（§49）。
 * 対象はタグ/クールのチップ・検索トークンのピルラベル。短く収まっているものは付けない。
 */
export function wireTruncationTooltips(root: ParentNode): void {
  const sel = '.tag-pill-label, .filter-tag-item, .filter-cours-item, .tag-chip, .quick-tag'
  for (const el of root.querySelectorAll<HTMLElement>(sel)) {
    const full = el.textContent?.trim() ?? ''
    if (full && el.scrollWidth > el.clientWidth + 1) {
      el.dataset.tooltip = full
      // 省略時はキーボードでも全文に到達できるよう、非フォーカス要素なら tabindex を付与
      if (!el.matches('a, button, input, select, textarea') && !el.hasAttribute('tabindex')) {
        el.tabIndex = 0
      }
    } else {
      delete el.dataset.tooltip
    }
  }
}
