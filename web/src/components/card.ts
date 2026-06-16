import { icon } from './icon'
import { seriesLink } from '../shared/deeplink'

/** カードのメタ情報（任意）。TOP10 のランク帯や再生数表示に使う。 */
export interface CardMeta {
  /** ランキング順位（1 始まり）。指定時のみランクバッジを出す */
  rank?: number
  /** 累計再生数。指定時のみメタ行に「N 再生」を出す */
  views?: number
}

/**
 * ニコニコ CDN の素サムネ URL を大サイズ（.L = 360×270）に昇格する。
 * 素 URL（`/thumbnails/<id>/<id>.<rev>`）は 130×100 と小さく粗いため、
 * カード全面表示には `.L` を使う。既にサフィックス付き/別ホストはそのまま。
 */
export function hiResThumb(url: string | null): string {
  if (!url) return ''
  return /\/thumbnails\/\d+\/\d+\.\d+$/.test(url) ? `${url}.L` : url
}

/** 再生数を日本語の概数（308万 / 9,876）に整形する。 */
function formatViews(n: number): string {
  if (n >= 10000) {
    const man = n / 10000
    return `${man >= 100 ? Math.round(man) : man.toFixed(1)}万`
  }
  return n.toLocaleString('ja-JP')
}

/**
 * シリーズカード DOM を生成する。
 * - 主アクション: カード本体（`.card-body`）→ うちの作品詳細 `?series=<id>`
 * - 副アクション: 右上 `.card-external` → 公式シリーズ（外部・別タブ）
 * - 左上 `.card-favorite` / `.card-watched`（localStorage 同期は main.ts の wireCards）
 *
 * サムネはカード全面（aspect-ratio 4/3・object-fit cover）。タイトル/メタは
 * 下端 scrim にオーバーレイし、文字の裏だけを暗くする（画像本体は暗くしない）。
 */
export function card(
  seriesId: number,
  title: string,
  thumbnailUrl: string | null,
  officialHref?: string,
  meta?: CardMeta
): HTMLElement {
  const el = document.createElement('div')
  el.className = 'series-card'
  el.dataset.seriesId = String(seriesId)

  // ── 主: カード本体（サムネ＋オーバーレイ文字）──────────────
  const bodyLink = document.createElement('a')
  bodyLink.className = 'card-body'
  bodyLink.href = `?series=${seriesId}`

  const img = document.createElement('img')
  img.className = 'card-img'
  img.src = hiResThumb(thumbnailUrl)
  img.alt = ''
  img.loading = 'lazy'
  img.decoding = 'async'
  // 4:3（実サムネ 360×270）。width/height でレイアウトシフトを防ぐ
  img.width = 360
  img.height = 270
  bodyLink.appendChild(img)

  // サムネ欠損時のフォールバック面（alt 文字でなく無地で見せる）
  if (!img.src) el.classList.add('no-thumb')

  const overlay = document.createElement('div')
  overlay.className = 'card-overlay'

  if (meta?.rank) {
    const rankEl = document.createElement('span')
    rankEl.className = 'card-rank'
    rankEl.textContent = String(meta.rank)
    overlay.appendChild(rankEl)
  }

  const textWrap = document.createElement('div')
  textWrap.className = 'card-text'

  const titleEl = document.createElement('div')
  titleEl.className = 'card-title'
  titleEl.textContent = title
  textWrap.appendChild(titleEl)

  if (typeof meta?.views === 'number') {
    const metaEl = document.createElement('div')
    metaEl.className = 'card-meta'
    metaEl.textContent = `${formatViews(meta.views)} 再生`
    textWrap.appendChild(metaEl)
  }

  overlay.appendChild(textWrap)
  bodyLink.appendChild(overlay)
  el.appendChild(bodyLink)

  // ── 左上: ♥ お気に入り / ✓ 見た（トグル）─────────────────
  const actions = document.createElement('div')
  actions.className = 'card-actions'

  const favBtn = document.createElement('button')
  favBtn.className = 'icon-btn card-favorite'
  favBtn.setAttribute('aria-label', 'お気に入り')
  favBtn.appendChild(icon('heart', 16))
  actions.appendChild(favBtn)

  const watchedBtn = document.createElement('button')
  watchedBtn.className = 'icon-btn card-watched'
  watchedBtn.setAttribute('aria-label', '見た')
  watchedBtn.appendChild(icon('check', 16))
  actions.appendChild(watchedBtn)

  el.appendChild(actions)

  // ── 右上: ↗ 公式シリーズ（外部）────────────────────────────
  const href = officialHref ?? seriesLink(seriesId) ?? ''
  if (href) {
    const extLink = document.createElement('a')
    extLink.className = 'icon-btn card-external'
    extLink.href = href
    extLink.target = '_blank'
    extLink.rel = 'noopener noreferrer'
    extLink.setAttribute('aria-label', '公式シリーズページを開く')
    extLink.appendChild(icon('external-link', 16))
    el.appendChild(extLink)
  }

  return el
}
