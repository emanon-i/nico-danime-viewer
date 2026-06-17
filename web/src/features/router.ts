export type SortKey = 'hot' | 'views' | 'new' | 'kana' | 'comments'

export interface ListState {
  q: string
  row: string
  tag: string
  cours: string
  sort: SortKey
  page: number
}

export type Screen =
  | { type: 'top' }
  | { type: 'list'; state: ListState }
  | { type: 'detail'; seriesId: number }

const VALID_SORTS: SortKey[] = ['hot', 'views', 'new', 'kana', 'comments']
const LIST_PARAMS = ['q', 'row', 'tag', 'cours', 'sort', 'page']

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
        tag: params.get('tag') ?? '',
        cours: params.get('cours') ?? '',
        sort,
        page: Math.max(1, parseInt(params.get('page') ?? '1', 10)),
      },
    }
  }

  return { type: 'top' }
}

export function buildListUrl(state: Partial<ListState>): string {
  const p = new URLSearchParams()
  if (state.q) p.set('q', state.q)
  if (state.row) p.set('row', state.row)
  if (state.tag) p.set('tag', state.tag)
  if (state.cours) p.set('cours', state.cours)
  if (state.sort && state.sort !== 'hot') p.set('sort', state.sort)
  if (state.page && state.page > 1) p.set('page', String(state.page))
  const s = p.toString()
  return '?' + (s || 'screen=list')
}

export function buildDetailUrl(seriesId: number): string {
  return `?series=${seriesId}`
}

export function buildTopUrl(): string {
  return '?'
}
