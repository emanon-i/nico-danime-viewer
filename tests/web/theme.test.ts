// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import {
  initTheme,
  getTheme,
  toggleTheme,
  THEME_KEY_NAME,
} from '../../web/src/features/shared/theme'

// localStorage モック（happy-dom の localStorage.clear 非対応を回避）
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
  document.documentElement.classList.remove('dark', 'light')
})

describe('F-0036: ダーク/ライトテーマ', () => {
  it('test_theme_follows_os_default: localStorage になければ getTheme が null を返す', () => {
    expect(getTheme()).toBeNull()
  })

  it('test_theme_follows_os_default: initTheme で localStorage なしのとき classList を変更しない', () => {
    initTheme()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.classList.contains('light')).toBe(false)
  })

  it('test_theme_toggle_persist: toggleTheme 後に localStorage にテーマが保存される', () => {
    toggleTheme()
    const stored = mockLocalStorage.getItem(THEME_KEY_NAME)
    expect(stored === 'dark' || stored === 'light').toBe(true)
  })

  it('test_theme_toggle_persist: initTheme で dark を復元する', () => {
    mockLocalStorage.setItem(THEME_KEY_NAME, 'dark')
    initTheme()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('test_theme_toggle_persist: initTheme で light を復元する', () => {
    mockLocalStorage.setItem(THEME_KEY_NAME, 'light')
    initTheme()
    expect(document.documentElement.classList.contains('light')).toBe(true)
  })

  it('test_theme_toggle_persist: toggleTheme を2回呼ぶと元のテーマに戻る', () => {
    const first = toggleTheme()
    const second = toggleTheme()
    expect(first).not.toBe(second)
  })

  it('test_theme_storage_scope: テーマキーは THEME_KEY_NAME のみ（お気に入りキーを書かない）', () => {
    toggleTheme()
    const keys = [...store.keys()]
    expect(keys).toContain(THEME_KEY_NAME)
    // お気に入り/見たキーは書かれない
    expect(keys.some((k) => k.includes('favorites') || k.includes('watched'))).toBe(false)
  })

  it('getTheme: 保存値が dark なら dark を返す', () => {
    mockLocalStorage.setItem(THEME_KEY_NAME, 'dark')
    expect(getTheme()).toBe('dark')
  })

  it('getTheme: 保存値が light なら light を返す', () => {
    mockLocalStorage.setItem(THEME_KEY_NAME, 'light')
    expect(getTheme()).toBe('light')
  })

  it('getTheme: 無効な値は null を返す', () => {
    mockLocalStorage.setItem(THEME_KEY_NAME, 'invalid')
    expect(getTheme()).toBeNull()
  })
})
