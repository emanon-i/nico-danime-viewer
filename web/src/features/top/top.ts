import type { RankingEntry, Tag, CoursGroup, Work, NewItem } from '../../data/types'
import { seriesLink, watchLink } from '../../shared/deeplink'
import { card } from '../../components/card'
import { formatViews, formatRelativeTime } from '../../components/meta'
import type { MetaSpec } from '../../components/meta'
import { listRow } from '../../components/listRow'
import { chip } from '../../components/chip'
import { icon } from '../../components/icon'
import { buildHeader } from '../shared/header'

export interface TopData {
  popular: RankingEntry[]
  hotTags: string[]
  popularTags: string[]
  allTags: Tag[]
  cours: CoursGroup[]
  newSeries: Work[]
  newEpisodes: NewItem[]
  /** seriesId → 各話数。TOP10 カードの [film] 話数表示に使う（works.json 由来） */
  episodeCounts?: Record<number, number>
}

function sampleTags(pool: string[], count: number): string[] {
  const src = [...pool]
  const result: string[] = []
  while (result.length < count && src.length > 0) {
    const i = Math.floor(Math.random() * src.length)
    result.push(src.splice(i, 1)[0])
  }
  return result
}

function populateTop10(
  rail: HTMLElement,
  popular: RankingEntry[],
  episodeCounts?: Record<number, number>
): void {
  rail.innerHTML = ''
  popular.slice(0, 10).forEach((entry, i) => {
    const href = seriesLink(entry.seriesId) ?? ''
    rail.appendChild(
      card(entry.seriesId, entry.title, entry.thumbnailUrl, href, {
        rank: i + 1,
        views: entry.totalViews,
        episodeCount: episodeCounts?.[entry.seriesId],
      })
    )
  })
}

/**
 * 話タイトルから「第N話」ラベルを取り出してバッジ化し、本文タイトルからは除去する。
 * バッジはタイトル表記そのものを採用するため必ず一致する（nvapi の episode_no とは
 * 番号がずれることがあるので、タイトル優先・episode_no はフォールバック）。
 */
function splitEpisodeLabel(
  title: string,
  episodeNo: number | null
): { badge: string | null; title: string } {
  const m = title.match(/第[0-9０-９]+話/)
  if (m) {
    const cleaned = title.replace(m[0], ' ').replace(/\s+/g, ' ').trim()
    return { badge: m[0], title: cleaned }
  }
  if (episodeNo != null) return { badge: `第${episodeNo}話`, title }
  return { badge: null, title }
}

function populateRecent(section: HTMLElement, newSeries: Work[], newEpisodes: NewItem[]): void {
  const list = section.querySelector<HTMLElement>('.recent-list')
  if (!list) return
  list.innerHTML = ''

  const resolvedEps = newEpisodes.filter(
    (ep) => ep.resolutionStatus === 'resolved' && ep.resolvedContentId
  )
  // 横並び 2 列の整列のため、両列の件数を揃える（最大 5）
  const count = Math.min(5, newSeries.length, resolvedEps.length)

  // 新着シリーズ（シリーズ型: layers バッジ＋「全N話」＋ ↗ 公式シリーズ）
  const seriesSec = document.createElement('li')
  seriesSec.dataset.subsection = 'new-series'
  const seriesLabel = document.createElement('strong')
  seriesLabel.textContent = '新着シリーズ'
  seriesSec.appendChild(seriesLabel)
  newSeries.slice(0, count).forEach((w) => {
    // シリーズ型は「話数で語る」＝[film]N話（§9.3）
    const metas: MetaSpec[] = [
      { icon: 'film', value: `${w.episodeCount}話`, label: `全${w.episodeCount}話` },
    ]
    const row = listRow({
      kind: 'series',
      title: w.title,
      href: `?series=${w.seriesId}`,
      thumbnailUrl: w.thumbnailUrl,
      badge: 'シリーズ',
      metas,
      externalHref: seriesLink(w.seriesId) ?? undefined,
    })
    row.classList.add('recent-item')
    seriesSec.appendChild(row)
  })
  list.appendChild(seriesSec)

  // 最新の動画（各話型: 「第N話」バッジ＋話タイトル＋再生数/日付＋ ↗ 公式 watch）
  const epSec = document.createElement('li')
  epSec.dataset.subsection = 'new-episodes'
  const epLabel = document.createElement('strong')
  epLabel.textContent = '最新の動画'
  epSec.appendChild(epLabel)
  resolvedEps.slice(0, count).forEach((ep) => {
    const cid = ep.resolvedContentId as string
    const watchHref = watchLink(cid) ?? `https://www.nicovideo.jp/watch/${cid}`
    // 各話型は「新しさ（投稿時間）で語る」＝[clock]投稿時間（強調）＋[play]再生数（§9.3）
    const metas: MetaSpec[] = []
    const rel = formatRelativeTime(ep.pubDate)
    if (rel) metas.push({ icon: 'clock', value: rel, label: `投稿 ${rel}`, emphasize: true })
    if (typeof ep.viewCounter === 'number') {
      metas.push({
        icon: 'play',
        value: formatViews(ep.viewCounter),
        label: `再生数 ${formatViews(ep.viewCounter)}`,
      })
    }
    const ep_label = splitEpisodeLabel(ep.title, ep.episodeNo)
    const row = listRow({
      kind: 'episode',
      title: ep_label.title,
      href: watchHref,
      thumbnailUrl: ep.thumbnailUrl,
      external: true,
      badge: ep_label.badge ?? undefined,
      metas,
      externalHref: watchHref,
    })
    row.classList.add('recent-item')
    epSec.appendChild(row)
  })
  list.appendChild(epSec)
}

function coursButton(cg: CoursGroup): HTMLElement {
  const a = document.createElement('a')
  a.className = 'cours-btn'
  a.href = `?cours=${encodeURIComponent(cg.cours)}&sort=hot`
  a.textContent = cg.cours
  return a
}

function populateCours(coursDiv: HTMLElement, cours: CoursGroup[]): void {
  coursDiv.innerHTML = ''
  // 直近の季はインライン、それ以前は [過去季 ▾] の後ろに畳む（screens.md 準拠）
  const INLINE = 4
  cours.slice(0, INLINE).forEach((cg) => coursDiv.appendChild(coursButton(cg)))

  const past = cours.slice(INLINE)
  if (past.length > 0) {
    const moreBtn = document.createElement('button')
    moreBtn.className = 'cours-more-btn'
    moreBtn.textContent = '過去季 ▾'
    moreBtn.addEventListener('click', () => {
      past.forEach((cg) => coursDiv.insertBefore(coursButton(cg), moreBtn))
      moreBtn.remove()
    })
    coursDiv.appendChild(moreBtn)
  }
}

/** ラベル付きチップ行に「ラベル＋チップ群」を描画する（Hot/人気/定番で共通）。 */
function fillTagRow(row: HTMLElement, label: string, tags: string[]): void {
  row.innerHTML = ''
  const labelEl = document.createElement('span')
  labelEl.className = 'tag-section-label'
  labelEl.textContent = label
  row.appendChild(labelEl)
  tags.forEach((t) => row.appendChild(chip(t, `?tag=${encodeURIComponent(t)}`)))
}

/** タグ辞書として発見性のあるタグ（巨大な汎用タグ「アニメ」「第一話」を除外）。 */
function discoveryTags(allTags: Tag[]): Tag[] {
  const EXCLUDE = new Set(['アニメ', '第一話'])
  return allTags.filter((t) => !EXCLUDE.has(t.name))
}

function populateTags(
  container: HTMLElement,
  hotTags: string[],
  popularTags: string[],
  allTags: Tag[]
): void {
  const hotDiv = container.querySelector<HTMLElement>('.tag-hot')
  const popularDiv = container.querySelector<HTMLElement>('.tag-popular')
  const randomDiv = container.querySelector<HTMLElement>('.tag-random')
  const curatedDiv = container.querySelector<HTMLElement>('.tag-curated')
  const shuffleBtn = randomDiv?.querySelector<HTMLElement>('.shuffle-btn')

  // Hot のタグ＝Hot 上位作品の頻出タグ
  if (hotDiv) fillTagRow(hotDiv, 'Hot', hotTags.slice(0, 8))

  // 人気のタグ＝人気TOP 上位作品の頻出タグ
  if (popularDiv) fillTagRow(popularDiv, '人気', popularTags.slice(0, 8))

  // ランダム＝タグ辞書からサンプル（[🔀] で引き直し）
  if (randomDiv && shuffleBtn) {
    const allNames = discoveryTags(allTags).map((t) => t.name)
    let currentSample = sampleTags(allNames, 5)

    // ラベルを先頭に常設（チップ/シャッフルとは別に固定）
    let labelEl = randomDiv.querySelector<HTMLElement>('.tag-section-label')
    if (!labelEl) {
      labelEl = document.createElement('span')
      labelEl.className = 'tag-section-label'
      labelEl.textContent = 'ランダム'
      randomDiv.insertBefore(labelEl, randomDiv.firstChild)
    }

    const renderRandom = () => {
      randomDiv.querySelectorAll('.tag-chip').forEach((c) => c.remove())
      currentSample.forEach((t) =>
        randomDiv.insertBefore(chip(t, `?tag=${encodeURIComponent(t)}`), shuffleBtn)
      )
    }

    shuffleBtn.addEventListener('click', () => {
      currentSample = sampleTags(allNames, 5)
      renderRandom()
    })

    renderRandom()
  }

  // 定番＝正規化済みタグ（dアニメキュレーション含む）。再生作品数の多い順。[もっと▾] で追加表示
  if (curatedDiv) {
    const staples = discoveryTags(allTags)
      .filter((t) => t.isCurated)
      .sort((a, b) => b.seriesCount - a.seriesCount)
      .map((t) => t.name)
    const INITIAL = 10
    fillTagRow(curatedDiv, '定番', staples.slice(0, INITIAL))

    if (staples.length > INITIAL) {
      const moreBtn = document.createElement('button')
      moreBtn.className = 'tag-more-btn'
      moreBtn.textContent = 'もっと ▾'
      moreBtn.addEventListener('click', () => {
        staples
          .slice(INITIAL)
          .forEach((t) =>
            curatedDiv.insertBefore(chip(t, `?tag=${encodeURIComponent(t)}`), moreBtn)
          )
        moreBtn.remove()
      })
      curatedDiv.appendChild(moreBtn)
    }
  }
}

/** トップ画面の 7 セクションを container に描画する */
export function renderTop(container: HTMLElement, data?: Partial<TopData>): void {
  // テンプレート補間なし（静的文字列のみ）→ アイコンは後から DOM API で挿入
  container.innerHTML = `
    <main id="main-content" tabindex="-1">
    <section class="hero" data-section="hero-search">
      <div class="hero-search">
        <span class="hero-search-icon"></span>
        <input type="search" class="hero-search-input"
               placeholder="作品・タグで検索…" aria-label="作品・タグで検索">
      </div>
      <a href="?screen=list" class="btn-primary hero-browse-btn">一覧で探す →</a>
    </section>
    <nav class="quick-access" data-section="quick-access" aria-label="クイックアクセス">
      <a href="?cours=current&amp;sort=hot" class="quick-btn">今期</a>
      <a href="?sort=views" class="quick-btn">人気</a>
      <a href="?sort=hot" class="quick-btn">Hot</a>
    </nav>
    <section class="top10" data-section="top10">
      <div class="section-head">
        <h2>人気シリーズ TOP10
          <button class="info-btn" aria-label="Hot と人気TOP の違いについて" title="Hot＝今の勢い（再生数と公開からの日数からの目安・正確な期間集計ではありません）／人気TOP＝全期間の累計再生数による定番ランキング"></button>
        </h2>
        <a href="?sort=views" class="see-all">すべて見る</a>
      </div>
      <div class="card-rail top10-rail"></div>
    </section>
    <section class="recent" data-section="recent">
      <div class="section-head">
        <h2>最近追加・更新された作品</h2>
        <a href="?sort=new" class="see-all">すべて見る</a>
      </div>
      <ul class="recent-list"></ul>
    </section>
    <section class="cours-browse" data-section="cours">
      <h2>クールから探す</h2>
      <div class="cours-buttons"></div>
    </section>
    <section class="tag-browse" data-section="tags">
      <h2>タグから探す</h2>
      <div class="tag-hot"></div>
      <div class="tag-popular"></div>
      <div class="tag-random">
        <button class="icon-btn shuffle-btn" aria-label="タグを引き直す"></button>
      </div>
      <div class="tag-curated"></div>
    </section>
    </main>
  `

  // 共通ヘッダ（banner）をコンテンツ（main）の前に差し込む（§17.5 ランドマーク）
  container.insertBefore(buildHeader({ heroSearchToggle: true }), container.firstChild)

  // アイコンを DOM API で挿入（innerHTML テンプレート補間を使わない）
  container.querySelector('.hero-search-icon')?.appendChild(icon('search', 18))
  container.querySelector('.shuffle-btn')?.appendChild(icon('shuffle'))
  // ⓘ は emoji グリフを使わずバンドル SVG（中央/ベースライン揃え・§8.1 emoji 不使用）
  container.querySelector('.info-btn')?.appendChild(icon('info', 14))

  // ヒーローが見えている間はヘッダ検索ボタンを非表示にする
  const hero = container.querySelector<HTMLElement>('.hero')
  const headerSearchBtn = container.querySelector<HTMLElement>('.header-search-btn')
  if (hero && headerSearchBtn && 'IntersectionObserver' in window) {
    new IntersectionObserver(
      (entries) => {
        const visible = entries[0]?.isIntersecting ?? true
        headerSearchBtn.setAttribute('aria-hidden', visible ? 'true' : 'false')
      },
      { threshold: 0 }
    ).observe(hero)
  }

  if (!data) return

  // クイックアクセスのランダムタグ×2（厳選5 のうち 2 枠・タグチップ型ピル）
  const quickAccess = container.querySelector<HTMLElement>('[data-section="quick-access"]')
  if (quickAccess && data.allTags && data.allTags.length > 0) {
    const names = discoveryTags(data.allTags).map((t) => t.name)
    sampleTags(names, 2).forEach((t) => {
      const c = chip(`#${t}`, `?tag=${encodeURIComponent(t)}`)
      c.classList.add('quick-tag')
      quickAccess.appendChild(c)
    })
  }

  const rail = container.querySelector<HTMLElement>('.top10-rail')
  if (rail && data.popular) populateTop10(rail, data.popular, data.episodeCounts)

  const recentSection = container.querySelector<HTMLElement>('[data-section="recent"]')
  if (recentSection) {
    populateRecent(recentSection, data.newSeries ?? [], data.newEpisodes ?? [])
  }

  const coursDiv = container.querySelector<HTMLElement>('.cours-buttons')
  if (coursDiv && data.cours) populateCours(coursDiv, data.cours)

  const tagsSection = container.querySelector<HTMLElement>('[data-section="tags"]')
  if (tagsSection) {
    populateTags(tagsSection, data.hotTags ?? [], data.popularTags ?? [], data.allTags ?? [])
  }
}
