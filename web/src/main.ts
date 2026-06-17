import './style.css'
import { parseScreen, buildListUrl } from './features/router'
import type { SortKey } from './features/router'
import { renderTop } from './features/top/top'
import type { TopData } from './features/top/top'
import { renderList } from './features/list/list'
import type { RangeStop } from './features/list/list'
import { renderDetail } from './features/detail/detail'
import { renderBreadcrumb } from './features/shared/breadcrumb'
import { buildHeader } from './features/shared/header'
import { initHeaderSearch } from './features/shared/search'
import { filterWorks, sortWorks, paginateWorks } from './features/list/filter'
import {
  isFavorite,
  isWatched,
  toggleFavorite,
  toggleWatched,
  getFavoriteIds,
  getWatchedIds,
} from './features/shared/user-state'
import { initTheme, toggleTheme, getTheme } from './features/shared/theme'
import { icon } from './components/icon'
import { formatViews, formatRelativeTime } from './components/meta'
import type { MetaSpec } from './components/meta'
import { initSettingsModal } from './features/shared/settings-modal'
import { renderFooter } from './features/shared/footer'
import {
  loadWorks,
  loadRanking,
  loadTags,
  loadCours,
  loadNew,
  loadSeriesDetail,
} from './data/loader'
import type {
  WorksJson,
  RankingJson,
  TagsJson,
  CoursJson,
  NewJson,
  SeriesDetailJson,
  Work,
} from './data/types'

const app = document.querySelector<HTMLDivElement>('#app')!

let cache: {
  works: WorksJson | null
  ranking: RankingJson | null
  tags: TagsJson | null
  cours: CoursJson | null
  newData: NewJson | null
} = { works: null, ranking: null, tags: null, cours: null, newData: null }

// お気に入り/未視聴フィルタの状態（インメモリ・URLに出さない）
let favFilter = false
let unwatchedFilter = false
// 再生時間／投稿年 レンジ＝停止点インデックス [loIdx, hiIdx]（インメモリ・null=絞り込みなし）
let durIdx: [number, number] | null = null
let yearIdx: [number, number] | null = null

// 再生時間の停止点（離散スナップ・§23）。value=分（0=下限なし／Infinity=上限なし）
const DURATION_STOPS: RangeStop[] = [
  { value: 0, label: '下限なし', tick: 'なし' },
  { value: 5, label: '5分', tick: '5分' },
  { value: 15, label: '15分', tick: '15分' },
  { value: 30, label: '30分', tick: '30分' },
  { value: 60, label: '1時間', tick: '1時間' },
  { value: 120, label: '2時間', tick: '2時間' },
  { value: Infinity, label: '上限なし', tick: '∞' },
]

/** 作品の平均話長（分・端数四捨五入）。不明は null */
function avgMinutes(w: Work): number | null {
  if (!w.durationTotal || !w.episodeCount) return null
  return Math.round(w.durationTotal / w.episodeCount / 60)
}
/** 作品の投稿年（初出＝firstAt 優先・なければ latestAt）。不明は null */
function workYear(w: Work): number | null {
  const t = w.firstAt ?? w.latestAt
  if (!t) return null
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? null : d.getFullYear()
}

async function ensureData(): Promise<void> {
  if (cache.works !== null) return
  try {
    const [works, ranking, tags, cours, newData] = await Promise.all([
      loadWorks(),
      loadRanking(),
      loadTags(),
      loadCours(),
      loadNew(),
    ])
    cache = { works, ranking, tags, cours, newData }
  } catch {
    // データ未生成の場合はスケルトンのまま続行
  }
}

function buildTopData(): TopData | undefined {
  if (!cache.works) return undefined
  const worksArr = cache.works.works
  // seriesId → 各話数（TOP10 カードの [film] 話数表示用）
  const episodeCounts: Record<number, number> = {}
  for (const w of worksArr) episodeCounts[w.seriesId] = w.episodeCount
  // 新着シリーズ＝「最新追加/更新」順。latestAt（最終話公開時刻）降順。
  // latestAt 欠落は firstAt → seriesId の順でフォールバックし、必ず最新順に並べる。
  const newestKey = (w: (typeof worksArr)[number]): number => {
    const t = w.latestAt ?? w.firstAt
    if (t) {
      const ms = Date.parse(t)
      if (!Number.isNaN(ms)) return ms
    }
    return w.seriesId // 時刻が一切無くても seriesId で最新側に寄せる
  }
  return {
    popular: cache.ranking?.popular ?? [],
    hotTags: cache.tags?.topHotTags ?? [],
    popularTags: cache.tags?.topPopularTags ?? [],
    allTags: cache.tags?.tags ?? [],
    cours: cache.cours?.cours ?? [],
    newSeries: [...worksArr].sort((a, b) => newestKey(b) - newestKey(a)).slice(0, 12),
    newEpisodes: cache.newData?.items ?? [],
    episodeCounts,
  }
}

/** 「見た」ボタンの状態を反映（on=eye / off=eye-off・塗り/形で一目・§20）。アイコンサイズ可変 */
function setWatchedState(btn: HTMLElement, on: boolean, size = 16): void {
  btn.classList.toggle('active', on)
  btn.replaceChildren(icon(on ? 'eye' : 'eye-off', size))
}

/** カードの ♥/見た ボタンを localStorage と同期させる */
function wireCards(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>('.series-card').forEach((card) => {
    const seriesId = Number(card.dataset.seriesId)
    if (!seriesId) return

    const favBtn = card.querySelector<HTMLButtonElement>('.card-favorite')
    const watchedBtn = card.querySelector<HTMLButtonElement>('.card-watched')

    if (favBtn) {
      if (isFavorite(seriesId)) favBtn.classList.add('active')
      favBtn.addEventListener('click', () => {
        const nowFav = toggleFavorite(seriesId)
        favBtn.classList.toggle('active', nowFav)
      })
    }
    if (watchedBtn) {
      setWatchedState(watchedBtn, isWatched(seriesId))
      watchedBtn.addEventListener('click', () => {
        setWatchedState(watchedBtn, toggleWatched(seriesId))
      })
    }
  })
}

/** 詳細画面の ♥/✓ ボタンを localStorage と同期させる */
function wireDetailMarks(container: HTMLElement, seriesId: number): void {
  const favBtn = container.querySelector<HTMLButtonElement>('.btn-favorite')
  const watchedBtn = container.querySelector<HTMLButtonElement>('.btn-watched')

  if (favBtn) {
    if (isFavorite(seriesId)) favBtn.classList.add('active')
    favBtn.addEventListener('click', () => {
      const nowFav = toggleFavorite(seriesId)
      favBtn.classList.toggle('active', nowFav)
    })
  }
  if (watchedBtn) {
    // 詳細の「見た」ボタンはアイコン（eye/eye-off）＋テキスト。アイコンのみ差し替える。
    const setDetailWatched = (on: boolean) => {
      watchedBtn.classList.toggle('active', on)
      const svg = watchedBtn.querySelector('svg')
      const next = icon(on ? 'eye' : 'eye-off', 16)
      if (svg) svg.replaceWith(next)
      else watchedBtn.insertBefore(next, watchedBtn.firstChild)
    }
    setDetailWatched(isWatched(seriesId))
    watchedBtn.addEventListener('click', () => setDetailWatched(toggleWatched(seriesId)))
  }
}

/** ヘッダのテーマトグルを現在の実効テーマに合わせる（ダーク=🌙 / ライト=☀）。 */
function setThemeIcon(btn: HTMLElement): void {
  const stored = getTheme()
  const isDark =
    stored === 'dark' ||
    (stored === null &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)
  btn.replaceChildren(icon(isDark ? 'moon' : 'sun'))
}

// 直近の render がユーザー操作（遷移）由来かどうか。初回ロード時は false。
let isNavigation = false

function navigate(url: string): void {
  history.pushState(null, '', url)
  isNavigation = true
  void render()
}

/** ヘッダの🔍/テーマ/⚙ を配線する（全画面共通） */
function wireHeaderControls(): void {
  const headerBtn = app.querySelector<HTMLElement>('.header-search-btn')
  if (headerBtn) initHeaderSearch(headerBtn, navigate)

  const themeBtn = app.querySelector<HTMLElement>('.theme-btn')
  if (themeBtn) {
    setThemeIcon(themeBtn)
    themeBtn.addEventListener('click', () => {
      toggleTheme()
      setThemeIcon(themeBtn)
    })
  }

  const settingsBtn = app.querySelector<HTMLElement>('.settings-btn')
  if (settingsBtn) {
    initSettingsModal(settingsBtn, app, {
      lastUpdated: cache.ranking?.lastUpdated ?? null,
      onRerender: () => void render(),
    })
  }
}

/** SPA 遷移後、主要コンテンツ（#main-content）へフォーカスを移す（§17.1） */
function focusMainIfNavigation(): void {
  if (!isNavigation) return
  isNavigation = false
  const main = app.querySelector<HTMLElement>('#main-content')
  main?.focus()
}

async function render(): Promise<void> {
  await ensureData()

  const params = new URLSearchParams(location.search)
  const screen = parseScreen(params)
  app.innerHTML = ''

  if (screen.type === 'top') {
    renderTop(app, buildTopData())

    const heroInput = app.querySelector<HTMLInputElement>('.hero-search-input')
    heroInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = heroInput.value.trim()
        if (q) navigate(`?q=${encodeURIComponent(q)}`)
      }
    })

    wireHeaderControls()
    wireCards(app)
  } else if (screen.type === 'list') {
    // 共通ヘッダ（banner）＋パンくず（nav）＋ main（content）
    app.appendChild(buildHeader({ heroSearchToggle: false }))

    const bcContainer = document.createElement('div')
    app.appendChild(bcContainer)
    renderBreadcrumb(bcContainer, screen)

    const main = document.createElement('main')
    main.id = 'main-content'
    main.tabIndex = -1
    app.appendChild(main)

    const allWorks = cache.works?.works ?? []
    const favIds = favFilter ? new Set(getFavoriteIds()) : undefined
    const watchedIds = unwatchedFilter ? new Set(getWatchedIds()) : undefined
    let filtered = filterWorks(allWorks, screen.state, { favIds, watchedIds })

    // 投稿年の停止点（データの最小〜最大年・10 年ごとに目盛り）
    const years = allWorks.map(workYear).filter((y): y is number => y != null)
    const minYear = years.length > 0 ? Math.min(...years) : 2000
    const maxYear = years.length > 0 ? Math.max(...years) : new Date().getFullYear()
    const YEAR_STOPS: RangeStop[] = []
    for (let y = minYear; y <= maxYear; y++) {
      YEAR_STOPS.push({
        value: y,
        label: `${y}`,
        tick: y === minYear || y === maxYear || y % 10 === 0 ? `${y}` : undefined,
      })
    }
    const durLast = DURATION_STOPS.length - 1
    const yearLast = YEAR_STOPS.length - 1

    // 再生時間レンジ（停止点→分。0=下限なし／Infinity=上限なし＝§23）
    if (durIdx) {
      const loMin = DURATION_STOPS[durIdx[0]].value
      const hiMin = DURATION_STOPS[durIdx[1]].value
      filtered = filtered.filter((w) => {
        const m = avgMinutes(w)
        if (m == null) return false
        if (loMin > 0 && m < loMin) return false
        if (hiMin !== Infinity && m > hiMin) return false
        return true
      })
    }
    // 投稿年レンジ
    if (yearIdx) {
      const loY = YEAR_STOPS[yearIdx[0]]?.value ?? minYear
      const hiY = YEAR_STOPS[yearIdx[1]]?.value ?? maxYear
      filtered = filtered.filter((w) => {
        const y = workYear(w)
        return y != null && y >= loY && y <= hiY
      })
    }

    const sorted = sortWorks(filtered, screen.state.sort, cache.ranking ?? null)
    const { items, totalCount, totalPages } = paginateWorks(sorted, screen.state.page)

    // カード下キャプション＝選択中の並び替えに応じた指標（§5）
    const hotMap = new Map((cache.ranking?.hot ?? []).map((r) => [r.seriesId, r.hotScore]))
    const viewMap = new Map((cache.ranking?.popular ?? []).map((r) => [r.seriesId, r.totalViews]))
    const cardMetric = (w: Work): MetaSpec | null => {
      if (screen.state.sort === 'hot') {
        const s = hotMap.get(w.seriesId)
        if (s == null || s <= 0) return null
        const v = String(Math.round(s * 1000)) // 0〜1 のブレンド値を「それっぽい」整数に
        return { icon: 'flame', value: v, label: `Hot ${v}` }
      }
      if (screen.state.sort === 'views') {
        const v = viewMap.get(w.seriesId)
        if (v == null) return null
        return { icon: 'play', value: formatViews(v), label: `再生数 ${formatViews(v)}` }
      }
      if (screen.state.sort === 'new') {
        const rel = w.latestAt ? formatRelativeTime(w.latestAt) : ''
        return rel ? { icon: 'clock', value: rel, label: `投稿 ${rel}` } : null
      }
      return null
    }

    renderList(main, {
      state: screen.state,
      works: items,
      totalCount,
      totalPages,
      data: {
        tags: cache.tags?.tags ?? [],
        cours: cache.cours?.cours ?? [],
      },
      favFilter,
      unwatchedFilter,
      cardMetric,
      onClearFav: () => {
        favFilter = false
        void render()
      },
      onClearUnwatched: () => {
        unwatchedFilter = false
        void render()
      },
      sliders: {
        duration: {
          name: '再生時間',
          stops: DURATION_STOPS,
          lowerIdx: durIdx?.[0] ?? 0,
          upperIdx: durIdx?.[1] ?? durLast,
          onChange: (lo, hi) => {
            durIdx = lo === 0 && hi === durLast ? null : [lo, hi]
            void render()
          },
        },
        year: {
          name: '投稿年',
          stops: YEAR_STOPS,
          lowerIdx: yearIdx?.[0] ?? 0,
          upperIdx: yearIdx?.[1] ?? yearLast,
          onChange: (lo, hi) => {
            yearIdx = lo === 0 && hi === yearLast ? null : [lo, hi]
            void render()
          },
        },
      },
    })

    const searchInput = app.querySelector<HTMLInputElement>('.list-search-input')
    searchInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = searchInput.value.trim()
        if (q) navigate(buildListUrl({ ...screen.state, q, page: 1 }))
      }
    })

    const sortRadios = app.querySelectorAll<HTMLInputElement>('input[name="sort"]')
    sortRadios.forEach((radio) => {
      radio.addEventListener('change', () => {
        if (radio.checked)
          navigate(buildListUrl({ ...screen.state, sort: radio.value as SortKey, page: 1 }))
      })
    })

    const favCb = app.querySelector<HTMLInputElement>('input[name="fav"]')
    const unwatchedCb = app.querySelector<HTMLInputElement>('input[name="unwatched"]')
    if (favCb) {
      favCb.checked = favFilter
      favCb.addEventListener('change', () => {
        favFilter = favCb.checked
        void render()
      })
    }
    if (unwatchedCb) {
      unwatchedCb.checked = unwatchedFilter
      unwatchedCb.addEventListener('change', () => {
        unwatchedFilter = unwatchedCb.checked
        void render()
      })
    }

    wireHeaderControls()
    wireCards(app)
  } else {
    app.appendChild(buildHeader({ heroSearchToggle: false }))

    const bcContainer = document.createElement('div')
    app.appendChild(bcContainer)
    renderBreadcrumb(bcContainer, screen)

    const main = document.createElement('main')
    main.id = 'main-content'
    main.tabIndex = -1
    app.appendChild(main)

    let seriesDetail: SeriesDetailJson | null = null
    try {
      seriesDetail = await loadSeriesDetail(screen.seriesId)
    } catch {
      // series/{id}.json 未生成 or ネットワークエラー
    }
    renderDetail(main, seriesDetail)
    wireDetailMarks(main, screen.seriesId)
    wireHeaderControls()
  }

  // 全ページ共通フッター（情報＝出典・更新・リポジトリ）を最後に置く（§10）
  app.appendChild(renderFooter({ lastUpdated: cache.ranking?.lastUpdated ?? null }))

  focusMainIfNavigation()
}

// テーマを最初に適用（FOUC を防ぐ）
initTheme()

window.addEventListener('popstate', () => {
  isNavigation = true
  void render()
})
void render()
