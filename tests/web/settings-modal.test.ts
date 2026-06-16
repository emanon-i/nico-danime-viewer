// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { initSettingsModal } from '../../web/src/features/shared/settings-modal'
import {
  toggleFavorite,
  toggleWatched,
  isFavorite,
  isWatched,
  clearUserState,
  exportUserState,
  importUserState,
} from '../../web/src/features/shared/user-state'

// localStorage モック
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
  document.body.innerHTML = ''
})

function setup(options = {}) {
  const btn = document.createElement('button')
  btn.className = 'settings-btn'
  document.body.appendChild(btn)
  const container = document.createElement('div')
  document.body.appendChild(container)
  initSettingsModal(btn, container, options)
  return { btn, container }
}

describe('F-0035: 設定/情報モーダル', () => {
  it('test_settings_modal_open_close: ⚙ クリックでモーダルが開く', () => {
    const { btn, container } = setup()
    btn.click()
    expect(container.querySelector('.settings-overlay')).not.toBeNull()
  })

  it('test_settings_modal_open_close: × ボタンでモーダルが閉じる', () => {
    const { btn, container } = setup()
    btn.click()
    const closeBtn = container.querySelector<HTMLButtonElement>('.settings-close')
    closeBtn?.click()
    expect(container.querySelector('.settings-overlay')).toBeNull()
  })

  it('test_settings_modal_open_close: Esc キーでモーダルが閉じる', () => {
    const { btn, container } = setup()
    btn.click()
    expect(container.querySelector('.settings-overlay')).not.toBeNull()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    document.dispatchEvent(event)
    expect(container.querySelector('.settings-overlay')).toBeNull()
  })

  it('test_settings_modal_open_close: 同じボタンを再クリックでモーダルが閉じる（トグル）', () => {
    const { btn, container } = setup()
    btn.click()
    expect(container.querySelector('.settings-overlay')).not.toBeNull()
    btn.click()
    expect(container.querySelector('.settings-overlay')).toBeNull()
  })

  it('test_export_import_roundtrip: export/import ラウンドトリップで状態が一致する', () => {
    toggleFavorite(1)
    toggleWatched(2)
    const exported = exportUserState()

    clearUserState()
    expect(isFavorite(1)).toBe(false)

    importUserState(exported)
    expect(isFavorite(1)).toBe(true)
    expect(isWatched(2)).toBe(true)
  })

  it('test_clear_cache: clearUserState 後にお気に入り/見たが消える', () => {
    toggleFavorite(10)
    toggleWatched(20)
    clearUserState()
    expect(isFavorite(10)).toBe(false)
    expect(isWatched(20)).toBe(false)
  })

  it('情報（出典・更新・リポジトリ）は設定モーダルに含めない（フッターへ移設＝§10）', () => {
    const { btn, container } = setup({ lastUpdated: '2026-06-16T00:00:00Z' })
    btn.click()
    expect(container.querySelector('[data-part="last-updated"]')).toBeNull()
    expect(container.querySelector('.settings-source-link')).toBeNull()
    expect(container.querySelector('.settings-repo-link')).toBeNull()
  })

  it('モーダルに role="dialog" と aria-modal="true" がある', () => {
    const { btn, container } = setup()
    btn.click()
    const overlay = container.querySelector('.settings-overlay')
    expect(overlay?.getAttribute('role')).toBe('dialog')
    expect(overlay?.getAttribute('aria-modal')).toBe('true')
  })
})
