import { icon } from './icon'
import { metaSpan, formatViews } from './meta'
import type { MetaSpec } from './meta'
import { seriesLink } from '../shared/deeplink'

// 再生数整形は meta.ts に一元化（DRY）。後方互換のため再エクスポート。
export { formatViews }

/** カードのメタ情報（任意）。TOP10 のランク帯や再生数/話数表示に使う。 */
export interface CardMeta {
  /** ランキング順位（1 始まり）。指定時のみランクバッジを出す */
  rank?: number
  /** 累計再生数。指定時のみ [play] メタを出す */
  views?: number
  /** 各話数。指定時のみ [film] メタを出す（人気TOP10 も話数を必ず出す＝§9.1） */
  episodeCount?: number
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

/** カード生成オプション */
export interface CardOpts {
  /**
   * true のときカード本体クリックを**外部（公式）**へ飛ばし、右上 ↗ を出さない（§11・Top 用）。
   * 既定 false ＝本体はうちの詳細 `?series=`・右上 ↗ で公式（一覧用）。
   */
  externalWhole?: boolean
}

/**
 * シリーズカード DOM を生成する。
 * - 主アクション: カード本体（`.card-body`）→ うちの作品詳細 `?series=<id>`
 *   （`externalWhole` 時は公式へ外部遷移＝§11・右上 ↗ は出さない）
 * - 副アクション: 右上 `.card-external` → 公式シリーズ（外部・別タブ）
 * - 左上 `.card-favorite` / `.card-watched`（localStorage 同期は main.ts の wireCards）
 *
 * サムネはカード全面（aspect-ratio 16:9＝--card-aspect・object-fit cover）。
 * 素サムネは 4:3(360×270) だが中身は 16:9 をレターボックスした焼き込みのため、
 * 16:9 cover で上下黒帯をトリミングする（§9.5）。タイトル/メタは下端 scrim に
 * オーバーレイし、文字の裏だけを暗くする（画像本体は暗くしない）。
 */
export function card(
  seriesId: number,
  title: string,
  thumbnailUrl: string | null,
  officialHref?: string,
  meta?: CardMeta,
  opts?: CardOpts
): HTMLElement {
  const externalHref = officialHref ?? seriesLink(seriesId) ?? ''
  const externalWhole = opts?.externalWhole === true && externalHref !== ''

  const el = document.createElement('div')
  el.className = 'series-card' + (externalWhole ? ' card-external-whole' : '')
  el.dataset.seriesId = String(seriesId)

  // ── 主: カード本体（サムネ＋オーバーレイ文字）──────────────
  const bodyLink = document.createElement('a')
  bodyLink.className = 'card-body'
  if (externalWhole) {
    bodyLink.href = externalHref
    bodyLink.target = '_blank'
    bodyLink.rel = 'noopener noreferrer'
  } else {
    bodyLink.href = `?series=${seriesId}`
  }

  const img = document.createElement('img')
  img.className = 'card-img'
  img.src = hiResThumb(thumbnailUrl)
  img.alt = ''
  img.loading = 'lazy'
  img.decoding = 'async'
  // 実サムネ 360×270。width/height でレイアウトシフトを防ぐ（表示は 16:9 cover）
  img.width = 360
  img.height = 270
  bodyLink.appendChild(img)

  // サムネ欠損時のフォールバック面（alt 文字でなく無地で見せる）
  if (!img.src) el.classList.add('no-thumb')
  // 404 / 読み込みエラーも .no-thumb に切替（§18 状態マトリクス）
  img.addEventListener('error', () => el.classList.add('no-thumb'))

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

  // メタ＝[play] 再生数 ＋ [film] 話数（§8.2 / §9.1）。アイコン＋最小単位語に圧縮。
  const metaSpecs: MetaSpec[] = []
  if (typeof meta?.views === 'number') {
    metaSpecs.push({
      icon: 'play',
      value: formatViews(meta.views),
      label: `再生数 ${formatViews(meta.views)}`,
    })
  }
  if (typeof meta?.episodeCount === 'number' && meta.episodeCount > 0) {
    metaSpecs.push({
      icon: 'film',
      value: `${meta.episodeCount}話`,
      label: `全${meta.episodeCount}話`,
    })
  }
  if (metaSpecs.length > 0) {
    const metaEl = document.createElement('div')
    metaEl.className = 'card-meta'
    metaSpecs.forEach((s) => metaEl.appendChild(metaSpan(s)))
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
  // 「見た」は eye アイコン（on/off が形・塗りで一目で分かる＝§20）。状態は wireCards が切替。
  watchedBtn.appendChild(icon('eye-off', 16))
  actions.appendChild(watchedBtn)

  el.appendChild(actions)

  // ── 右上: ↗ 公式シリーズ（外部）────────────────────────────
  // externalWhole（カード全体が外部）時は冗長なので出さない（§11）。
  if (!externalWhole && externalHref) {
    const extLink = document.createElement('a')
    extLink.className = 'icon-btn card-external'
    extLink.href = externalHref
    extLink.target = '_blank'
    extLink.rel = 'noopener noreferrer'
    extLink.setAttribute('aria-label', '公式シリーズページを開く')
    extLink.appendChild(icon('external-link', 16))
    el.appendChild(extLink)
  }

  return el
}
