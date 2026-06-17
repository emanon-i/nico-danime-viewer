import type { Work, RankingJson } from '../../data/types'
import type { ListState } from '../router'

export const PAGE_SIZE = 24

// list.json の col_key は読みベースの五十音「行」char（あ/か/さ/た/な/は/ま/や/ら/わ）。
// ローマ字ではなく日本語の行 char がそのまま入る（実データで確認）。
const KANA_ROW_ORDER = ['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ']

/** colKey（＝行 char）が属する行のインデックスを返す。未知/null は Infinity */
function kanaRowIndex(colKey: string | null): number {
  if (!colKey) return Infinity
  const i = KANA_ROW_ORDER.indexOf(colKey.trim())
  return i < 0 ? Infinity : i
}

/** colKey が指定した行（あ〜わ）に属するか判定する（col_key は行 char そのもの） */
export function colKeyMatchesRow(colKey: string | null, row: string): boolean {
  if (!colKey) return false
  if (KANA_ROW_ORDER.indexOf(row) < 0) return false
  return colKey.trim() === row
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
  if (sort === 'comments') {
    return [...works].sort(
      (a, b) => (b.commentTotal ?? 0) - (a.commentTotal ?? 0) || a.seriesId - b.seriesId
    )
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
