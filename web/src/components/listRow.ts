import { hiResThumb } from './card'
import { icon } from './icon'

export interface ListRowOpts {
  /** 行の種別。シリーズ型と各話型で見た目を変える（紛らわしさ防止） */
  kind: 'series' | 'episode'
  title: string
  /** 主アクション（本体）リンク。series=うちの詳細(?series=) / episode=公式 watch */
  href: string
  /** 本体リンクを外部遷移にする（episode=公式 watch など） */
  external?: boolean
  /** 左サムネ。null/未指定なら ▶ プレースホルダ */
  thumbnailUrl?: string | null
  /** タイトル先頭の小バッジ。series="シリーズ"(layers) / episode="第N話" */
  badge?: string
  /** 副次メタ行。series="全N話" / episode="N 再生 ・ M/D" */
  meta?: string
  /** 右上 ↗ で開く公式ページ（series=/series/<id> / episode=/watch/<id>）。別タブ */
  externalHref?: string
}

/**
 * サムネ左・タイトル/メタ右の行コンポーネント（list row）。
 * ポスターグリッド（`card()`）とは別物。「最近追加・更新」のシリーズ/各話に使う。
 * カードと同様、本体リンクと ↗ 外部リンクをネストさせないため root は div。
 */
export function listRow(opts: ListRowOpts): HTMLElement {
  const root = document.createElement('div')
  root.className = 'list-row'
  root.dataset.kind = opts.kind

  // ── 本体（サムネ＋テキスト）= 主アクション ─────────────────
  const body = document.createElement('a')
  body.className = 'list-row-body'
  body.href = opts.href
  if (opts.external) {
    body.target = '_blank'
    body.rel = 'noopener noreferrer'
  }

  const thumb = document.createElement('div')
  thumb.className = 'list-row-thumb'
  const src = hiResThumb(opts.thumbnailUrl ?? null)
  if (src) {
    const img = document.createElement('img')
    img.src = src
    img.alt = ''
    img.loading = 'lazy'
    img.decoding = 'async'
    img.width = 96
    img.height = 54
    thumb.appendChild(img)
  } else {
    // サムネ未取得は無地でなく統一プレースホルダ（▶ 動画）
    thumb.classList.add('list-row-thumb-empty')
    thumb.appendChild(icon('play', 20))
  }
  // 各話型は単一動画と分かるよう ▶ オーバーレイを重ねる
  if (opts.kind === 'episode' && src) {
    const play = document.createElement('span')
    play.className = 'list-row-play'
    play.appendChild(icon('play', 16))
    thumb.appendChild(play)
  }
  body.appendChild(thumb)

  const text = document.createElement('div')
  text.className = 'list-row-text'

  const titleEl = document.createElement('div')
  titleEl.className = 'list-row-title'
  if (opts.badge) {
    const badge = document.createElement('span')
    badge.className = 'list-row-badge'
    // シリーズ型バッジには layers アイコンを添えて種別を明示
    if (opts.kind === 'series') badge.appendChild(icon('layers', 12))
    const badgeText = document.createElement('span')
    badgeText.textContent = opts.badge
    badge.appendChild(badgeText)
    titleEl.appendChild(badge)
  }
  const titleText = document.createElement('span')
  titleText.className = 'list-row-title-text'
  titleText.textContent = opts.title
  titleEl.appendChild(titleText)
  text.appendChild(titleEl)

  if (opts.meta) {
    const metaEl = document.createElement('div')
    metaEl.className = 'list-row-meta'
    metaEl.textContent = opts.meta
    text.appendChild(metaEl)
  }

  body.appendChild(text)
  root.appendChild(body)

  // ── 右上 ↗ = 副アクション（公式ページ・外部）────────────────
  if (opts.externalHref) {
    const ext = document.createElement('a')
    ext.className = 'icon-btn list-row-external'
    ext.href = opts.externalHref
    ext.target = '_blank'
    ext.rel = 'noopener noreferrer'
    ext.setAttribute('aria-label', '公式ページを開く')
    ext.appendChild(icon('external-link', 16))
    root.appendChild(ext)
  }

  return root
}
