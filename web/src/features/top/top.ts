import type { RankingEntry, Tag, CoursGroup, Work, NewItem } from '../../data/types'
import { seriesLink } from '../../shared/deeplink'
import { card } from '../../components/card'
import { chip } from '../../components/chip'
import { icon } from '../../components/icon'

export interface TopData {
  popular: RankingEntry[]
  hotTags: string[]
  popularTags: string[]
  allTags: Tag[]
  cours: CoursGroup[]
  newSeries: Work[]
  newEpisodes: NewItem[]
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

function populateTop10(rail: HTMLElement, popular: RankingEntry[]): void {
  rail.innerHTML = ''
  popular.slice(0, 10).forEach((entry, i) => {
    const href = seriesLink(entry.seriesId) ?? ''
    rail.appendChild(
      card(entry.seriesId, entry.title, entry.thumbnailUrl, href, {
        rank: i + 1,
        views: entry.totalViews,
      })
    )
  })
}

function populateRecent(section: HTMLElement, newSeries: Work[], newEpisodes: NewItem[]): void {
  const list = section.querySelector<HTMLElement>('.recent-list')
  if (!list) return
  list.innerHTML = ''

  const seriesSec = document.createElement('li')
  seriesSec.dataset.subsection = 'new-series'
  const seriesLabel = document.createElement('strong')
  seriesLabel.textContent = '新着シリーズ'
  seriesSec.appendChild(seriesLabel)
  newSeries.slice(0, 5).forEach((w) => {
    const item = document.createElement('div')
    item.className = 'recent-item'
    const a = document.createElement('a')
    a.href = `?series=${w.seriesId}`
    a.textContent = w.title
    item.appendChild(a)
    seriesSec.appendChild(item)
  })
  list.appendChild(seriesSec)

  const epSec = document.createElement('li')
  epSec.dataset.subsection = 'new-episodes'
  const epLabel = document.createElement('strong')
  epLabel.textContent = '最新の動画'
  epSec.appendChild(epLabel)
  newEpisodes
    .filter((ep) => ep.resolutionStatus === 'resolved' && ep.resolvedContentId)
    .slice(0, 5)
    .forEach((ep) => {
      const item = document.createElement('div')
      item.className = 'recent-item'
      const a = document.createElement('a')
      a.href = `https://www.nicovideo.jp/watch/${ep.resolvedContentId}`
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.textContent = ep.title
      item.appendChild(a)
      epSec.appendChild(item)
    })
  list.appendChild(epSec)
}

function populateCours(coursDiv: HTMLElement, cours: CoursGroup[]): void {
  coursDiv.innerHTML = ''
  cours.forEach((cg) => {
    const a = document.createElement('a')
    a.className = 'cours-btn'
    a.href = `?cours=${encodeURIComponent(cg.cours)}&sort=hot`
    a.textContent = cg.cours
    coursDiv.appendChild(a)
  })
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
  const shuffleBtn = randomDiv?.querySelector<HTMLElement>('.shuffle-btn')

  if (hotDiv) {
    hotDiv.innerHTML = ''
    const label = document.createElement('span')
    label.className = 'tag-section-label'
    label.textContent = 'Hot'
    hotDiv.appendChild(label)
    hotTags.slice(0, 8).forEach((t) => hotDiv.appendChild(chip(t, `?tag=${encodeURIComponent(t)}`)))
  }

  if (popularDiv) {
    popularDiv.innerHTML = ''
    const label = document.createElement('span')
    label.className = 'tag-section-label'
    label.textContent = '人気'
    popularDiv.appendChild(label)
    popularTags
      .slice(0, 8)
      .forEach((t) => popularDiv.appendChild(chip(t, `?tag=${encodeURIComponent(t)}`)))
  }

  if (randomDiv && shuffleBtn) {
    const allNames = allTags.map((t) => t.name)
    let currentSample = sampleTags(allNames, 5)

    const renderRandom = () => {
      const chips = randomDiv.querySelectorAll('.tag-chip')
      chips.forEach((c) => c.remove())
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
}

/** トップ画面の 7 セクションを container に描画する */
export function renderTop(container: HTMLElement, data?: Partial<TopData>): void {
  // テンプレート補間なし（静的文字列のみ）→ アイコンは後から DOM API で挿入
  container.innerHTML = `
    <header class="site-header" data-section="header">
      <a href="?" class="logo">ニコニコ支店ビューア</a>
      <button class="icon-btn header-search-btn" aria-hidden="true" aria-label="検索"></button>
      <button class="icon-btn settings-btn" aria-label="設定/情報"></button>
      <button class="icon-btn theme-btn" aria-label="テーマ切替"></button>
    </header>
    <section class="hero" data-section="hero-search">
      <h2>ニコニコ支店から、観たい作品を探す</h2>
      <div class="hero-search">
        <span class="hero-search-icon"></span>
        <input type="search" class="hero-search-input"
               placeholder="作品・タグで検索…" aria-label="作品・タグで検索">
      </div>
    </section>
    <section class="quick-access" data-section="quick-access">
      <a href="?cours=current&amp;sort=hot" class="quick-btn">今期</a>
      <a href="?sort=new" class="quick-btn">新着</a>
      <a href="?sort=hot" class="quick-btn">Hot</a>
      <a href="?sort=views" class="quick-btn">人気TOP</a>
    </section>
    <section class="top10" data-section="top10">
      <div class="section-head">
        <h2>人気シリーズ TOP10
          <button class="info-btn" aria-label="Hot と人気TOP の違いについて" title="Hot＝今の勢い（再生数と公開からの日数からの目安・正確な期間集計ではありません）／人気TOP＝全期間の累計再生数による定番ランキング">ⓘ</button>
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
  `

  // アイコンを DOM API で挿入（innerHTML テンプレート補間を使わない）
  container.querySelector('.header-search-btn')?.appendChild(icon('search'))
  container.querySelector('.hero-search-icon')?.appendChild(icon('search', 18))
  container.querySelector('.settings-btn')?.appendChild(icon('settings'))
  container.querySelector('.theme-btn')?.appendChild(icon('sun'))
  container.querySelector('.shuffle-btn')?.appendChild(icon('shuffle'))

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

  const rail = container.querySelector<HTMLElement>('.top10-rail')
  if (rail && data.popular) populateTop10(rail, data.popular)

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
