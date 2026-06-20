import { exportUserState, importUserState, clearUserState } from './user-state'
import type { UserStateData } from './user-state'

export interface SettingsModalOptions {
  repoUrl?: string | null
  lastUpdated?: string | null
  onRerender?: () => void
  /** 「取得できていないシリーズも表示」トグルの現在値（§67） */
  showEmpty?: boolean
  /** 同トグル変更時のコールバック（§67） */
  onToggleEmpty?: (on: boolean) => void
  /** 「取得不可の作品を表示」トグルの現在値（§PH-0013） */
  showUnavailable?: boolean
  /** 同トグル変更時のコールバック（§PH-0013） */
  onToggleUnavailable?: (on: boolean) => void
}

function createModal(): HTMLElement {
  const overlay = document.createElement('div')
  overlay.className = 'settings-overlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', '設定')

  const panel = document.createElement('div')
  panel.className = 'settings-panel'

  // 閉じるボタン
  const closeBtn = document.createElement('button')
  closeBtn.className = 'settings-close'
  closeBtn.setAttribute('aria-label', '閉じる')
  closeBtn.textContent = '×'
  panel.appendChild(closeBtn)

  // ── 設定セクション ────────────────────────────
  const settingsSection = document.createElement('section')
  settingsSection.dataset.section = 'settings'
  const settingsH2 = document.createElement('h2')
  settingsH2.textContent = '設定'
  settingsSection.appendChild(settingsH2)

  // 「取得できていないシリーズも表示」トグルスイッチ（§67・既定 OFF＝非表示）
  const emptyToggleLabel = document.createElement('label')
  emptyToggleLabel.className = 'settings-toggle'
  const emptyToggle = document.createElement('input')
  emptyToggle.type = 'checkbox'
  emptyToggle.className = 'settings-empty-toggle'
  emptyToggle.setAttribute('role', 'switch')
  const emptyTrack = document.createElement('span')
  emptyTrack.className = 'settings-toggle-track'
  const emptyText = document.createElement('span')
  emptyText.className = 'settings-toggle-text'
  emptyText.textContent = '取得できていないシリーズも表示'
  emptyToggleLabel.appendChild(emptyToggle)
  emptyToggleLabel.appendChild(emptyTrack)
  emptyToggleLabel.appendChild(emptyText)
  settingsSection.appendChild(emptyToggleLabel)

  // 「取得不可の作品を表示」トグルスイッチ（§PH-0013・既定 OFF＝非表示）
  const unavailToggleLabel = document.createElement('label')
  unavailToggleLabel.className = 'settings-toggle'
  const unavailToggle = document.createElement('input')
  unavailToggle.type = 'checkbox'
  unavailToggle.className = 'settings-unavail-toggle'
  unavailToggle.setAttribute('role', 'switch')
  const unavailTrack = document.createElement('span')
  unavailTrack.className = 'settings-toggle-track'
  const unavailText = document.createElement('span')
  unavailText.className = 'settings-toggle-text'
  unavailText.textContent = '取得不可の作品を表示'
  unavailToggleLabel.appendChild(unavailToggle)
  unavailToggleLabel.appendChild(unavailTrack)
  unavailToggleLabel.appendChild(unavailText)
  settingsSection.appendChild(unavailToggleLabel)

  const exportBtn = document.createElement('button')
  exportBtn.className = 'settings-export-btn'
  exportBtn.textContent = 'お気に入り/見た をエクスポート (JSON)'
  settingsSection.appendChild(exportBtn)

  const importLabel = document.createElement('label')
  importLabel.className = 'settings-import-label'
  importLabel.textContent = 'インポート (JSON)'
  const importInput = document.createElement('input')
  importInput.type = 'file'
  importInput.accept = '.json,application/json'
  importInput.className = 'settings-import-input'
  importLabel.appendChild(importInput)
  settingsSection.appendChild(importLabel)

  const clearBtn = document.createElement('button')
  clearBtn.className = 'settings-clear-btn'
  clearBtn.textContent = 'お気に入り/見た を削除（キャッシュ削除）'
  settingsSection.appendChild(clearBtn)

  panel.appendChild(settingsSection)

  // 情報（データ出典・最終更新・リポジトリ）は全ページ共通フッターへ移設（§10）。
  // 設定モーダルは設定（export/import・キャッシュ削除）専用にする。

  overlay.appendChild(panel)
  return overlay
}

export function initSettingsModal(
  settingsBtn: HTMLElement,
  container: HTMLElement,
  options: SettingsModalOptions = {}
): () => void {
  let modal: HTMLElement | null = null
  let onKeydown: ((e: KeyboardEvent) => void) | null = null

  function focusables(panel: HTMLElement): HTMLElement[] {
    return Array.from(
      panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => el.offsetParent !== null || el === document.activeElement)
  }

  function close(): void {
    if (modal) {
      modal.remove()
      modal = null
    }
    if (onKeydown) {
      document.removeEventListener('keydown', onKeydown)
      onKeydown = null
    }
    // フォーカスを開いたトリガー（⚙）へ復帰（§17.1）
    settingsBtn.focus()
  }

  function open(): void {
    if (modal) return
    modal = createModal()
    container.appendChild(modal)
    const panel = modal.querySelector<HTMLElement>('.settings-panel')

    // 閉じるボタン
    const closeBtn = modal.querySelector<HTMLElement>('.settings-close')
    closeBtn?.addEventListener('click', close)

    // 背景クリックで閉じる
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close()
    })

    // 開いたら × ボタンへフォーカス（§17.1）
    closeBtn?.focus()

    // Esc で閉じる＋Tab フォーカストラップ（参照を保持して close() で除去）
    onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close()
        return
      }
      if (e.key === 'Tab' && panel) {
        const items = focusables(panel)
        if (items.length === 0) return
        const first = items[0]
        const last = items[items.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (e.shiftKey && (active === first || !panel.contains(active))) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeydown)

    // 「取得できていないシリーズも表示」トグル（§67）
    const emptyToggle = modal.querySelector<HTMLInputElement>('.settings-empty-toggle')
    if (emptyToggle) {
      emptyToggle.checked = options.showEmpty ?? false
      emptyToggle.setAttribute('aria-checked', emptyToggle.checked ? 'true' : 'false')
      emptyToggle.addEventListener('change', () => {
        emptyToggle.setAttribute('aria-checked', emptyToggle.checked ? 'true' : 'false')
        options.onToggleEmpty?.(emptyToggle.checked)
      })
    }

    // 「取得不可の作品を表示」トグル（§PH-0013）
    const unavailToggle = modal.querySelector<HTMLInputElement>('.settings-unavail-toggle')
    if (unavailToggle) {
      unavailToggle.checked = options.showUnavailable ?? false
      unavailToggle.setAttribute('aria-checked', unavailToggle.checked ? 'true' : 'false')
      unavailToggle.addEventListener('change', () => {
        unavailToggle.setAttribute('aria-checked', unavailToggle.checked ? 'true' : 'false')
        options.onToggleUnavailable?.(unavailToggle.checked)
      })
    }

    // エクスポートボタン
    modal.querySelector('.settings-export-btn')?.addEventListener('click', () => {
      const data = exportUserState()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'nico-danime-state.json'
      a.click()
      URL.revokeObjectURL(url)
    })

    // インポート入力
    modal.querySelector('.settings-import-input')?.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result as string) as UserStateData
          importUserState(data)
          options.onRerender?.()
        } catch {
          // 不正なファイルは無視
        }
      }
      reader.readAsText(file)
    })

    // キャッシュ削除ボタン
    modal.querySelector('.settings-clear-btn')?.addEventListener('click', () => {
      clearUserState()
      options.onRerender?.()
    })
  }

  settingsBtn.addEventListener('click', () => {
    if (modal) {
      close()
    } else {
      open()
    }
  })

  return close
}
