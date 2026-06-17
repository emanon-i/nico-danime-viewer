export type SortKey = 'hot' | 'views' | 'new' | 'kana' | 'comments'
export type SortDir = 'asc' | 'desc'

export interface ListState {
  q: string
  row: string
  /** 選択中タグ（複数＝AND）。URL では `tag` をカンマ区切りで保持（§35）。 */
  tags: string[]
  cours: string
  sort: SortKey
  /** 並び替え方向（共通トグル＝§41）。既定は降順（best-first）。 */
  dir: SortDir
  page: number
  /** 1ページ表示件数（選択 UI＝§42）。既定 PAGE_SIZE。0/未指定は既定にフォールバック。 */
  size: number
}

/** 表示件数の選択肢（§42）。既定＝先頭。 */
export const PAGE_SIZE_OPTIONS = [48, 96, 144] as const
export const DEFAULT_PAGE_SIZE = PAGE_SIZE_OPTIONS[0]

export type Screen =
  | { type: 'top' }
  | { type: 'list'; state: ListState }
  | { type: 'detail'; seriesId: number }

const VALID_SORTS: SortKey[] = ['hot', 'views', 'new', 'kana', 'comments']
const LIST_PARAMS = ['q', 'row', 'tag', 'cours', 'sort', 'dir', 'page', 'size']

export function parseScreen(params: URLSearchParams): Screen {
  const seriesParam = params.get('series')
  if (seriesParam !== null && /^\d+$/.test(seriesParam)) {
    const id = parseInt(seriesParam, 10)
    if (id > 0) return { type: 'detail', seriesId: id }
  }

  const hasListParam = LIST_PARAMS.some((k) => params.has(k))
  const explicitList = params.get('screen') === 'list'
  if (hasListParam || explicitList) {
    const sortRaw = params.get('sort')
    const sort: SortKey = VALID_SORTS.includes(sortRaw as SortKey) ? (sortRaw as SortKey) : 'hot'
    return {
      type: 'list',
      state: {
        q: params.get('q') ?? '',
        row: params.get('row') ?? '',
        tags: (params.get('tag') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        cours: params.get('cours') ?? '',
        sort,
        dir: params.get('dir') === 'asc' ? 'asc' : 'desc',
        page: Math.max(1, parseInt(params.get('page') ?? '1', 10)),
        size: normalizeSize(params.get('size')),
      },
    }
  }

  return { type: 'top' }
}

/** size パラメータを選択肢に丸める（不正/既定は DEFAULT_PAGE_SIZE）。 */
function normalizeSize(raw: string | null): number {
  const n = parseInt(raw ?? '', 10)
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE
}

export function buildListUrl(state: Partial<ListState>): string {
  const p = new URLSearchParams()
  if (state.q) p.set('q', state.q)
  if (state.row) p.set('row', state.row)
  if (state.tags && state.tags.length > 0) p.set('tag', state.tags.join(','))
  if (state.cours) p.set('cours', state.cours)
  if (state.sort && state.sort !== 'hot') p.set('sort', state.sort)
  if (state.dir === 'asc') p.set('dir', 'asc')
  if (state.page && state.page > 1) p.set('page', String(state.page))
  if (state.size && state.size !== DEFAULT_PAGE_SIZE) p.set('size', String(state.size))
  const s = p.toString()
  return '?' + (s || 'screen=list')
}

export function buildDetailUrl(seriesId: number): string {
  return `?series=${seriesId}`
}

export function buildTopUrl(): string {
  return '?'
}
