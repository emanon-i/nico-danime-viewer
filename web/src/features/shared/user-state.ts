const FAV_KEY = 'nico-danime-favorites'
const WATCHED_KEY = 'nico-danime-watched'

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

export function isWatched(seriesId: number): boolean {
  return getIds(WATCHED_KEY).has(seriesId)
}

export function toggleWatched(seriesId: number): boolean {
  const ids = getIds(WATCHED_KEY)
  if (ids.has(seriesId)) {
    ids.delete(seriesId)
  } else {
    ids.add(seriesId)
  }
  saveIds(WATCHED_KEY, ids)
  return ids.has(seriesId)
}

export function getFavoriteIds(): number[] {
  return [...getIds(FAV_KEY)]
}

export function getWatchedIds(): number[] {
  return [...getIds(WATCHED_KEY)]
}

export interface UserStateData {
  favorites: number[]
  watched: number[]
  exportedAt: string
}

export function exportUserState(): UserStateData {
  return {
    favorites: getFavoriteIds(),
    watched: getWatchedIds(),
    exportedAt: new Date().toISOString(),
  }
}

export function importUserState(data: UserStateData): void {
  if (!Array.isArray(data.favorites) || !Array.isArray(data.watched)) {
    throw new Error('Invalid user state format')
  }
  saveIds(FAV_KEY, new Set(data.favorites.filter((v): v is number => typeof v === 'number')))
  saveIds(WATCHED_KEY, new Set(data.watched.filter((v): v is number => typeof v === 'number')))
}

export function clearUserState(): void {
  localStorage.removeItem(FAV_KEY)
  localStorage.removeItem(WATCHED_KEY)
}

export const USER_STATE_KEYS = [FAV_KEY, WATCHED_KEY] as const
