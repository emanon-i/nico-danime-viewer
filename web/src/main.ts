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
import { initTooltips, wireTruncationTooltips } from './components/tooltip'
import { isCoursTag, withoutCoursTagNames } from './shared/tag-filter'
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
// 空シェル（中身のない項目）も表示するか（§63・既定 OFF＝非表示・インメモリ）
let showEmptyFilter = false
// 再生時間／投稿年 レンジは URL 状態（state.dur / state.year）で保持する（§78）。
// ＝ページ移動（フルリロード）でも復元される。インメモリの保持変数は持たない。

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

// レンジ絞り込みの URL 表現（§78）。停止点インデックス範囲を value ベースの "lo-hi" に
// 直す（開放端＝先頭/末尾は省略）。データの停止点数が変わっても頑健。全域なら ''（＝絞り込みなし）。
function serializeRange(lo: number, hi: number, stops: RangeStop[]): string {
  const last = stops.length - 1
  if (lo <= 0 && hi >= last) return ''
  const loStr = lo <= 0 ? '' : String(stops[lo].value)
  const hiStr = hi >= last ? '' : String(stops[hi].value)
  return `${loStr}-${hiStr}`
}
// URL の "lo-hi" を停止点インデックス範囲に戻す。該当 value の停止点を探し、無ければ開放端。
// 全域/空なら null（絞り込み非適用）。値は非負（年・分）なので indexOf('-') で安全に分割できる。
function parseRange(raw: string, stops: RangeStop[]): [number, number] | null {
  if (!raw) return null
  const dash = raw.indexOf('-')
  if (dash < 0) return null
  const last = stops.length - 1
  const idxOf = (s: string, fallback: number): number => {
    if (s === '') return fallback
    const i = stops.findIndex((st) => st.value === Number(s))
    return i >= 0 ? i : fallback
  }
  const lo = idxOf(raw.slice(0, dash), 0)
  const hi = idxOf(raw.slice(dash + 1), last)
  return lo <= 0 && hi >= last ? null : [lo, hi]
}

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
    // クール由来タグ（「2026年春アニメ」等）はタグ UI から除外（§68）。クール絞り込みで扱う。
    if (tags) {
      tags.tags = tags.tags.filter((t) => !isCoursTag(t.name))
      tags.topHotTags = withoutCoursTagNames(tags.topHotTags)
      tags.topPopularTags = withoutCoursTagNames(tags.topPopularTags)
    }
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
  // 空シェル（話数0・firstAt/latestAt 無し）は Top の新着・更新列に出さない（§59 と整合）。
  const valid = worksArr.filter((w) => (w.episodeCount ?? 0) > 0)
  // 時刻キー（ISO→ms・無効は -Infinity）。新規＝firstAt（初話）・最近更新＝latestAt（最新話）。
  const ms = (v: string | null | undefined): number => {
    const t = v ? Date.parse(v) : NaN
    return Number.isNaN(t) ? -Infinity : t
  }
  const byFirst = [...valid].sort(
    (a, b) => ms(b.firstAt ?? b.latestAt) - ms(a.firstAt ?? a.latestAt) || b.seriesId - a.seriesId
  )
  const byLatest = [...valid].sort(
    (a, b) => ms(b.latestAt ?? b.firstAt) - ms(a.latestAt ?? a.firstAt) || b.seriesId - a.seriesId
  )
  return {
    popular: cache.ranking?.popular ?? [],
    hotTags: cache.tags?.topHotTags ?? [],
    popularTags: cache.tags?.topPopularTags ?? [],
    allTags: cache.tags?.tags ?? [],
    cours: cache.cours?.cours ?? [],
    newSeries: byFirst.slice(0, 12), // 新規＝firstAt 降順（§73）
    updatedSeries: byLatest.slice(0, 12), // 最近更新＝latestAt 降順（§73）
    episodeCounts,
  }
}

/** 「見た」ボタンの状態を反映（circle-check・on=塗り/off=アウトラインは CSS の .active で・§45）。 */
function setWatchedState(btn: HTMLElement, on: boolean, size = 16): void {
  btn.classList.toggle('active', on)
  btn.replaceChildren(icon('circle-check', size))
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
    // 詳細の「見た」ボタンはアイコン（circle-check）＋テキスト。アイコンのみ差し替える
    // （on=塗り/off=アウトラインは CSS .btn-watched.active が担当＝§45/§58）。
    const setDetailWatched = (on: boolean) => {
      watchedBtn.classList.toggle('active', on)
      const svg = watchedBtn.querySelector('svg')
      const next = icon('circle-check', 16)
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
      // 「取得できていないシリーズも表示」トグル（§67・空シェル表示）
      showEmpty: showEmptyFilter,
      onToggleEmpty: (on) => {
        showEmptyFilter = on
        void render()
      },
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
    // クイックアクセス「お気に入り」からの遷移（?fav=1）でお気に入りフィルタを有効化（§50）。
    // 以後はメモリ状態（チェックボックス/×）が引き継ぐ。
    if (params.get('fav') === '1') favFilter = true

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
    let filtered = filterWorks(allWorks, screen.state, {
      favIds,
      watchedIds,
      includeEmpty: showEmptyFilter,
    })

    // 投稿年の停止点。両端に「下限なし／上限なし」（§80・再生時間と同作法）。
    // 中央はデータの最小〜最大年、10 年ごとに目盛り。
    const years = allWorks.map(workYear).filter((y): y is number => y != null)
    const minYear = years.length > 0 ? Math.min(...years) : 2000
    const maxYear = years.length > 0 ? Math.max(...years) : new Date().getFullYear()
    const YEAR_STOPS: RangeStop[] = [{ value: -Infinity, label: '下限なし', tick: 'なし' }]
    for (let y = minYear; y <= maxYear; y++) {
      YEAR_STOPS.push({
        value: y,
        label: `${y}`,
        tick: y === minYear || y === maxYear || y % 10 === 0 ? `${y}` : undefined,
      })
    }
    YEAR_STOPS.push({ value: Infinity, label: '上限なし', tick: '∞' })
    const durLast = DURATION_STOPS.length - 1
    const yearLast = YEAR_STOPS.length - 1

    // レンジ絞り込みは URL 状態（state.dur / state.year）から復元（§78）。停止点 value で表現。
    const durIdx = parseRange(screen.state.dur, DURATION_STOPS)
    const yearIdx = parseRange(screen.state.year, YEAR_STOPS)

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
    // 投稿年レンジ（停止点 value→年。-Infinity=下限なし／Infinity=上限なし＝§80）
    if (yearIdx) {
      const loY = YEAR_STOPS[yearIdx[0]].value
      const hiY = YEAR_STOPS[yearIdx[1]].value
      filtered = filtered.filter((w) => {
        const y = workYear(w)
        return y != null && y >= loY && y <= hiY
      })
    }

    const sorted = sortWorks(filtered, screen.state.sort, cache.ranking ?? null, screen.state.dir)
    const { items, totalCount, totalPages } = paginateWorks(
      sorted,
      screen.state.page,
      screen.state.size
    )

    // カード下キャプション＝選択中の並び替えに応じた指標（§5）
    const viewMap = new Map((cache.ranking?.popular ?? []).map((r) => [r.seriesId, r.totalViews]))
    // 炎ティア（§64）: 全作品横断の percentile 閾値で hotScore をティア化。生スコア数値は出さない。
    const hotTiers = cache.ranking?.hotTiers
    const flameTier = (score: number): number => {
      if (!hotTiers || score <= 0) return 0
      if (score >= hotTiers.t3) return 3 // 上位1%
      if (score >= hotTiers.t2) return 2 // 上位5%
      if (score >= hotTiers.t1) return 1 // 上位10%
      return 0
    }
    const TIER_LABEL = [
      '',
      '勢いあり（上位10%）',
      '勢い強い（上位5%）',
      '今いちばん勢いがある（上位1%）',
    ]
    const cardMetric = (w: Work): MetaSpec | null => {
      if (screen.state.sort === 'hot') {
        const n = flameTier(w.hotScore ?? 0)
        if (n === 0) return null
        return {
          icon: 'flame',
          value: '',
          label: TIER_LABEL[n],
          flames: n,
          tooltip: '勢い＝直近の伸び（再生の勢いとの目安・正確な期間集計ではありません）',
        }
      }
      if (screen.state.sort === 'views') {
        // 累計再生数は works.json の totalViews（全作品・§79）を優先。旧 JSON 互換で
        // 欠落時のみ ranking.popular（上位 200）にフォールバック。
        const v = w.totalViews ?? viewMap.get(w.seriesId)
        if (v == null || v <= 0) return null
        return { icon: 'play', value: formatViews(v), label: `累計再生数 ${formatViews(v)}` }
      }
      if (screen.state.sort === 'new') {
        // 最近更新＝最新話の投稿時刻
        const rel = w.latestAt ? formatRelativeTime(w.latestAt) : ''
        return rel ? { icon: 'clock', value: rel, label: `最新話 ${rel}` } : null
      }
      if (screen.state.sort === 'created') {
        // 新規＝最古話（初話）の投稿時刻＝ソート基準(firstAt)と表示日付を一致
        const rel = w.firstAt ? formatRelativeTime(w.firstAt) : ''
        return rel ? { icon: 'clock', value: rel, label: `初話 ${rel}` } : null
      }
      if (screen.state.sort === 'comments') {
        const c = w.commentTotal
        if (c == null || c <= 0) return null
        return { icon: 'message', value: formatViews(c), label: `総コメント ${formatViews(c)}` }
      }
      // kana（五十音）は数値指標を持たないので常時メタのみ
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
      showEmptyFilter,
      cardMetric,
      onClearFav: () => {
        favFilter = false
        void render()
      },
      onClearUnwatched: () => {
        unwatchedFilter = false
        void render()
      },
      onClearShowEmpty: () => {
        showEmptyFilter = false
        void render()
      },
      onSearch: (next) => navigate(buildListUrl(next)),
      sliders: {
        duration: {
          name: '再生時間',
          stops: DURATION_STOPS,
          lowerIdx: durIdx?.[0] ?? 0,
          upperIdx: durIdx?.[1] ?? durLast,
          onChange: (lo, hi) => {
            // URL 状態を更新（§78）。ページ移動でも保持される。1 ページ目に戻す。
            navigate(
              buildListUrl({
                ...screen.state,
                dur: serializeRange(lo, hi, DURATION_STOPS),
                page: 1,
              })
            )
          },
        },
        year: {
          name: '投稿年',
          stops: YEAR_STOPS,
          lowerIdx: yearIdx?.[0] ?? 0,
          upperIdx: yearIdx?.[1] ?? yearLast,
          onChange: (lo, hi) => {
            navigate(
              buildListUrl({ ...screen.state, year: serializeRange(lo, hi, YEAR_STOPS), page: 1 })
            )
          },
        },
      },
    })

    // タグ・トークン検索（§35）は renderList 内で onSearch 経由で navigate 済み。
    const sortRadios = app.querySelectorAll<HTMLInputElement>('input[name="sort"]')
    sortRadios.forEach((radio) => {
      radio.addEventListener('change', () => {
        if (radio.checked)
          navigate(buildListUrl({ ...screen.state, sort: radio.value as SortKey, page: 1 }))
      })
    })

    // 並び替え方向トグル（§41）。現在キーに対し dir を反転、1 ページ目から。
    const dirToggle = app.querySelector<HTMLElement>('[data-part="sort-dir"]')
    dirToggle?.addEventListener('click', () => {
      const nextDir = screen.state.dir === 'asc' ? 'desc' : 'asc'
      navigate(buildListUrl({ ...screen.state, dir: nextDir, page: 1 }))
    })

    // 表示件数セレクタ（§42）。件数変更で 1 ページ目から再描画。
    const sizeSelect = app.querySelector<HTMLSelectElement>('[data-part="size"]')
    sizeSelect?.addEventListener('change', () => {
      navigate(buildListUrl({ ...screen.state, size: Number(sizeSelect.value), page: 1 }))
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
    // 「取得できていないシリーズも表示」(§67) は設定(⚙)モーダルへ移動（下記 initSettingsModal）。

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

  // 省略されたピル（タグ/クール/検索トークン）に全文ツールチップを付ける（§46/§49）
  wireTruncationTooltips(app)

  focusMainIfNavigation()
}

// テーマを最初に適用（FOUC を防ぐ）
initTheme()
// カスタムツールチップのグローバル配線（§46・1 回だけ）
initTooltips()

window.addEventListener('popstate', () => {
  isNavigation = true
  void render()
})
void render()
