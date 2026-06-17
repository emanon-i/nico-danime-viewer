import type { RankingEntry, Tag, CoursGroup, Work } from '../../data/types'
import { seriesLink } from '../../shared/deeplink'
import { card } from '../../components/card'
import type { MetaSpec } from '../../components/meta'
import { listRow } from '../../components/listRow'
import { chip } from '../../components/chip'
import { icon } from '../../components/icon'
import { progressiveReveal } from '../../components/reveal'
import { initMarquee, initAutoScroll } from '../../components/marquee'
import { buildHeader } from '../shared/header'

export interface TopData {
  popular: RankingEntry[]
  hotTags: string[]
  popularTags: string[]
  allTags: Tag[]
  cours: CoursGroup[]
  /** 新規シリーズ＝firstAt（初話）降順（§73） */
  newSeries: Work[]
  /** 最近更新のあったシリーズ＝latestAt（最新話）降順（§73） */
  updatedSeries: Work[]
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
 * 「新着・更新」セクション（§73）。2 列とも**シリーズ型**：
 *   左＝新規シリーズ（firstAt 降順）／右＝最近更新のあったシリーズ（latestAt 降順）。
 * 各列に「すべて見る」を 1 つずつ（新規→?sort=created・最近更新→?sort=new）。
 * 旧「最新の動画（個別エピソード）」列は廃止（§73/§74）。
 */
function populateRecent(section: HTMLElement, newSeries: Work[], updatedSeries: Work[]): void {
  const list = section.querySelector<HTMLElement>('.recent-list')
  if (!list) return
  list.innerHTML = ''

  const MAX = 6
  // 両列の件数を揃えて行ベースラインを合わせる（片方 0 なら相手の件数）
  const nNew = Math.min(MAX, newSeries.length)
  const nUpd = Math.min(MAX, updatedSeries.length)
  const balanced = nNew > 0 && nUpd > 0 ? Math.min(nNew, nUpd) : 0

  const buildColumn = (
    subsection: string,
    label: string,
    seeAllSort: string,
    items: Work[],
    count: number
  ): void => {
    const col = document.createElement('li')
    col.dataset.subsection = subsection
    // 列ヘッダ＝ラベル＋すべて見る（各列 1 つ・§73）
    const header = document.createElement('div')
    header.className = 'recent-col-head'
    const strong = document.createElement('strong')
    strong.textContent = label
    header.appendChild(strong)
    const seeAll = document.createElement('a')
    seeAll.className = 'see-all'
    seeAll.href = `?sort=${seeAllSort}`
    seeAll.textContent = 'すべて見る'
    header.appendChild(seeAll)
    col.appendChild(header)

    items.slice(0, count).forEach((w) => {
      // シリーズ型は「話数で語る」＝[film]N話（§9.3）。本体クリック＝詳細・↗＝公式（§24）
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
      col.appendChild(row)
    })
    list.appendChild(col)
  }

  buildColumn('new-series', '新規シリーズ', 'created', newSeries, balanced || nNew)
  buildColumn('updated-series', '最近更新のあったシリーズ', 'new', updatedSeries, balanced || nUpd)
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

  // ランダム＝タグ辞書からサンプル（[🔀] で引き直し）。行は自動横スクロール＋手動（§70）、
  // ラベル＋シャッフルボタンは先頭に sticky 固定して連打可能に（§69）。
  if (randomDiv && shuffleBtn) {
    const allNames = discoveryTags(allTags).map((t) => t.name)
    const SAMPLE = 16 // マーキーとして流れる十分な数（引き直しで再サンプル）
    let currentSample = sampleTags(allNames, SAMPLE)

    // 先頭固定（sticky）リード＝ラベル「ランダム」＋シャッフルボタン。スクロール/シャッフルで
    // 位置がずれない＝同じ座標で連打できる（§69）。テンプレの shuffleBtn をここへ移動。
    let lead = randomDiv.querySelector<HTMLElement>('.tag-random-lead')
    if (!lead) {
      lead = document.createElement('div')
      lead.className = 'tag-random-lead'
      const labelEl = document.createElement('span')
      labelEl.className = 'tag-section-label'
      labelEl.textContent = 'ランダム'
      lead.appendChild(labelEl)
      lead.appendChild(shuffleBtn)
      randomDiv.insertBefore(lead, randomDiv.firstChild)
    }

    const renderRandom = () => {
      randomDiv.querySelectorAll('.tag-chip').forEach((c) => c.remove())
      for (const t of currentSample) {
        randomDiv.appendChild(chip(t, `?tag=${encodeURIComponent(t)}`))
      }
      randomDiv.scrollLeft = 0 // 引き直したら先頭から見せる（sticky ボタンは不動）
    }

    shuffleBtn.addEventListener('click', () => {
      currentSample = sampleTags(allNames, SAMPLE)
      renderRandom()
    })

    renderRandom()
    initAutoScroll(randomDiv) // 自動横スクロール＋手動スクロール共存（§70）
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
        <a href="?cours=previous&amp;sort=hot" class="quick-btn">前期</a>
        <a href="?sort=views" class="quick-btn">人気</a>
        <a href="?sort=hot" class="quick-btn">Hot</a>
        <a href="?screen=list&amp;fav=1" class="quick-btn">お気に入り</a>
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
      <h2>新着・更新</h2>
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

  // クイックアクセス下段＝ランダムタグのマーキー（§36/§60）。同じ並びを 2 回敷いて
  // シームレスにし、JS で自動送りしつつ手動スクロール/スワイプも可能にする（initMarquee）。
  const viewport = container.querySelector<HTMLElement>('.quick-marquee')
  const track = container.querySelector<HTMLElement>('.quick-marquee-track')
  if (viewport && track && data.allTags && data.allTags.length > 0) {
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
    initMarquee(viewport, track)
  }

  const rail = container.querySelector<HTMLElement>('.top10-rail')
  if (rail && data.popular) populateTop10(rail, data.popular, data.episodeCounts)

  const recentSection = container.querySelector<HTMLElement>('[data-section="recent"]')
  if (recentSection) {
    populateRecent(recentSection, data.newSeries ?? [], data.updatedSeries ?? [])
  }

  const coursDiv = container.querySelector<HTMLElement>('.cours-buttons')
  if (coursDiv && data.cours) populateCours(coursDiv, data.cours)

  const tagsSection = container.querySelector<HTMLElement>('[data-section="tags"]')
  if (tagsSection) {
    populateTags(tagsSection, data.hotTags ?? [], data.popularTags ?? [], data.allTags ?? [])
  }
}
