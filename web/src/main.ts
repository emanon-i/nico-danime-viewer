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
import {
  filterWorks,
  sortWorks,
  paginateWorks,
  avgViewsOf,
  avgCommentsOf,
} from './features/list/filter'
import {
  isFavorite,
  toggleFavorite,
  getWatchStatus,
  cycleWatchStatus,
  getFavoriteIds,
  getWatchedIds,
  getWantIds,
} from './features/shared/user-state'
import type { WatchStatus } from './features/shared/user-state'
import type { IconName } from './components/icon'
import { initTheme, toggleTheme, getTheme } from './features/shared/theme'
import { icon } from './components/icon'
import { initTooltips, wireTruncationTooltips } from './components/tooltip'
import { isHiddenTag, withoutHiddenTagNames } from './shared/tag-filter'
import { formatViews, formatRelativeTime } from './components/meta'
import type { MetaSpec } from './components/meta'
import { initSettingsModal } from './features/shared/settings-modal'
import { renderFooter } from './features/shared/footer'
import { initVersionCheck } from './features/shared/version-check'
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

// お気に入り/見たい/見たフィルタの状態（インメモリ・URLに出さない）
let favFilter = false
let wantFilter = false
let watchedFilter = false
// 空シェル（中身のない項目）も表示するか（§63・既定 OFF＝非表示・インメモリ）
let showEmptyFilter = false
// 取得不可の作品も表示するか（§PH-0013・既定 OFF＝非表示・localStorage 永続）
const SHOW_UNAVAILABLE_KEY = 'nico-danime-show-unavailable'
let showUnavailableFilter = localStorage.getItem(SHOW_UNAVAILABLE_KEY) === 'true'
// モバイルのフィルタ/並びドロワーの開閉状態（§91・インメモリ）。SPA 再描画をまたいで保持し、
// タグ/クールを選んでもドロワーが閉じず連続選択できるようにする。
let filterPanelOpen = false
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
    // UI 非表示タグを除外（§68 クール由来＋§C 構造的定番＝最終回/神回/総集編/各話番号）。
    // クール絞り込みは別 UI、構造タグはノイズ。データ（works.tags/tags.json）は保持。
    if (tags) {
      tags.tags = tags.tags.filter((t) => !isHiddenTag(t.name))
      tags.topHotTags = withoutHiddenTagNames(tags.topHotTags)
      tags.topPopularTags = withoutHiddenTagNames(tags.topPopularTags)
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
  const valid = worksArr.filter((w) => (w.episodeCount ?? 0) > 0 && w.isAvailable !== false)
  // 時刻キー（ISO→ms・無効は -Infinity）。新規＝firstAt（初話）・最近更新＝latestAt（最新話）。
  const ms = (v: string | null | undefined): number => {
    const t = v ? Date.parse(v) : NaN
    return Number.isNaN(t) ? -Infinity : t
  }
  const soNum = (cid: string | null | undefined): number => {
    const m = (cid ?? '').match(/(\d+)$/)
    return m ? parseInt(m[1], 10) : -1
  }
  const byFirst = [...valid].sort(
    (a, b) =>
      ms(b.firstAt ?? b.latestAt) - ms(a.firstAt ?? a.latestAt) ||
      soNum(b.firstContentId) - soNum(a.firstContentId) ||
      b.seriesId - a.seriesId
  )
  const byLatest = [...valid].sort(
    (a, b) =>
      ms(b.latestAt ?? b.firstAt) - ms(a.latestAt ?? a.firstAt) ||
      soNum(b.latestContentId) - soNum(a.latestContentId) ||
      b.seriesId - a.seriesId
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

// 三値トグルの見た目定義（§F-0034 拡張）。未視聴＝薄いブックマーク（非活性風）／
// 見たい＝ブックマーク（アンバー塗り）／見た＝丸チェック（緑塗り）。色塗りは CSS の
// .is-want / .is-watched が担当。アイコンとラベルだけ JS で差し替える。
const WATCH_ICON: Record<WatchStatus, IconName> = {
  none: 'bookmark',
  want: 'bookmark',
  watched: 'circle-check',
}
const WATCH_LABEL: Record<WatchStatus, string> = {
  none: '未視聴（クリックで「見たい」）',
  want: '見たい（クリックで「見た」）',
  watched: '見た（クリックで未視聴に戻す）',
}
const WATCH_TEXT: Record<WatchStatus, string> = {
  none: '未視聴',
  want: '見たい',
  watched: '見た',
}

/** 視聴状態（三値）をボタンに反映する。アイコン差し替え＋状態クラス＋aria-label を更新。
 * context（作品タイトル）を渡すと aria-label に前置し、同一アイコンの並びでも SR で区別できる。 */
function applyWatchState(
  btn: HTMLElement,
  status: WatchStatus,
  opts: { size?: number; withText?: boolean; context?: string } = {}
): void {
  const { size = 16, withText = false, context } = opts
  btn.classList.toggle('is-want', status === 'want')
  btn.classList.toggle('is-watched', status === 'watched')
  btn.setAttribute(
    'aria-label',
    context ? `${context}: ${WATCH_LABEL[status]}` : WATCH_LABEL[status]
  )
  const children: (Node | string)[] = [icon(WATCH_ICON[status], size)]
  if (withText) children.push(WATCH_TEXT[status])
  btn.replaceChildren(...children)
}

/** カードの ♥/視聴状態 ボタンを localStorage と同期させる */
function wireCards(container: HTMLElement): void {
  // localStorage の集合は描画ごとに 1 度だけ読む（カード数 ×2配列 の再パースを避ける）。
  const favSet = new Set(getFavoriteIds())
  const wantSet = new Set(getWantIds())
  const watchedSet = new Set(getWatchedIds())
  const statusOf = (id: number): WatchStatus =>
    watchedSet.has(id) ? 'watched' : wantSet.has(id) ? 'want' : 'none'

  container.querySelectorAll<HTMLElement>('.series-card').forEach((card) => {
    const seriesId = Number(card.dataset.seriesId)
    if (!seriesId) return
    // 同一アイコンボタンの並びを SR で区別できるよう作品名を aria に添える（§17 a11y）。
    const title = card.querySelector('.card-title')?.textContent?.trim() || undefined

    const favBtn = card.querySelector<HTMLButtonElement>('.card-favorite')
    const watchedBtn = card.querySelector<HTMLButtonElement>('.card-watched')

    if (favBtn) {
      if (title) favBtn.setAttribute('aria-label', `${title}: お気に入り`)
      if (favSet.has(seriesId)) favBtn.classList.add('active')
      favBtn.addEventListener('click', () => {
        const nowFav = toggleFavorite(seriesId)
        favBtn.classList.toggle('active', nowFav)
      })
    }
    if (watchedBtn) {
      applyWatchState(watchedBtn, statusOf(seriesId), { context: title })
      watchedBtn.addEventListener('click', () => {
        applyWatchState(watchedBtn, cycleWatchStatus(seriesId), { context: title })
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
    // 詳細の視聴状態ボタンはアイコン＋テキスト（未視聴/見たい/見た）。三値で循環する。
    // 色塗りは CSS .btn-watched.is-want / .is-watched が担当（§45/§58 を拡張）。
    applyWatchState(watchedBtn, getWatchStatus(seriesId), { withText: true })
    watchedBtn.addEventListener('click', () => {
      applyWatchState(watchedBtn, cycleWatchStatus(seriesId), { withText: true })
    })
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
      // 「取得不可の作品を表示」トグル（§PH-0013）
      showUnavailable: showUnavailableFilter,
      onToggleUnavailable: (on) => {
        showUnavailableFilter = on
        localStorage.setItem(SHOW_UNAVAILABLE_KEY, on ? 'true' : 'false')
        void render()
      },
    })
  }
}

/** SPA 遷移後、主要コンテンツ（#main-content）へフォーカスを移す（§17.1） */
function focusMainIfNavigation(): void {
  if (!isNavigation) return
  isNavigation = false
  // モバイルでフィルタ・ドロワーを開いたまま連続選択している間は、焦点をドロワーから
  // 奪わない（§91）。焦点移動で main へスクロールするとドロワー操作が中断するため。
  if (filterPanelOpen) return
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
    const wantIds = wantFilter ? new Set(getWantIds()) : undefined
    const watchedIds = watchedFilter ? new Set(getWatchedIds()) : undefined
    let filtered = filterWorks(allWorks, screen.state, {
      favIds,
      wantIds,
      watchedIds,
      includeEmpty: showEmptyFilter,
      showUnavailable: showUnavailableFilter,
    })

    // 投稿年の停止点。両端に「下限なし／上限なし」（§80・再生時間と同作法）。
    // 中央の目盛りは「5 年刻み」だが、両端の開放端ラベル（なし/∞）と横方向で重ならないよう
    // **端に隣接する年（minYear/maxYear の直近）には目盛りを出さない**（§88 横方向衝突の解消）。
    // 正確な下限〜上限は readout（「2015 〜 2020」等）に出るので中間目盛りは間引いて可。
    const years = allWorks.map(workYear).filter((y): y is number => y != null)
    const minYear = years.length > 0 ? Math.min(...years) : 2000
    const maxYear = years.length > 0 ? Math.max(...years) : new Date().getFullYear()
    const YEAR_STOPS: RangeStop[] = [{ value: -Infinity, label: '下限なし', tick: 'なし' }]
    for (let y = minYear; y <= maxYear; y++) {
      // 端から 1 年以内（なし/∞ に隣接）は目盛りラベルを出さない＝衝突回避
      const interior = y > minYear + 1 && y < maxYear - 1
      YEAR_STOPS.push({
        value: y,
        label: `${y}`,
        tick: interior && y % 5 === 0 ? `${y}` : undefined,
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
      // views（総再生）・new（最近更新＝投稿日）は §93 の常時メタ 3 点に含まれるため、
      // 連動メタとしては二重表示しない（null）。
      if (screen.state.sort === 'views') return null
      if (screen.state.sort === 'new') return null
      if (screen.state.sort === 'created') {
        // 新規＝最古話（初話）の投稿時刻＝ソート基準(firstAt)と表示日付を一致
        const rel = w.firstAt ? formatRelativeTime(w.firstAt) : ''
        return rel ? { icon: 'calendar-plus', value: rel, label: `初話 ${rel}` } : null
      }
      if (screen.state.sort === 'comments') {
        const c = w.commentTotal
        if (c == null || c <= 0) return null
        return { icon: 'message', value: formatViews(c), label: `総コメント ${formatViews(c)}` }
      }
      if (screen.state.sort === 'avgViews') {
        // 平均再生数＝累計再生数÷話数（§86・§81 と同算出）。
        const a = Math.round(avgViewsOf(w))
        if (a <= 0) return null
        return {
          icon: 'play',
          value: `平均 ${formatViews(a)}/話`,
          label: `平均再生数 ${formatViews(a)}`,
        }
      }
      if (screen.state.sort === 'avgComments') {
        const a = Math.round(avgCommentsOf(w))
        if (a <= 0) return null
        return {
          icon: 'message',
          value: `平均 ${formatViews(a)}/話`,
          label: `平均コメント数 ${formatViews(a)}`,
        }
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
      wantFilter,
      watchedFilter,
      showEmptyFilter,
      cardMetric,
      onClearFav: () => {
        favFilter = false
        void render()
      },
      onClearWant: () => {
        wantFilter = false
        void render()
      },
      onClearWatched: () => {
        watchedFilter = false
        void render()
      },
      onClearShowEmpty: () => {
        showEmptyFilter = false
        void render()
      },
      onSearch: (next) => navigate(buildListUrl(next)),
      // §91: サイドバーのタグ/クール選択を SPA 遷移（全リロードせず再描画＝モバイルのドロワー
      // を開いたまま連続選択でき、12MB の works.json 再取得も避けられる）。
      onNavigate: (next) => navigate(buildListUrl(next)),
      filterOpen: filterPanelOpen,
      onToggleFilter: (open) => {
        filterPanelOpen = open
      },
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
          // 投稿年は startTime 由来＝支店に投稿された年（元の放送年ではない・§89）
          info: 'dアニメストア ニコニコ支店に動画が投稿された年です（元の放送年とは異なる場合があります）',
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
    const wantCb = app.querySelector<HTMLInputElement>('input[name="want"]')
    const watchedCb = app.querySelector<HTMLInputElement>('input[name="watched"]')
    if (favCb) {
      favCb.checked = favFilter
      favCb.addEventListener('change', () => {
        favFilter = favCb.checked
        void render()
      })
    }
    if (wantCb) {
      wantCb.checked = wantFilter
      wantCb.addEventListener('change', () => {
        wantFilter = wantCb.checked
        void render()
      })
    }
    if (watchedCb) {
      watchedCb.checked = watchedFilter
      watchedCb.addEventListener('change', () => {
        watchedFilter = watchedCb.checked
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
// 新バージョン検知＋更新バナー（§92・スマホでもハードリフレッシュ不要に）
initVersionCheck()

window.addEventListener('popstate', () => {
  isNavigation = true
  void render()
})
void render()
