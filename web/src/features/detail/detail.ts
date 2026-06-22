import type { SeriesDetail, SeriesEpisode } from '../../data/types'
import { watchLink, seriesLink } from '../../shared/deeplink'
import { buildDetailUrl } from '../router'
import { icon } from '../../components/icon'
import { hiResThumb } from '../../components/card'
import { detailMeta, formatNumberFull, formatDateTime, formatDuration } from '../../components/meta'
import { buildDisclosure } from '../../components/disclosure'
import { isHiddenTag } from '../../shared/tag-filter'

/**
 * タグチップ（`.tag-chip`）を生成。クリックで `?tag=` のタグフィルタへ遷移（§82）。
 * 30ch を超えるラベルは CSS で … 省略され、全文ツールチップを直付けする（§77：
 * ドロワー内チップは初期 hidden で wireTruncationTooltips が計測できないため、
 * 文字数で判定して data-tooltip を確定的に付与する）。
 */
function tagChip(tag: string): HTMLAnchorElement {
  const chip = document.createElement('a')
  chip.className = 'tag-chip'
  chip.href = '?tag=' + encodeURIComponent(tag)
  chip.textContent = tag
  if ([...tag].length > 30) chip.dataset.tooltip = tag
  return chip
}

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
  // 詳細はスペースに余裕があるので圧縮しない（§F）＝文字ラベル＋実値（カンマ区切り）＋正確日時。
  dmeta.appendChild(detailMeta('再生数', formatNumberFull(ep.viewCounter)))
  if (typeof ep.commentCounter === 'number') {
    dmeta.appendChild(detailMeta('コメント数', formatNumberFull(ep.commentCounter)))
  }
  if (typeof ep.mylistCounter === 'number') {
    dmeta.appendChild(detailMeta('マイリス数', formatNumberFull(ep.mylistCounter)))
  }
  if (ep.startTime) {
    const dt = formatDateTime(ep.startTime)
    if (dt) dmeta.appendChild(detailMeta('投稿', dt))
  }
  if (typeof ep.lengthSeconds === 'number' && ep.lengthSeconds > 0) {
    dmeta.appendChild(detailMeta('再生時間', formatDuration(ep.lengthSeconds)))
  }
  // 右カラム＝「メタ（上）→ 説明（下）」を縦スタック（§61・flex-wrap 依存をやめ決定論的に）。
  // サムネは左、この main がその右で縦並び＝desc は必ず meta の下に来る。
  const rightCol = document.createElement('div')
  rightCol.className = 'episode-detail-main'
  rightCol.appendChild(dmeta)
  // 各話タグ（§77）。メタと説明の間。クール由来タグ（「2026年春アニメ」等・§68）は
  // 各話でも除外。除外後 0 件なら行ごと出さない。チップ作法はタグUI全体に統一（1行ピル20ch・
  // 超過は … 省略＋ツールチップ・クリックで ?tag= へ）。
  const epTags = (ep.tags ?? []).filter((tag) => !isHiddenTag(tag))
  if (epTags.length > 0) {
    const tagsRow = document.createElement('div')
    tagsRow.className = 'episode-detail-tags'
    epTags.forEach((tag) => tagsRow.appendChild(tagChip(tag)))
    rightCol.appendChild(tagsRow)
  }
  // 各話あらすじ（あれば・§51）。メタの下に読みやすく。
  const desc = ep.description?.trim()
  if (desc) {
    const p = document.createElement('p')
    p.className = 'episode-detail-desc'
    p.textContent = desc
    rightCol.appendChild(p)
  }
  detail.appendChild(rightCol)
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
  // 全話のタグを集計して表示する。シリーズ内の使用回数で降順・重複排除し、クール由来等の
  // hidden タグ（§68）は除外。Map の挿入順保持＋ sort 安定性で、同数は初出順がタイブレーク。
  // CSS 側で max-height（約6行）＋ overflow-y:auto に制限し、タグ過多でも詳細を圧迫しない。
  const tagCounts = new Map<string, number>()
  for (const ep of series.episodes) {
    for (const tag of ep.tags ?? []) {
      if (isHiddenTag(tag)) continue
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
    }
  }
  let detailTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag)
  // 各話にタグが無い場合はシリーズタグへフォールバック（hidden 除外）。
  if (detailTags.length === 0) {
    detailTags = series.tags.filter((tag) => !isHiddenTag(tag))
  }
  detailTags.forEach((tag) => tagsDiv.appendChild(tagChip(tag)))
  infoDiv.appendChild(tagsDiv)

  // シリーズメタ（§F）：詳細は圧縮しない＝文字ラベル＋実値（カンマ区切り）。
  // 話数／総再生数／総コメント数／総マイリス数＋1話あたり平均（再生・コメント）。
  if (series.episodes.length > 0) {
    const epCount = series.episodes.length
    const sumViews = series.episodes.reduce((a, e) => a + (e.viewCounter ?? 0), 0)
    const sumComment = series.episodes.reduce((a, e) => a + (e.commentCounter ?? 0), 0)
    const sumMylist = series.episodes.reduce((a, e) => a + (e.mylistCounter ?? 0), 0)
    const metaRow = document.createElement('div')
    metaRow.className = 'detail-series-meta'
    metaRow.appendChild(detailMeta('話数', `全${epCount}話`))
    if (sumViews > 0) metaRow.appendChild(detailMeta('総再生数', formatNumberFull(sumViews)))
    if (sumComment > 0)
      metaRow.appendChild(detailMeta('総コメント数', formatNumberFull(sumComment)))
    if (sumMylist > 0) metaRow.appendChild(detailMeta('総マイリス数', formatNumberFull(sumMylist)))
    // ビューア独自メタ（§81）：1 話あたり平均。実値（カンマ区切り）＋「/話」。
    if (sumViews > 0) {
      metaRow.appendChild(detailMeta('平均再生数', `${formatNumberFull(sumViews / epCount)}/話`))
    }
    if (sumComment > 0) {
      metaRow.appendChild(
        detailMeta('平均コメント数', `${formatNumberFull(sumComment / epCount)}/話`)
      )
    }
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
  } else if (series.seriesId < 0) {
    // 仮シリーズ（seriesId < 0）: 公式 URL 未確定のため無効ボタンを出す
    const pendingBtn = document.createElement('button')
    pendingBtn.type = 'button'
    pendingBtn.className = 'btn-primary official-series-link official-series-link--pending'
    pendingBtn.setAttribute('aria-disabled', 'true')
    pendingBtn.title = '公式シリーズ情報を取得中です'
    pendingBtn.dataset.tooltip = '公式シリーズ情報を取得中です'
    pendingBtn.addEventListener('click', (e) => e.preventDefault())
    pendingBtn.appendChild(icon('play', 16))
    pendingBtn.appendChild(document.createTextNode('公式シリーズページ（取得中）'))
    infoDiv.appendChild(pendingBtn)
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

  metaSection.appendChild(infoDiv)
  container.appendChild(metaSection)

  // あらすじはメタの横ではなく、メタの下に全幅の別ブロックで縦積み（§61）。
  // ラベル「あらすじ」＋本文。既定展開はデスクトップ/モバイルで分岐（§55）、
  // 改行保持＋文節折返し（§56/§57）は本文に適用。
  if (series.descriptionFirst) {
    const synopsis = document.createElement('section')
    synopsis.className = 'detail-synopsis'
    synopsis.dataset.section = 'synopsis'
    // UA `<details>` に依存しない自前ディスクロージャ（§62 堅牢化）。本文は常に DOM に
    // 存在し、開閉は class でのみ制御（デスクトップ既定=開 / モバイル既定=閉）。
    const p = document.createElement('p')
    p.className = 'detail-overview-body'
    p.textContent = series.descriptionFirst
    synopsis.appendChild(buildDisclosure('あらすじ', p))
    container.appendChild(synopsis)
  }

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
