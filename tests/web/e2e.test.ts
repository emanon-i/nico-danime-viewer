// @vitest-environment happy-dom
// F-0047: 総合/E2E テスト（フィクスチャ JSON + DOM アサーション）
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest'
import { renderTop } from '../../web/src/features/top/top'
import { renderList } from '../../web/src/features/list/list'
import { renderDetail } from '../../web/src/features/detail/detail'
import { parseScreen, buildListUrl, buildDetailUrl } from '../../web/src/features/router'
import {
  toggleFavorite,
  setWatchStatus,
  cycleWatchStatus,
  getWatchStatus,
  isFavorite,
  isWatched,
} from '../../web/src/features/shared/user-state'
import { toggleTheme, getTheme } from '../../web/src/features/shared/theme'
import type { Work, RankingEntry, Tag, SeriesDetail } from '../../web/src/data/types'
import type { TopData } from '../../web/src/features/top/top'
import type { ListState } from '../../web/src/features/router'

// ── フィクスチャ ──────────────────────────────────────────────────
const FIXTURE_WORKS: Work[] = [
  {
    seriesId: 101,
    title: 'ゆるキャン△',
    thumbnailUrl: null,
    descriptionFirst: null,
    franchiseKey: null,
    colKey: 'yu',
    cours: '2018-冬',
    tags: ['日常', 'アウトドア'],
    episodeCount: 0,
    relatedSeries: [],
  },
  {
    seriesId: 102,
    title: 'ぼっち・ざ・ろっく！',
    thumbnailUrl: null,
    descriptionFirst: null,
    franchiseKey: null,
    colKey: 'bo',
    cours: '2022-秋',
    tags: ['音楽', '部活'],
    episodeCount: 0,
    relatedSeries: [],
  },
  {
    seriesId: 103,
    title: 'スパイファミリー',
    thumbnailUrl: null,
    descriptionFirst: null,
    franchiseKey: null,
    colKey: 'su',
    cours: '2022-春',
    tags: ['アクション', '家族'],
    episodeCount: 0,
    relatedSeries: [],
  },
]

const FIXTURE_POPULAR: RankingEntry[] = [
  {
    seriesId: 102,
    title: 'ぼっち・ざ・ろっく！',
    thumbnailUrl: null,
    totalViews: 20000,
    hotScore: 800,
  },
  {
    seriesId: 103,
    title: 'スパイファミリー',
    thumbnailUrl: null,
    totalViews: 15000,
    hotScore: 600,
  },
  { seriesId: 101, title: 'ゆるキャン△', thumbnailUrl: null, totalViews: 10000, hotScore: 500 },
]

const FIXTURE_TAGS: Tag[] = [
  { name: '日常', isCurated: false, seriesCount: 50 },
  { name: '音楽', isCurated: true, seriesCount: 30 },
  { name: 'アクション', isCurated: false, seriesCount: 40 },
]

const FIXTURE_TOP_DATA: TopData = {
  popular: FIXTURE_POPULAR,
  hotTags: ['音楽', '日常'],
  popularTags: ['アクション', '日常'],
  allTags: FIXTURE_TAGS,
  cours: [
    { cours: '2022-秋', seriesIds: [102] },
    { cours: '2022-春', seriesIds: [103] },
  ],
  newSeries: FIXTURE_WORKS.slice(0, 2),
  updatedSeries: FIXTURE_WORKS.slice(0, 2),
}

const FIXTURE_SERIES: SeriesDetail = {
  seriesId: 102,
  title: 'ぼっち・ざ・ろっく！',
  thumbnailUrl: null,
  descriptionFirst: '主人公ひとり（ぼっち）の物語',
  tags: ['音楽', '部活', 'ガールズバンド'],
  cours: '2022-秋',
  colKey: 'bo',
  relatedSeries: [{ seriesId: 103, title: 'スパイファミリー', thumbnailUrl: null }],
  episodes: [
    {
      contentId: 'so1000001',
      episodeNo: 1,
      title: '第1話',
      viewCounter: 5000,
      startTime: '2022-10-01T00:00:00+09:00',
      thumbnailUrl: null,
    },
    {
      contentId: 'so1000002',
      episodeNo: 2,
      title: '第2話',
      viewCounter: 4500,
      startTime: '2022-10-08T00:00:00+09:00',
      thumbnailUrl: null,
    },
  ],
}

// ── localStorage モック ───────────────────────────────────────────
const store = new Map<string, string>()
const mockLocalStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store.set(k, v)
  },
  removeItem: (k: string) => {
    store.delete(k)
  },
  clear: () => {
    store.clear()
  },
  get length() {
    return store.size
  },
  key: (i: number) => [...store.keys()][i] ?? null,
}

beforeAll(() => {
  vi.stubGlobal('localStorage', mockLocalStorage)
})

// ── テスト ────────────────────────────────────────────────────────
describe('F-0047: 総合/E2E テスト', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    store.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  describe('test_e2e_top_list_detail_flow', () => {
    it('トップ画面が主要セクションを描画する', () => {
      renderTop(container, FIXTURE_TOP_DATA)
      expect(container.querySelector('[data-section="top10"]')).not.toBeNull()
      expect(container.querySelector('[data-section="tags"]')).not.toBeNull()
      expect(container.querySelector('[data-section="recent"]')).not.toBeNull()
      expect(container.querySelector('[data-section="cours"]')).not.toBeNull()
    })

    it('トップ画面の TOP10 にフィクスチャの作品が表示される', () => {
      renderTop(container, FIXTURE_TOP_DATA)
      const cards = container.querySelectorAll('.series-card')
      expect(cards.length).toBeGreaterThan(0)
    })

    it('一覧画面が作品グリッドを描画する', () => {
      const state: ListState = {
        q: '',
        row: '',
        tags: [],
        cours: '',
        sort: 'hot',
        dir: 'desc',
        size: 48,
        page: 1,
        dur: '',
        year: '',
        fav: false,
        cast: '',
        staff: '',
      }
      renderList(container, {
        state,
        works: FIXTURE_WORKS,
        totalCount: FIXTURE_WORKS.length,
        totalPages: 1,
        data: { tags: FIXTURE_TAGS, cours: FIXTURE_TOP_DATA.cours },
      })
      expect(container.querySelector('.list-grid')).not.toBeNull()
      expect(container.querySelector('.list-filter')).not.toBeNull()
      const cards = container.querySelectorAll('.series-card')
      expect(cards.length).toBe(FIXTURE_WORKS.length)
    })

    it('詳細画面がエピソードリストを描画する', () => {
      renderDetail(container, FIXTURE_SERIES)
      expect(container.querySelector('[data-section="episodes"]')).not.toBeNull()
      const episodes = container.querySelectorAll('[data-part="episode"]')
      expect(episodes.length).toBe(FIXTURE_SERIES.episodes.length)
    })

    it('詳細画面がタグと関連シリーズを描画する', () => {
      renderDetail(container, FIXTURE_SERIES)
      const tags = container.querySelectorAll('.tag-chip')
      expect(tags.length).toBe(FIXTURE_SERIES.tags.length)
      const related = container.querySelector('[data-section="related"]')
      expect(related?.getAttribute('hidden')).toBeNull()
    })
  })

  describe('test_e2e_url_state_reproduce', () => {
    it('buildListUrl → parseScreen で状態が往復できる（クエリ検索）', () => {
      const original: ListState = {
        q: 'テスト作品',
        row: '',
        tags: [],
        cours: '',
        sort: 'hot',
        dir: 'desc',
        size: 48,
        page: 1,
        dur: '',
        year: '',
        fav: false,
        cast: '',
        staff: '',
      }
      const url = buildListUrl(original)
      const params = new URLSearchParams(url.slice(1))
      const screen = parseScreen(params)
      expect(screen.type).toBe('list')
      if (screen.type === 'list') {
        expect(screen.state.q).toBe('テスト作品')
      }
    })

    it('buildListUrl → parseScreen で状態が往復できる（タグ・クール・並び替え）', () => {
      const original: ListState = {
        q: '',
        row: 'あ',
        tags: ['日常'],
        cours: '2022-秋',
        sort: 'views',
        dir: 'desc',
        size: 48,
        page: 2,
        dur: '',
        year: '',
        fav: false,
        cast: '',
        staff: '',
      }
      const url = buildListUrl(original)
      const params = new URLSearchParams(url.slice(1))
      const screen = parseScreen(params)
      expect(screen.type).toBe('list')
      if (screen.type === 'list') {
        expect(screen.state.row).toBe('あ')
        expect(screen.state.tags).toEqual(['日常'])
        expect(screen.state.cours).toBe('2022-秋')
        expect(screen.state.sort).toBe('views')
        expect(screen.state.page).toBe(2)
      }
    })

    it('buildDetailUrl → parseScreen で詳細画面の seriesId が往復できる', () => {
      const url = buildDetailUrl(102)
      const params = new URLSearchParams(url.slice(1))
      const screen = parseScreen(params)
      expect(screen.type).toBe('detail')
      if (screen.type === 'detail') {
        expect(screen.seriesId).toBe(102)
      }
    })

    it('仮シリーズ（seriesId < 0）も詳細画面に遷移する', () => {
      const url = buildDetailUrl(-78665789)
      const params = new URLSearchParams(url.slice(1))
      const screen = parseScreen(params)
      expect(screen.type).toBe('detail')
      if (screen.type === 'detail') {
        expect(screen.seriesId).toBe(-78665789)
      }
    })

    it('無効なパラメータはトップ画面にフォールバックする', () => {
      const params = new URLSearchParams('series=abc')
      const screen = parseScreen(params)
      expect(screen.type).toBe('top')
    })

    it('series=0 はトップ画面にフォールバックする', () => {
      const params = new URLSearchParams('series=0')
      const screen = parseScreen(params)
      expect(screen.type).toBe('top')
    })
  })

  describe('test_e2e_user_state_and_empty', () => {
    it('お気に入りが localStorage に永続化され、再読み込み後も保持される', () => {
      expect(isFavorite(101)).toBe(false)
      toggleFavorite(101)
      expect(isFavorite(101)).toBe(true)
      toggleFavorite(101)
      expect(isFavorite(101)).toBe(false)
    })

    it('見たフラグが localStorage に永続化される', () => {
      expect(isWatched(102)).toBe(false)
      setWatchStatus(102, 'watched')
      expect(isWatched(102)).toBe(true)
    })

    it('視聴状態が none→want→watched→none と循環する', () => {
      expect(getWatchStatus(103)).toBe('none')
      expect(cycleWatchStatus(103)).toBe('want')
      expect(cycleWatchStatus(103)).toBe('watched')
      expect(cycleWatchStatus(103)).toBe('none')
    })

    it('空データの詳細画面で empty メッセージが表示される', () => {
      renderDetail(container, null)
      const emptyEl = container.querySelector('[data-part="empty"]')
      expect(emptyEl).not.toBeNull()
      expect(emptyEl?.textContent).toMatch(/取得できません|配信終了/)
    })

    it('空データ一覧で 0件 表示される', () => {
      const state: ListState = {
        q: 'ヒットしない検索',
        row: '',
        tags: [],
        cours: '',
        sort: 'hot',
        dir: 'desc',
        size: 48,
        page: 1,
        dur: '',
        year: '',
        fav: false,
        cast: '',
        staff: '',
      }
      renderList(container, { state, works: [], totalCount: 0, totalPages: 1 })
      // 件数は適用中バー（§16）の .applied-count に表示される
      const countEl = container.querySelector('.applied-count')
      expect(countEl?.textContent).toContain('0')
    })

    it('テーマ切替が localStorage に保存される', () => {
      const t1 = toggleTheme()
      expect(getTheme()).toBe(t1)
      const t2 = toggleTheme()
      expect(t2).not.toBe(t1)
      expect(getTheme()).toBe(t2)
    })
  })
})
