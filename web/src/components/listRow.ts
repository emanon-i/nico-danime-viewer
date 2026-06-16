import { hiResThumb } from './card'

export interface ListRowOpts {
  title: string
  href: string
  /** 左サムネ。null/未指定なら無地プレースホルダ */
  thumbnailUrl?: string | null
  /** 右側の補助テキスト（「新着シリーズ」「最新の動画」等） */
  meta?: string
  /** 外部リンク（公式 watch 等）なら別タブ＋ noopener */
  external?: boolean
}

/**
 * サムネ左・タイトル/メタ右の行コンポーネント（list row）。
 * ポスターグリッド（`card()`）とは別物で、「最近追加・更新」等のリスト表示に使う。
 */
export function listRow(opts: ListRowOpts): HTMLElement {
  const a = document.createElement('a')
  a.className = 'list-row'
  a.href = opts.href
  if (opts.external) {
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
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
    img.height = 72
    thumb.appendChild(img)
  } else {
    thumb.classList.add('list-row-thumb-empty')
  }
  a.appendChild(thumb)

  const text = document.createElement('div')
  text.className = 'list-row-text'

  const titleEl = document.createElement('div')
  titleEl.className = 'list-row-title'
  titleEl.textContent = opts.title
  text.appendChild(titleEl)

  if (opts.meta) {
    const metaEl = document.createElement('div')
    metaEl.className = 'list-row-meta'
    metaEl.textContent = opts.meta
    text.appendChild(metaEl)
  }

  a.appendChild(text)
  return a
}
