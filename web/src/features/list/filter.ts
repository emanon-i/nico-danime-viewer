import type { Work, RankingJson } from '../../data/types'
import type { ListState } from '../router'
import { normalizeTagForMatch } from '../../shared/tag-filter'

// 既定の 1 ページ表示件数（§42・切りのいい 50。選択 UI で 50/100/200）
export const PAGE_SIZE = 50

// list.json の col_key は読みベースの五十音「行」char（あ/か/さ/た/な/は/ま/や/ら/わ）。
// ローマ字ではなく日本語の行 char がそのまま入る（実データで確認）。
const KANA_ROW_ORDER = ['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ']

// 1 話あたり平均（§86・§81 と同一ロジック）。話数 0 は除算ガードで 0。
// avg＝累計 ÷ episodeCount。長尺バイアスを外した「1 話あたり」の人気指標。
export function avgViewsOf(w: Work): number {
  const n = w.episodeCount ?? 0
  return n > 0 ? (w.totalViews ?? 0) / n : 0
}
export function avgCommentsOf(w: Work): number {
  const n = w.episodeCount ?? 0
  return n > 0 ? (w.commentTotal ?? 0) / n : 0
}

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

/** state.cours（カンマ区切り・複数クール＝§90）を配列に分解する。空は []。 */
export function coursList(cours: string): string[] {
  return cours ? cours.split(',').filter(Boolean) : []
}

/** クールの追加/除去トグル（複数選択＝§90）。含まれていれば外し、無ければ足す。 */
export function toggleCours(cours: string, target: string): string {
  const list = coursList(cours)
  const next = list.includes(target) ? list.filter((c) => c !== target) : [...list, target]
  return next.join(',')
}

export interface FilterOpts {
  favIds?: Set<number>
  watchedIds?: Set<number>
  /** 空シェル（episodeCount 0）も一覧に含めるか（§63・既定 false＝除外）。 */
  includeEmpty?: boolean
  /** isAvailable=false（配信終了・取得不可）の作品も表示するか（§PH-0013・既定 false＝非表示）。 */
  showUnavailable?: boolean
}

export function filterWorks(works: Work[], state: ListState, opts?: FilterOpts): Work[] {
  // isAvailable=false の作品は既定で非表示（showUnavailable トグルで表示切替）
  let result = opts?.showUnavailable ? works : works.filter((w) => w.isAvailable !== false)

  // 実体に解決できない空シェル（話数 0＝サムネ/最新話/初出すべて欠落）は既定で除外（§59）。
  // トグル（§63・includeEmpty）が ON のときは保持したまま表示する（データは消さない）。
  result = opts?.includeEmpty ? result : result.filter((w) => (w.episodeCount ?? 0) > 0)

  if (state.q) {
    // 素のワード検索は「シリーズタイトルの部分一致のみ」（§87）。タグは対象外。
    // タグで絞りたい時は #トークン（§35）でピル化して AND フィルタする＝役割分担：
    // 素ワード＝タイトル検索 / #＝タグフィルタ。
    const q = state.q.toLowerCase()
    result = result.filter((w) => w.title.toLowerCase().includes(q))
  }

  if (state.row) {
    result = result.filter((w) => colKeyMatchesRow(w.colKey, state.row))
  }

  if (state.tags.length > 0) {
    // 複数タグは AND（すべて含むものだけ）＝§35。照合は NFKC 正規化で突き合わせ（§82）＝
    // 半角カナ・全角括弧・互換文字のズレ（URL値 vs 格納タグ）を吸収して確実に一致させる。
    const want = state.tags.map(normalizeTagForMatch)
    result = result.filter((w) => {
      const have = new Set(w.tags.map(normalizeTagForMatch))
      return want.every((t) => have.has(t))
    })
  }

  if (state.cours) {
    // 複数クールは OR（いずれかに属する作品＝シーズンの和集合・§90）。URL は cours をカンマ区切りで
    // 保持。各エントリを resolveCoursLabel（current/previous プリセット含む）で解決して突き合わせる。
    const wanted = new Set(coursList(state.cours).map(resolveCoursLabel))
    if (wanted.size > 0) result = result.filter((w) => w.cours != null && wanted.has(w.cours))
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
  return sortAllWorksDesc(works, sort, ranking)
}

function sortAllWorksDesc(
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
  if (sort === 'views') {
    // 累計再生数（works.json の totalViews・全作品横断・§79）降順。旧 JSON 互換で
    // totalViews 欠落時のみ ranking.popular の順位にフォールバック。
    const order = ranking ? new Map(ranking.popular.map((r, i) => [r.seriesId, i])) : null
    const tv = (w: Work): number | null => (typeof w.totalViews === 'number' ? w.totalViews : null)
    if (works.some((w) => tv(w) != null)) {
      return [...works].sort((a, b) => (tv(b) ?? 0) - (tv(a) ?? 0) || a.seriesId - b.seriesId)
    }
    return [...works].sort((a, b) => {
      const ai = order?.get(a.seriesId) ?? Infinity
      const bi = order?.get(b.seriesId) ?? Infinity
      return ai !== bi ? ai - bi : a.seriesId - b.seriesId
    })
  }
  if (sort === 'new') {
    // 最近更新＝各シリーズの「最新話の投稿時刻」(latestAt = MAX(episode startTime)) 降順（§54/§72）。
    // 同時刻タイ（毎時00分の一括配信）は latestContentId の so番号降順で解決（後投稿ほど大きい）、
    // それでも同値なら seriesId 降順をフォールバック。
    const t = (w: Work): number => {
      const v = w.latestAt ?? w.firstAt
      const ms = v ? Date.parse(v) : NaN
      return Number.isNaN(ms) ? -Infinity : ms
    }
    const cidNum = (w: Work): number => {
      const m = (w.latestContentId ?? '').match(/(\d+)$/)
      return m ? parseInt(m[1], 10) : -1
    }
    return [...works].sort(
      (a, b) => t(b) - t(a) || cidNum(b) - cidNum(a) || b.seriesId - a.seriesId
    )
  }
  if (sort === 'created') {
    // 新規＝各シリーズの「最古話の投稿時刻」(firstAt = MIN(episode startTime)) 降順（§72）。
    // ＝シリーズが（支店に）新しくできた近似。カード表示の日付も firstAt に揃える。
    // 同時刻タイは firstContentId の so番号降順（後投稿ほど大きい）→ seriesId 降順。
    const t = (w: Work): number => {
      const v = w.firstAt ?? w.latestAt
      const ms = v ? Date.parse(v) : NaN
      return Number.isNaN(ms) ? -Infinity : ms
    }
    const cidNum = (w: Work): number => {
      const m = (w.firstContentId ?? '').match(/(\d+)$/)
      return m ? parseInt(m[1], 10) : -1
    }
    return [...works].sort(
      (a, b) => t(b) - t(a) || cidNum(b) - cidNum(a) || b.seriesId - a.seriesId
    )
  }
  if (sort === 'comments') {
    return [...works].sort(
      (a, b) => (b.commentTotal ?? 0) - (a.commentTotal ?? 0) || a.seriesId - b.seriesId
    )
  }
  if (sort === 'avgViews') {
    // 平均再生数＝累計再生数÷話数（§86）。長尺バイアスを外した 1 話あたり人気。
    return [...works].sort((a, b) => avgViewsOf(b) - avgViewsOf(a) || a.seriesId - b.seriesId)
  }
  if (sort === 'avgComments') {
    return [...works].sort((a, b) => avgCommentsOf(b) - avgCommentsOf(a) || a.seriesId - b.seriesId)
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
