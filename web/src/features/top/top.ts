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

/** トップ画面の 7 セクションを container に描画する */
export function renderTop(container: HTMLElement): void {
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
}
