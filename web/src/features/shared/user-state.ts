const FAV_KEY = 'nico-danime-favorites'
// 「見た」は旧来の二値ストアをそのまま温存（後方互換: 旧データ＝見た作品の seriesId 配列）。
const WATCHED_KEY = 'nico-danime-watched'
// 「見たい」は三値化（§F-0034 拡張）で追加した新キー。旧データには存在しないので migration 不要。
const WANT_KEY = 'nico-danime-want'

/** 視聴状態の三値（未視聴 / 見たい / 見た）。クリックで none→want→watched→none と循環する。 */
export type WatchStatus = 'none' | 'want' | 'watched'

function getIds(key: string): Set<number> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return new Set()
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((v): v is number => typeof v === 'number'))
  } catch {
    return new Set()
  }
}

function saveIds(key: string, ids: Set<number>): void {
  localStorage.setItem(key, JSON.stringify([...ids]))
}

export function isFavorite(seriesId: number): boolean {
  return getIds(FAV_KEY).has(seriesId)
}

export function toggleFavorite(seriesId: number): boolean {
  const ids = getIds(FAV_KEY)
  if (ids.has(seriesId)) {
    ids.delete(seriesId)
  } else {
    ids.add(seriesId)
  }
  saveIds(FAV_KEY, ids)
  return ids.has(seriesId)
}

/** 視聴状態を取得する。watched と want は排他だが、万一両方に入っていれば watched を優先。 */
export function getWatchStatus(seriesId: number): WatchStatus {
  if (getIds(WATCHED_KEY).has(seriesId)) return 'watched'
  if (getIds(WANT_KEY).has(seriesId)) return 'want'
  return 'none'
}

/** 視聴状態を 1 段進める（none→want→watched→none）。新しい状態を返す。 */
export function cycleWatchStatus(seriesId: number): WatchStatus {
  const watched = getIds(WATCHED_KEY)
  const want = getIds(WANT_KEY)
  const current = watched.has(seriesId) ? 'watched' : want.has(seriesId) ? 'want' : 'none'
  // どの遷移でも一旦両方から外し、次状態の集合にだけ入れる（排他を保証）。
  watched.delete(seriesId)
  want.delete(seriesId)
  let next: WatchStatus
  if (current === 'none') {
    want.add(seriesId)
    next = 'want'
  } else if (current === 'want') {
    watched.add(seriesId)
    next = 'watched'
  } else {
    next = 'none'
  }
  saveIds(WANT_KEY, want)
  saveIds(WATCHED_KEY, watched)
  return next
}

/** 視聴状態を直接指定する（none/want/watched）。want と watched の排他を保証。 */
export function setWatchStatus(seriesId: number, status: WatchStatus): void {
  const watched = getIds(WATCHED_KEY)
  const want = getIds(WANT_KEY)
  watched.delete(seriesId)
  want.delete(seriesId)
  if (status === 'watched') watched.add(seriesId)
  else if (status === 'want') want.add(seriesId)
  saveIds(WANT_KEY, want)
  saveIds(WATCHED_KEY, watched)
}

/** 後方互換: 「見た」状態かどうか（status === 'watched'）。 */
export function isWatched(seriesId: number): boolean {
  return getWatchStatus(seriesId) === 'watched'
}

/** 「見たい」状態かどうか（status === 'want'）。 */
export function isWant(seriesId: number): boolean {
  return getWatchStatus(seriesId) === 'want'
}

export function getFavoriteIds(): number[] {
  return [...getIds(FAV_KEY)]
}

export function getWatchedIds(): number[] {
  return [...getIds(WATCHED_KEY)]
}

export function getWantIds(): number[] {
  return [...getIds(WANT_KEY)]
}

export interface UserStateData {
  favorites: number[]
  watched: number[]
  /** 「見たい」リスト（三値化で追加・後方互換のため省略可）。 */
  want?: number[]
  exportedAt: string
}

export function exportUserState(): UserStateData {
  return {
    favorites: getFavoriteIds(),
    watched: getWatchedIds(),
    want: getWantIds(),
    exportedAt: new Date().toISOString(),
  }
}

export function importUserState(data: UserStateData): void {
  if (!Array.isArray(data.favorites) || !Array.isArray(data.watched)) {
    throw new Error('Invalid user state format')
  }
  // want は旧フォーマットのエクスポートには存在しない（後方互換＝省略可）。ただし
  // 存在する場合は型を検証する（不正値を黙って空に潰さず、壊れた入力として弾く）。
  if (data.want !== undefined && !Array.isArray(data.want)) {
    throw new Error('Invalid user state format')
  }
  const isNum = (v: unknown): v is number => typeof v === 'number'
  const watched = new Set(data.watched.filter(isNum))
  // want と watched は排他。外部入力で両方に同じ ID があれば watched を優先し want から除く
  // （getWatchStatus の優先順位 watched>want と整合させ、want フィルタへの混入を防ぐ）。
  const want = new Set((data.want ?? []).filter(isNum))
  for (const id of watched) want.delete(id)
  saveIds(FAV_KEY, new Set(data.favorites.filter(isNum)))
  saveIds(WATCHED_KEY, watched)
  saveIds(WANT_KEY, want)
}

export function clearUserState(): void {
  localStorage.removeItem(FAV_KEY)
  localStorage.removeItem(WATCHED_KEY)
  localStorage.removeItem(WANT_KEY)
}

export const USER_STATE_KEYS = [FAV_KEY, WATCHED_KEY, WANT_KEY] as const
