import type { SeriesDetail, SeriesEpisode } from '../../data/types'
import { watchLink, seriesLink } from '../../shared/deeplink'
import { buildDetailUrl } from '../router'
import { icon } from '../../components/icon'
import { hiResThumb } from '../../components/card'
import { metaSpan, formatViews, formatRelativeTime, formatDuration } from '../../components/meta'

/**
 * 各話行を生成する。
 * - 主クリック（行本体ボタン）→ 各話詳細をインライン展開（アコーディオン・§13 項目13）
 * - 副 ↗（external-link）→ 公式 watch（外部・別タブ・§12 で ▶ から ↗ へ変更）
 */
function buildEpisodeRow(ep: SeriesEpisode): HTMLElement {
  const row = document.createElement('div')
  row.className = 'episode-row'
  row.dataset.part = 'episode'
  row.dataset.episodeNo = ep.episodeNo != null ? String(ep.episodeNo) : ''

  const head = document.createElement('div')
  head.className = 'episode-head'

  // 主アクション＝行本体（クリックで詳細を開閉）
  const main = document.createElement('button')
  main.type = 'button'
  main.className = 'episode-main'
  main.setAttribute('aria-expanded', 'false')

  const noSpan = document.createElement('span')
  noSpan.className = 'ep-no'
  noSpan.textContent = ep.episodeNo != null ? `#${ep.episodeNo}` : ''
  main.appendChild(noSpan)

  const titleSpan = document.createElement('span')
  titleSpan.className = 'ep-title'
  titleSpan.textContent = ep.title ?? ''
  main.appendChild(titleSpan)

  // 再生数は行ヘッダに常時出さず、ドロワー（下記）に集約する（§17・冗長排除）

  const chevron = document.createElement('span')
  chevron.className = 'ep-toggle'
  chevron.appendChild(icon('chevron-right', 16))
  main.appendChild(chevron)
  head.appendChild(main)

  // 副 ↗＝公式 watch（外部）
  const href = watchLink(ep.contentId)
  if (href) {
    const watchAnchor = document.createElement('a')
    watchAnchor.className = 'watch-link'
    watchAnchor.dataset.action = 'watch'
    watchAnchor.href = href
    watchAnchor.target = '_blank'
    watchAnchor.rel = 'noopener noreferrer'
    watchAnchor.appendChild(icon('external-link', 14))
    watchAnchor.appendChild(document.createTextNode('公式'))
    head.appendChild(watchAnchor)
  }
  row.appendChild(head)

  // アコーディオン詳細（サムネ＋メタ）
  const detail = document.createElement('div')
  detail.className = 'episode-detail'
  detail.hidden = true

  const thumbSrc = hiResThumb(ep.thumbnailUrl ?? null)
  if (thumbSrc) {
    const thumb = document.createElement('div')
    thumb.className = 'episode-detail-thumb'
    const img = document.createElement('img')
    img.src = thumbSrc
    img.alt = ''
    img.loading = 'lazy'
    img.decoding = 'async'
    thumb.appendChild(img)
    detail.appendChild(thumb)
  }

  const dmeta = document.createElement('div')
  dmeta.className = 'episode-detail-meta'
  // [play]再生数 ＋ [message]コメント ＋ [bookmark]マイリス ＋ [clock]投稿 ＋ [film]尺（§18）
  dmeta.appendChild(
    metaSpan({
      icon: 'play',
      value: formatViews(ep.viewCounter),
      label: `再生数 ${formatViews(ep.viewCounter)}`,
    })
  )
  if (typeof ep.commentCounter === 'number') {
    dmeta.appendChild(
      metaSpan({
        icon: 'message',
        value: formatViews(ep.commentCounter),
        label: `コメント ${formatViews(ep.commentCounter)}`,
      })
    )
  }
  if (typeof ep.mylistCounter === 'number') {
    dmeta.appendChild(
      metaSpan({
        icon: 'bookmark',
        value: formatViews(ep.mylistCounter),
        label: `マイリスト ${formatViews(ep.mylistCounter)}`,
      })
    )
  }
  if (ep.startTime) {
    const rel = formatRelativeTime(ep.startTime)
    if (rel) {
      dmeta.appendChild(metaSpan({ icon: 'clock', value: rel, label: `投稿 ${rel}` }))
    }
  }
  if (typeof ep.lengthSeconds === 'number' && ep.lengthSeconds > 0) {
    const dur = formatDuration(ep.lengthSeconds)
    dmeta.appendChild(metaSpan({ icon: 'film', value: dur, label: `再生時間 ${dur}` }))
  }
  detail.appendChild(dmeta)
  // 各話あらすじ（あれば・§51）。メタの下に読みやすく。
  const desc = ep.description?.trim()
  if (desc) {
    const p = document.createElement('p')
    p.className = 'episode-detail-desc'
    p.textContent = desc
    detail.appendChild(p)
  }
  row.appendChild(detail)

  main.addEventListener('click', () => {
    const open = detail.hidden
    detail.hidden = !open
    main.setAttribute('aria-expanded', open ? 'true' : 'false')
    row.classList.toggle('open', open)
  })

  return row
}

/** シリーズ詳細画面を描画する。series が null または episodes 空なら empty 表示 */
export function renderDetail(container: HTMLElement, series: SeriesDetail | null): void {
  container.innerHTML = ''

  if (!series) {
    const empty = document.createElement('div')
    empty.className = 'detail-unavailable'
    empty.dataset.part = 'empty'
    empty.textContent = '⚠ この作品の配信情報は取得できませんでした（配信終了の可能性）'
    container.appendChild(empty)
    return
  }

  const hasEpisodes = series.episodes.length > 0
  const hasRelated = series.relatedSeries.length > 0
  const officialHref = seriesLink(series.seriesId)

  // ── メタ（バナー＋タイトル＋タグ＋ⓘ）────────────────────────
  const metaSection = document.createElement('div')
  metaSection.className = 'detail-meta'
  metaSection.dataset.section = 'meta'

  const bannerDiv = document.createElement('div')
  bannerDiv.className = 'detail-banner'
  if (series.thumbnailUrl) {
    const img = document.createElement('img')
    img.src = series.thumbnailUrl
    img.alt = series.title
    bannerDiv.appendChild(img)
  } else {
    const placeholder = document.createElement('div')
    placeholder.className = 'no-thumbnail'
    bannerDiv.appendChild(placeholder)
  }
  metaSection.appendChild(bannerDiv)

  const infoDiv = document.createElement('div')
  infoDiv.className = 'detail-info'

  const h1 = document.createElement('h1')
  h1.appendChild(document.createTextNode(series.title))
  const infoBtn = document.createElement('button')
  infoBtn.className = 'info-btn'
  infoBtn.setAttribute('aria-label', '主要メタの要点について')
  infoBtn.dataset.tooltip =
    '概要は第1話のあらすじを表示しています。タグ・再生数・各話・クールはニコニコの公開情報より'
  infoBtn.appendChild(icon('info', 14))
  h1.appendChild(infoBtn)
  infoDiv.appendChild(h1)

  const tagsDiv = document.createElement('div')
  tagsDiv.className = 'detail-tags'
  series.tags.forEach((tag) => {
    const chip = document.createElement('a')
    chip.className = 'tag-chip'
    chip.href = '?tag=' + encodeURIComponent(tag)
    chip.textContent = tag
    tagsDiv.appendChild(chip)
  })
  infoDiv.appendChild(tagsDiv)

  // シリーズメタ＝[film]話数 ＋ [message]総コメント ＋ [bookmark]総マイリス（§18）。
  // 総再生数は出さない（各話ドロワーで見られるため冗長＝§17）。
  if (series.episodes.length > 0) {
    const sumComment = series.episodes.reduce((a, e) => a + (e.commentCounter ?? 0), 0)
    const sumMylist = series.episodes.reduce((a, e) => a + (e.mylistCounter ?? 0), 0)
    const metaRow = document.createElement('div')
    metaRow.className = 'detail-series-meta'
    metaRow.appendChild(
      metaSpan({
        icon: 'film',
        value: `${series.episodes.length}話`,
        label: `全${series.episodes.length}話`,
      })
    )
    if (sumComment > 0)
      metaRow.appendChild(
        metaSpan({
          icon: 'message',
          value: formatViews(sumComment),
          label: `総コメント ${formatViews(sumComment)}`,
        })
      )
    if (sumMylist > 0)
      metaRow.appendChild(
        metaSpan({
          icon: 'bookmark',
          value: formatViews(sumMylist),
          label: `総マイリスト ${formatViews(sumMylist)}`,
        })
      )
    infoDiv.appendChild(metaRow)
  }

  if (officialHref) {
    const offLink = document.createElement('a')
    offLink.className = 'btn-primary official-series-link'
    offLink.dataset.action = 'official-series'
    offLink.href = officialHref
    offLink.target = '_blank'
    offLink.rel = 'noopener noreferrer'
    offLink.appendChild(icon('play', 16))
    offLink.appendChild(document.createTextNode('公式シリーズページ'))
    infoDiv.appendChild(offLink)
  }

  const marksDiv = document.createElement('div')
  marksDiv.className = 'detail-marks'
  const favBtn = document.createElement('button')
  favBtn.className = 'btn-favorite'
  favBtn.setAttribute('aria-label', 'お気に入り')
  favBtn.appendChild(icon('heart', 16))
  favBtn.appendChild(document.createTextNode('お気に入り'))
  marksDiv.appendChild(favBtn)
  const watchedBtn = document.createElement('button')
  watchedBtn.className = 'btn-watched'
  watchedBtn.setAttribute('aria-label', '見た')
  // アイコン（circle-check）と active 状態は main.ts wireDetailMarks が設定する（§45）
  watchedBtn.appendChild(icon('circle-check', 16))
  watchedBtn.appendChild(document.createTextNode('見た'))
  marksDiv.appendChild(watchedBtn)
  infoDiv.appendChild(marksDiv)

  if (series.descriptionFirst) {
    const detailsEl = document.createElement('details')
    detailsEl.className = 'detail-overview'
    const summary = document.createElement('summary')
    summary.textContent = '第1話のあらすじ'
    detailsEl.appendChild(summary)
    const p = document.createElement('p')
    p.textContent = series.descriptionFirst
    detailsEl.appendChild(p)
    infoDiv.appendChild(detailsEl)
  }

  metaSection.appendChild(infoDiv)
  container.appendChild(metaSection)

  // ── 各話一覧 ────────────────────────────────────────────────
  const episodesSection = document.createElement('section')
  episodesSection.className = 'detail-episodes'
  episodesSection.dataset.section = 'episodes'

  if (!hasEpisodes) {
    const emptyDiv = document.createElement('div')
    emptyDiv.dataset.part = 'empty'
    emptyDiv.textContent = '⚠ 各話一覧: 取得できませんでした'
    episodesSection.appendChild(emptyDiv)
  } else {
    const heading = document.createElement('h2')
    heading.textContent = `各話 (${series.episodes.length}話)`
    episodesSection.appendChild(heading)

    series.episodes.forEach((ep) => {
      episodesSection.appendChild(buildEpisodeRow(ep))
    })
  }
  container.appendChild(episodesSection)

  // ── 関連シリーズ ────────────────────────────────────────────
  const relatedSection = document.createElement('section')
  relatedSection.className = 'detail-related'
  relatedSection.dataset.section = 'related'

  if (!hasRelated) {
    relatedSection.setAttribute('hidden', '')
  } else {
    const heading = document.createElement('h2')
    heading.textContent = '▸ 関連シリーズ/続編'
    relatedSection.appendChild(heading)

    const list = document.createElement('div')
    list.className = 'related-list'
    series.relatedSeries.forEach((r) => {
      const link = document.createElement('a')
      link.className = 'related-series-link'
      link.dataset.action = 'related-series'
      link.href = buildDetailUrl(r.seriesId)
      link.textContent = r.title
      list.appendChild(link)
    })
    relatedSection.appendChild(list)
  }
  container.appendChild(relatedSection)
}
