import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import {
  isFavorite,
  toggleFavorite,
  isWatched,
  toggleWatched,
  getFavoriteIds,
  getWatchedIds,
  exportUserState,
  importUserState,
  clearUserState,
  USER_STATE_KEYS,
} from '../../web/src/features/shared/user-state'

// localStorage モック（happy-dom の実装差異を回避）
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

beforeEach(() => {
  store.clear()
})

describe('F-0034: お気に入り/見た (localStorage)', () => {
  it('test_favorite_watched_persist: ♥ トグルが localStorage に保存され呼び出しをまたいで復元される', () => {
    expect(isFavorite(1)).toBe(false)
    toggleFavorite(1)
    expect(isFavorite(1)).toBe(true)
    // localStorage が残っている限り復元される
    expect(isFavorite(1)).toBe(true)
    toggleFavorite(1)
    expect(isFavorite(1)).toBe(false)
  })

  it('test_favorite_watched_persist: ✓ 見たトグルが localStorage に保存され復元される', () => {
    expect(isWatched(1)).toBe(false)
    toggleWatched(1)
    expect(isWatched(1)).toBe(true)
    expect(isWatched(1)).toBe(true)
    toggleWatched(1)
    expect(isWatched(1)).toBe(false)
  })

  it('複数 ID を独立して管理できる', () => {
    toggleFavorite(1)
    toggleFavorite(3)
    expect(isFavorite(1)).toBe(true)
    expect(isFavorite(2)).toBe(false)
    expect(isFavorite(3)).toBe(true)
  })

  it('toggleFavorite は現在の状態 (boolean) を返す', () => {
    expect(toggleFavorite(42)).toBe(true)
    expect(toggleFavorite(42)).toBe(false)
  })

  it('getFavoriteIds / getWatchedIds が配列を返す', () => {
    toggleFavorite(10)
    toggleFavorite(20)
    toggleWatched(30)
    const favs = getFavoriteIds()
    expect(favs).toContain(10)
    expect(favs).toContain(20)
    expect(getWatchedIds()).toContain(30)
  })

  it('test_filter_by_favorite_unwatched: getFavoriteIds でお気に入りの seriesId が取得できる', () => {
    toggleFavorite(5)
    toggleFavorite(7)
    const ids = new Set(getFavoriteIds())
    expect(ids.has(5)).toBe(true)
    expect(ids.has(7)).toBe(true)
    expect(ids.has(1)).toBe(false)
  })

  it('test_filter_by_favorite_unwatched: getWatchedIds で見た seriesId が取得できる', () => {
    toggleWatched(11)
    const ids = new Set(getWatchedIds())
    expect(ids.has(11)).toBe(true)
    expect(ids.has(1)).toBe(false)
  })

  it('test_no_network_for_user_state: ♥/✓ 操作で fetch が発生しない', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response())
    toggleFavorite(1)
    toggleWatched(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('USER_STATE_KEYS 構造確認', () => {
  it('USER_STATE_KEYS が favorites と watched の 2 キーを含む', () => {
    expect(USER_STATE_KEYS.length).toBe(2)
    expect(USER_STATE_KEYS.some((k) => k.includes('favorites'))).toBe(true)
    expect(USER_STATE_KEYS.some((k) => k.includes('watched'))).toBe(true)
  })
})

describe('export / import ラウンドトリップ', () => {
  it('test_export_import_roundtrip: export して import すると元の状態に一致する', () => {
    toggleFavorite(100)
    toggleFavorite(200)
    toggleWatched(300)

    const exported = exportUserState()
    expect(exported.favorites).toContain(100)
    expect(exported.favorites).toContain(200)
    expect(exported.watched).toContain(300)
    expect(exported.exportedAt).toBeTruthy()

    // 一旦クリアしてインポート
    store.clear()
    expect(isFavorite(100)).toBe(false)

    importUserState(exported)
    expect(isFavorite(100)).toBe(true)
    expect(isFavorite(200)).toBe(true)
    expect(isWatched(300)).toBe(true)
  })

  it('不正なデータ形式では importUserState がエラーを投げる', () => {
    expect(() =>
      importUserState({ favorites: 'bad', watched: [] } as unknown as ReturnType<
        typeof exportUserState
      >)
    ).toThrow()
  })
})

describe('clearUserState', () => {
  it('test_clear_cache: clearUserState でお気に入り/見たが消える', () => {
    toggleFavorite(1)
    toggleWatched(2)
    expect(isFavorite(1)).toBe(true)
    expect(isWatched(2)).toBe(true)

    clearUserState()
    expect(isFavorite(1)).toBe(false)
    expect(isWatched(2)).toBe(false)
  })

  it('USER_STATE_KEYS の各キーが clearUserState 後に消える', () => {
    USER_STATE_KEYS.forEach((key) => mockLocalStorage.setItem(key, '[]'))
    clearUserState()
    USER_STATE_KEYS.forEach((key) => {
      expect(mockLocalStorage.getItem(key)).toBeNull()
    })
  })
})
