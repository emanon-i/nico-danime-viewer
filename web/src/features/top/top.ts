import type { RankingEntry, Tag, CoursGroup, Work, NewItem } from '../../data/types'
import { seriesLink, watchLink } from '../../shared/deeplink'
import { card } from '../../components/card'
import { formatViews, formatRelativeTime } from '../../components/meta'
import type { MetaSpec } from '../../components/meta'
import { listRow } from '../../components/listRow'
import { chip } from '../../components/chip'
import { icon } from '../../components/icon'
import { progressiveReveal } from '../../components/reveal'
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
      // Top のシリーズ系カードは全て統一: 本体クリック＝うちの作品詳細・右上 ↗ で公式（§24/§40）
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

  // 解決済み（nvapi で so… に解決済み）を優先。1 件も無いときは rss_only でも
  // フォールバック表示し「最新動画が常に出る」を担保（§37）。列は互いに独立させ、
  // 片方が 0 でももう片方を巻き込んで空にしない（旧 Math.min 結合バグの除去）。
  const resolvedEps = newEpisodes.filter(
    (ep) => ep.resolutionStatus === 'resolved' && ep.resolvedContentId
  )
  const epsSource = resolvedEps.length > 0 ? resolvedEps : newEpisodes
  // 各列の上限（独立）。両方データがあれば見た目を揃えるため同数に切り詰める。
  const MAX = 6
  const seriesCount = Math.min(MAX, newSeries.length)
  const epsCount = Math.min(MAX, epsSource.length)
  const balanced = seriesCount > 0 && epsCount > 0 ? Math.min(seriesCount, epsCount) : 0
  const seriesShow = balanced || seriesCount
  const epsShow = balanced || epsCount

  // 新着シリーズ（シリーズ型）: 本体クリック＝うちの作品詳細・↗ で公式シリーズ（§24）
  const seriesSec = document.createElement('li')
  seriesSec.dataset.subsection = 'new-series'
  const seriesLabel = document.createElement('strong')
  seriesLabel.textContent = '新着シリーズ'
  seriesSec.appendChild(seriesLabel)
  newSeries.slice(0, seriesShow).forEach((w) => {
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
  epsSource.slice(0, epsShow).forEach((ep) => {
    // 解決済みは so… の watch、未解決(rss_only)は数値 watchId へフォールバック
    const cid = ep.resolvedContentId ?? ep.watchId
    const watchHref = ep.resolvedContentId
      ? (watchLink(ep.resolvedContentId) ?? `https://www.nicovideo.jp/watch/${cid}`)
      : `https://www.nicovideo.jp/watch/${ep.watchId}`
    // 各話型は「新しさ（投稿時間）で語る」＝[clock]投稿時間（強調）＋[play]再生数
    // ＋取れていれば [message]コメント・[bookmark]マイリス（§25）
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
    if (typeof ep.commentCounter === 'number') {
      metas.push({
        icon: 'message',
        value: formatViews(ep.commentCounter),
        label: `コメント ${formatViews(ep.commentCounter)}`,
      })
    }
    if (typeof ep.mylistCounter === 'number') {
      metas.push({
        icon: 'bookmark',
        value: formatViews(ep.mylistCounter),
        label: `マイリスト ${formatViews(ep.mylistCounter)}`,
      })
    }
    const ep_label = splitEpisodeLabel(ep.title, ep.episodeNo)
    // Top の各話行は本体が外部（公式 watch）＝行全体が外部・別途の ↗ は出さない（§11）
    const row = listRow({
      kind: 'episode',
      title: ep_label.title,
      href: watchHref,
      thumbnailUrl: ep.thumbnailUrl,
      external: true,
      badge: ep_label.badge ?? undefined,
      metas,
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
  // 直近の季をインライン、それ以降は「もっと見る」で段階表示＋「閉じる」で畳む（§26）
  // 全 213 季を一度に出さず、押すごとに増える（数回で全部見える）
  progressiveReveal(coursDiv, cours.length, (i) => coursButton(cours[i]), {
    initial: 8,
    step: 70,
    itemClass: 'cours-btn',
    moreLabel: 'もっと見る',
  })
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

/** タグ辞書として発見性のあるタグ（巨大な汎用タグ「アニメ」「第1話/第一話」を除外＝§27）。 */
function discoveryTags(allTags: Tag[]): Tag[] {
  const EXCLUDE = new Set(['アニメ', '第一話', '第1話'])
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

  // タグ一覧＝全タグを出現（作品）数の多い順。[もっと▾] でバッチ追加表示（§7）
  if (curatedDiv) {
    curatedDiv.innerHTML = ''
    const labelEl = document.createElement('span')
    labelEl.className = 'tag-section-label'
    labelEl.textContent = 'タグ'
    curatedDiv.appendChild(labelEl)

    const all = discoveryTags(allTags)
      .slice()
      .sort((a, b) => b.seriesCount - a.seriesCount)
      .map((t) => t.name)
    // 出現数の多い順に十分な数を初期表示し、もっと見る ▾／閉じる ▴ で増減（§22/§26）
    progressiveReveal(
      curatedDiv,
      all.length,
      (i) => chip(all[i], `?tag=${encodeURIComponent(all[i])}`),
      {
        initial: 24,
        step: 40,
        itemClass: 'tag-chip',
        moreLabel: 'もっと見る',
      }
    )
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
      <a href="?screen=list" class="btn-primary hero-browse-btn">一覧で探す</a>
    </section>
    <nav class="quick-access" data-section="quick-access" aria-label="クイックアクセス">
      <div class="quick-row quick-row-primary">
        <a href="?cours=current&amp;sort=hot" class="quick-btn">今期</a>
        <a href="?sort=views" class="quick-btn">人気</a>
        <a href="?sort=hot" class="quick-btn">Hot</a>
      </div>
      <div class="quick-marquee" aria-label="タグから探す">
        <div class="quick-marquee-track"></div>
      </div>
    </nav>
    <section class="top10" data-section="top10">
      <div class="section-head">
        <h2>人気シリーズ TOP10
          <button class="info-btn" aria-label="Hot と人気TOP の違いについて" data-tooltip="Hot＝今の勢い（再生数と公開からの日数からの目安・正確な期間集計ではありません）／人気TOP＝全期間の累計再生数による定番ランキング"></button>
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

  // クイックアクセス下段＝ランダムタグのマーキー（横自動スクロール・§36）。
  // タグは内容幅にフィット。シームレスなループのため同じ並びを 2 回敷き、
  // CSS で track を -50% まで流す。prefers-reduced-motion では停止（CSS 側）。
  const track = container.querySelector<HTMLElement>('.quick-marquee-track')
  if (track && data.allTags && data.allTags.length > 0) {
    const names = discoveryTags(data.allTags).map((t) => t.name)
    const picked = sampleTags(names, 16)
    const build = (t: string, dup: boolean): HTMLElement => {
      const c = chip(`#${t}`, `?tag=${encodeURIComponent(t)}`)
      c.classList.add('quick-tag')
      if (dup) c.setAttribute('aria-hidden', 'true') // 複製分は読み上げ対象外
      return c
    }
    for (const t of picked) track.appendChild(build(t, false))
    for (const t of picked) track.appendChild(build(t, true))
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
