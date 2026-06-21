import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import {
  isFavorite,
  toggleFavorite,
  isWatched,
  isWant,
  getWatchStatus,
  cycleWatchStatus,
  getFavoriteIds,
  getWatchedIds,
  getWantIds,
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

  it('test_watch_status_cycle: 三値トグルが none→want→watched→none と循環し永続化される', () => {
    expect(getWatchStatus(1)).toBe('none')
    expect(cycleWatchStatus(1)).toBe('want')
    expect(getWatchStatus(1)).toBe('want')
    expect(isWant(1)).toBe(true)
    expect(isWatched(1)).toBe(false)

    expect(cycleWatchStatus(1)).toBe('watched')
    expect(getWatchStatus(1)).toBe('watched')
    expect(isWatched(1)).toBe(true)
    expect(isWant(1)).toBe(false)

    expect(cycleWatchStatus(1)).toBe('none')
    expect(getWatchStatus(1)).toBe('none')
  })

  it('want と watched は排他: watched に進むと want 集合から外れる', () => {
    cycleWatchStatus(5) // → want
    expect(getWantIds()).toContain(5)
    cycleWatchStatus(5) // → watched
    expect(getWantIds()).not.toContain(5)
    expect(getWatchedIds()).toContain(5)
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
    cycleWatchStatus(30) // → want
    cycleWatchStatus(30) // → watched
    const favs = getFavoriteIds()
    expect(favs).toContain(10)
    expect(favs).toContain(20)
    expect(getWatchedIds()).toContain(30)
  })

  it('getWantIds で「見たい」の seriesId が取得できる', () => {
    cycleWatchStatus(40) // → want
    expect(new Set(getWantIds()).has(40)).toBe(true)
    expect(new Set(getWatchedIds()).has(40)).toBe(false)
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
    cycleWatchStatus(11) // → want
    cycleWatchStatus(11) // → watched
    const ids = new Set(getWatchedIds())
    expect(ids.has(11)).toBe(true)
    expect(ids.has(1)).toBe(false)
  })

  it('test_no_network_for_user_state: ♥/視聴状態 操作で fetch が発生しない', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response())
    toggleFavorite(1)
    cycleWatchStatus(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('後方互換: 旧 nico-danime-watched 配列はそのまま「見た」状態として読める', () => {
    // 旧バージョンの二値ストア（見た作品の seriesId 配列）を直接書き込む
    mockLocalStorage.setItem('nico-danime-watched', JSON.stringify([900, 901]))
    expect(getWatchStatus(900)).toBe('watched')
    expect(isWatched(901)).toBe(true)
    expect(getWatchStatus(999)).toBe('none')
  })
})

describe('USER_STATE_KEYS 構造確認', () => {
  it('USER_STATE_KEYS が favorites/watched/want の 3 キーを含む', () => {
    expect(USER_STATE_KEYS.length).toBe(3)
    expect(USER_STATE_KEYS.some((k) => k.includes('favorites'))).toBe(true)
    expect(USER_STATE_KEYS.some((k) => k.includes('watched'))).toBe(true)
    expect(USER_STATE_KEYS.some((k) => k.includes('want'))).toBe(true)
  })
})

describe('export / import ラウンドトリップ', () => {
  it('test_export_import_roundtrip: export して import すると元の状態に一致する', () => {
    toggleFavorite(100)
    toggleFavorite(200)
    cycleWatchStatus(300) // → want
    cycleWatchStatus(300) // → watched
    cycleWatchStatus(400) // → want

    const exported = exportUserState()
    expect(exported.favorites).toContain(100)
    expect(exported.favorites).toContain(200)
    expect(exported.watched).toContain(300)
    expect(exported.want).toContain(400)
    expect(exported.exportedAt).toBeTruthy()

    // 一旦クリアしてインポート
    store.clear()
    expect(isFavorite(100)).toBe(false)

    importUserState(exported)
    expect(isFavorite(100)).toBe(true)
    expect(isFavorite(200)).toBe(true)
    expect(isWatched(300)).toBe(true)
    expect(isWant(400)).toBe(true)
  })

  it('後方互換: want を持たない旧エクスポートも import できる', () => {
    importUserState({ favorites: [1], watched: [2], exportedAt: '2026-01-01T00:00:00Z' })
    expect(isFavorite(1)).toBe(true)
    expect(isWatched(2)).toBe(true)
    expect(getWantIds()).toEqual([])
  })

  it('import は want/watched の排他を保証する（重複 ID は watched 優先で want から除く）', () => {
    importUserState({
      favorites: [],
      watched: [5],
      want: [5, 6],
      exportedAt: '2026-01-01T00:00:00Z',
    })
    expect(getWatchStatus(5)).toBe('watched')
    expect(new Set(getWantIds()).has(5)).toBe(false) // watched と重複した 5 は want から除外
    expect(isWant(6)).toBe(true)
  })

  it('want が配列でない不正データは import で弾く（黙って空にしない）', () => {
    expect(() =>
      importUserState({
        favorites: [],
        watched: [],
        want: 'bad',
        exportedAt: '',
      } as unknown as ReturnType<typeof exportUserState>)
    ).toThrow()
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
  it('test_clear_cache: clearUserState でお気に入り/見たい/見たが消える', () => {
    toggleFavorite(1)
    cycleWatchStatus(2) // → want
    cycleWatchStatus(2) // → watched
    cycleWatchStatus(3) // → want
    expect(isFavorite(1)).toBe(true)
    expect(isWatched(2)).toBe(true)
    expect(isWant(3)).toBe(true)

    clearUserState()
    expect(isFavorite(1)).toBe(false)
    expect(isWatched(2)).toBe(false)
    expect(isWant(3)).toBe(false)
  })

  it('USER_STATE_KEYS の各キーが clearUserState 後に消える', () => {
    USER_STATE_KEYS.forEach((key) => mockLocalStorage.setItem(key, '[]'))
    clearUserState()
    USER_STATE_KEYS.forEach((key) => {
      expect(mockLocalStorage.getItem(key)).toBeNull()
    })
  })
})
