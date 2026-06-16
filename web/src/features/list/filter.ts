import type { Work, RankingJson } from '../../data/types'
import type { ListState } from '../router'

export const PAGE_SIZE = 24

const KANA_ROW_PREFIXES: Record<string, readonly string[]> = {
  あ: ['a', 'i', 'u', 'e', 'o'],
  か: ['ka', 'ki', 'ku', 'ke', 'ko', 'ga', 'gi', 'gu', 'ge', 'go'],
  さ: ['sa', 'shi', 'su', 'se', 'so', 'za', 'ji', 'zu', 'ze', 'zo'],
  た: ['ta', 'chi', 'tsu', 'te', 'to', 'da', 'de', 'do'],
  な: ['na', 'ni', 'nu', 'ne', 'no'],
  は: ['ha', 'hi', 'fu', 'he', 'ho', 'ba', 'bi', 'bu', 'be', 'bo', 'pa', 'pi', 'pu', 'pe', 'po'],
  ま: ['ma', 'mi', 'mu', 'me', 'mo'],
  や: ['ya', 'yu', 'yo'],
  ら: ['ra', 'ri', 'ru', 're', 'ro'],
  わ: ['wa', 'wi', 'we', 'wo', 'n'],
}

const KANA_ROW_ORDER = ['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ']

/** colKey が属する行のインデックスを返す（最初にマッチした行を採用・曖昧性排除） */
function kanaRowIndex(colKey: string | null): number {
  if (!colKey) return Infinity
  const ck = colKey.toLowerCase()
  for (let i = 0; i < KANA_ROW_ORDER.length; i++) {
    const prefixes = KANA_ROW_PREFIXES[KANA_ROW_ORDER[i]]
    if (prefixes?.some((p) => ck.startsWith(p))) return i
  }
  return Infinity
}

/** colKey が指定した行（あ〜わ）に属するか判定する */
export function colKeyMatchesRow(colKey: string | null, row: string): boolean {
  if (!colKey) return false
  const rowIdx = KANA_ROW_ORDER.indexOf(row)
  if (rowIdx < 0) return false
  return kanaRowIndex(colKey) === rowIdx
}

export function currentCoursLabel(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  const season = month <= 3 ? '冬' : month <= 6 ? '春' : month <= 9 ? '夏' : '秋'
  return `${year}-${season}`
}

export interface FilterOpts {
  favIds?: Set<number>
  watchedIds?: Set<number>
}

export function filterWorks(works: Work[], state: ListState, opts?: FilterOpts): Work[] {
  let result = works

  if (state.q) {
    const q = state.q.toLowerCase()
    result = result.filter(
      (w) => w.title.toLowerCase().includes(q) || w.tags.some((t) => t.toLowerCase().includes(q))
    )
  }

  if (state.row) {
    result = result.filter((w) => colKeyMatchesRow(w.colKey, state.row))
  }

  if (state.tag) {
    result = result.filter((w) => w.tags.includes(state.tag))
  }

  if (state.cours) {
    const label = state.cours === 'current' ? currentCoursLabel() : state.cours
    result = result.filter((w) => w.cours === label)
  }

  if (opts?.favIds) {
    result = result.filter((w) => opts.favIds!.has(w.seriesId))
  }

  if (opts?.watchedIds) {
    result = result.filter((w) => !opts.watchedIds!.has(w.seriesId))
  }

  return result
}

export function sortWorks(
  works: Work[],
  sort: ListState['sort'],
  ranking: RankingJson | null
): Work[] {
  if (sort === 'hot' && ranking) {
    const order = new Map(ranking.hot.map((r, i) => [r.seriesId, i]))
    return [...works].sort((a, b) => {
      const ai = order.get(a.seriesId) ?? Infinity
      const bi = order.get(b.seriesId) ?? Infinity
      return ai !== bi ? ai - bi : a.seriesId - b.seriesId
    })
  }
  if (sort === 'views' && ranking) {
    const order = new Map(ranking.popular.map((r, i) => [r.seriesId, i]))
    return [...works].sort((a, b) => {
      const ai = order.get(a.seriesId) ?? Infinity
      const bi = order.get(b.seriesId) ?? Infinity
      return ai !== bi ? ai - bi : a.seriesId - b.seriesId
    })
  }
  if (sort === 'new') {
    return [...works].sort((a, b) => b.seriesId - a.seriesId)
  }
  if (sort === 'kana') {
    return [...works].sort((a, b) => {
      const ai = kanaRowIndex(a.colKey)
      const bi = kanaRowIndex(b.colKey)
      if (ai !== bi) return ai - bi
      return a.title.localeCompare(b.title, 'ja')
    })
  }
  return [...works].sort((a, b) => a.seriesId - b.seriesId)
}

export function paginateWorks(
  works: Work[],
  page: number
): { items: Work[]; totalCount: number; totalPages: number } {
  const totalCount = works.length
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const safePage = Math.max(1, Math.min(page, totalPages))
  const start = (safePage - 1) * PAGE_SIZE
  return { items: works.slice(start, start + PAGE_SIZE), totalCount, totalPages }
}
