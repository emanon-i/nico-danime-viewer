import type { Work, RankingJson } from '../../data/types'
import type { ListState } from '../router'

// 既定の 1 ページ表示件数（§42・切りのいい 50。選択 UI で 50/100/200）
export const PAGE_SIZE = 50

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

const SEASONS = ['冬', '春', '夏', '秋'] as const

function seasonIndex(month: number): number {
  return month <= 3 ? 0 : month <= 6 ? 1 : month <= 9 ? 2 : 3
}

export function currentCoursLabel(): string {
  const now = new Date()
  return `${now.getFullYear()}-${SEASONS[seasonIndex(now.getMonth() + 1)]}`
}

/** 今期の 1 つ前のクール（冬→前年秋にロールオーバー）＝§50 「前期」。 */
export function previousCoursLabel(): string {
  const now = new Date()
  const year = now.getFullYear()
  const si = seasonIndex(now.getMonth() + 1)
  return si === 0 ? `${year - 1}-${SEASONS[3]}` : `${year}-${SEASONS[si - 1]}`
}

/** クール keyword（current/previous）を実ラベルに解決する。それ以外はそのまま。 */
export function resolveCoursLabel(cours: string): string {
  if (cours === 'current') return currentCoursLabel()
  if (cours === 'previous') return previousCoursLabel()
  return cours
}

export interface FilterOpts {
  favIds?: Set<number>
  watchedIds?: Set<number>
  /** 空シェル（episodeCount 0）も一覧に含めるか（§63・既定 false＝除外）。 */
  includeEmpty?: boolean
}

export function filterWorks(works: Work[], state: ListState, opts?: FilterOpts): Work[] {
  // 実体に解決できない空シェル（話数 0＝サムネ/最新話/初出すべて欠落）は既定で除外（§59）。
  // トグル（§63・includeEmpty）が ON のときは保持したまま表示する（データは消さない）。
  let result = opts?.includeEmpty ? works : works.filter((w) => (w.episodeCount ?? 0) > 0)

  if (state.q) {
    const q = state.q.toLowerCase()
    result = result.filter(
      (w) => w.title.toLowerCase().includes(q) || w.tags.some((t) => t.toLowerCase().includes(q))
    )
  }

  if (state.row) {
    result = result.filter((w) => colKeyMatchesRow(w.colKey, state.row))
  }

  if (state.tags.length > 0) {
    // 複数タグは AND（すべて含むものだけ）＝§35
    result = result.filter((w) => state.tags.every((t) => w.tags.includes(t)))
  }

  if (state.cours) {
    const label = resolveCoursLabel(state.cours)
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
  ranking: RankingJson | null,
  dir: ListState['dir'] = 'desc'
): Work[] {
  const sorted = sortWorksDesc(works, sort, ranking)
  // 既定（desc）＝best-first。asc は共通トグルで全反転（§41）。
  return dir === 'asc' ? sorted.reverse() : sorted
}

function sortWorksDesc(
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
    // 新着＝各シリーズの「最新話の投稿時刻」(latestAt = MAX(episode startTime)) 降順（§54）。
    // カード表示の日付（cardMetric の latestAt）とソート基準を一致させる。
    const t = (w: Work): number => {
      const v = w.latestAt ?? w.firstAt
      const ms = v ? Date.parse(v) : NaN
      return Number.isNaN(ms) ? -Infinity : ms
    }
    return [...works].sort((a, b) => t(b) - t(a) || b.seriesId - a.seriesId)
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
  page: number,
  size: number = PAGE_SIZE
): { items: Work[]; totalCount: number; totalPages: number } {
  const per = size > 0 ? size : PAGE_SIZE
  const totalCount = works.length
  const totalPages = Math.max(1, Math.ceil(totalCount / per))
  const safePage = Math.max(1, Math.min(page, totalPages))
  const start = (safePage - 1) * per
  return { items: works.slice(start, start + per), totalCount, totalPages }
}
