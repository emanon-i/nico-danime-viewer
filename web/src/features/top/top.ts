import type { RankingEntry, Tag, CoursGroup, Work, NewItem } from '../../data/types'
import { seriesLink } from '../../shared/deeplink'

export interface TopData {
  popular: RankingEntry[]
  hotTags: string[]
  popularTags: string[]
  allTags: Tag[]
  cours: CoursGroup[]
  newSeries: Work[]
  newEpisodes: NewItem[]
}

/** シリーズカードを生成する（♥/✓/[↗] のみ・ⓘ なし） */
export function createSeriesCard(
  seriesId: number,
  title: string,
  thumbnailUrl: string | null,
  officialHref: string
): HTMLElement {
  const card = document.createElement('div')
  card.className = 'series-card'
  card.dataset.seriesId = String(seriesId)

  const bodyLink = document.createElement('a')
  bodyLink.className = 'card-body'
  bodyLink.href = `?series=${seriesId}`

  const img = document.createElement('img')
  img.src = thumbnailUrl ?? ''
  img.alt = title
  img.loading = 'lazy'
  bodyLink.appendChild(img)

  const titleEl = document.createElement('div')
  titleEl.className = 'card-title'
  titleEl.textContent = title
  bodyLink.appendChild(titleEl)

  card.appendChild(bodyLink)

  const favBtn = document.createElement('button')
  favBtn.className = 'card-favorite'
  favBtn.setAttribute('aria-label', 'お気に入り')
  favBtn.textContent = '♥'
  card.appendChild(favBtn)

  const watchedBtn = document.createElement('button')
  watchedBtn.className = 'card-watched'
  watchedBtn.setAttribute('aria-label', '見た')
  watchedBtn.textContent = '✓'
  card.appendChild(watchedBtn)

  const extLink = document.createElement('a')
  extLink.className = 'card-external'
  extLink.href = officialHref
  extLink.target = '_blank'
  extLink.rel = 'noopener noreferrer'
  extLink.setAttribute('aria-label', '公式シリーズページ')
  extLink.textContent = '↗'
  card.appendChild(extLink)

  return card
}

function createTagChip(tag: string): HTMLAnchorElement {
  const a = document.createElement('a')
  a.className = 'tag-chip'
  a.href = `?tag=${encodeURIComponent(tag)}`
  a.textContent = tag
  return a
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
  popular.slice(0, 10).forEach((entry) => {
    const href = seriesLink(entry.seriesId) ?? ''
    const card = createSeriesCard(entry.seriesId, entry.title, entry.thumbnailUrl, href)
    rail.appendChild(card)
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
    hotTags.slice(0, 8).forEach((t) => hotDiv.appendChild(createTagChip(t)))
  }

  if (popularDiv) {
    popularDiv.innerHTML = ''
    const label = document.createElement('span')
    label.className = 'tag-section-label'
    label.textContent = '人気'
    popularDiv.appendChild(label)
    popularTags.slice(0, 8).forEach((t) => popularDiv.appendChild(createTagChip(t)))
  }

  if (randomDiv && shuffleBtn) {
    const allNames = allTags.map((t) => t.name)
    let currentSample = sampleTags(allNames, 5)

    const renderRandom = () => {
      const chips = randomDiv.querySelectorAll('.tag-chip')
      chips.forEach((c) => c.remove())
      currentSample.forEach((t) => randomDiv.insertBefore(createTagChip(t), shuffleBtn))
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
  container.innerHTML = `
    <header class="site-header" data-section="header">
      <a href="?" class="logo">ニコニコ支店ビューア</a>
      <button class="header-search-btn" aria-hidden="true" aria-label="検索">🔍</button>
      <button class="settings-btn" aria-label="設定/情報">⚙</button>
      <button class="theme-btn" aria-label="テーマ切替">☀</button>
    </header>
    <section class="hero" data-section="hero-search">
      <h2>ニコニコ支店から、観たい作品を探す</h2>
      <input type="search" class="hero-search-input"
             placeholder="作品・タグで検索…" aria-label="作品・タグで検索">
    </section>
    <section class="quick-access" data-section="quick-access">
      <a href="?cours=current&amp;sort=hot" class="quick-btn">今期</a>
      <a href="?sort=new" class="quick-btn">新着</a>
      <a href="?sort=hot" class="quick-btn">Hot</a>
      <a href="?sort=views" class="quick-btn">人気TOP</a>
    </section>
    <section class="top10" data-section="top10">
      <h2>人気シリーズ TOP10
        <button class="info-btn" aria-label="Hot と人気TOP の違いについて">ⓘ</button>
      </h2>
      <div class="card-rail top10-rail"></div>
      <a href="?sort=views" class="see-all">すべて見る →</a>
    </section>
    <section class="recent" data-section="recent">
      <h2>最近追加・更新された作品</h2>
      <ul class="recent-list"></ul>
      <a href="?sort=new" class="see-all">すべて見る →</a>
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
        <button class="shuffle-btn" aria-label="タグを引き直す">🔀</button>
      </div>
      <div class="tag-curated"></div>
    </section>
  `

  // ヒーローが見えている間はヘッダ🔍を非表示にする
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
