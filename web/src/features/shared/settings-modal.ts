import { exportUserState, importUserState, clearUserState } from './user-state'
import type { UserStateData } from './user-state'

export interface SettingsModalOptions {
  repoUrl?: string | null
  lastUpdated?: string | null
  onRerender?: () => void
}

function createModal(options: SettingsModalOptions): HTMLElement {
  const overlay = document.createElement('div')
  overlay.className = 'settings-overlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', '設定/情報')

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

  // ── 情報セクション ────────────────────────────
  const infoSection = document.createElement('section')
  infoSection.dataset.section = 'info'
  const infoH2 = document.createElement('h2')
  infoH2.textContent = '情報'
  infoSection.appendChild(infoH2)

  const updateP = document.createElement('p')
  updateP.dataset.part = 'last-updated'
  updateP.textContent = options.lastUpdated
    ? `データ最終更新: ${options.lastUpdated}`
    : 'データ最終更新: 不明'
  infoSection.appendChild(updateP)

  if (options.repoUrl) {
    const repoA = document.createElement('a')
    repoA.className = 'settings-repo-link'
    repoA.href = options.repoUrl
    repoA.target = '_blank'
    repoA.rel = 'noopener noreferrer'
    repoA.textContent = 'リポジトリ'
    infoSection.appendChild(repoA)
  } else {
    const repoP = document.createElement('p')
    repoP.className = 'settings-repo-unavailable'
    repoP.textContent = 'リポジトリ: 準備中'
    infoSection.appendChild(repoP)
  }

  // データ出典（主要のみ・長文不可）
  const sources = document.createElement('div')
  sources.className = 'settings-sources'
  const srcLabel = document.createElement('span')
  srcLabel.className = 'settings-sources-label'
  srcLabel.textContent = 'データ出典'
  sources.appendChild(srcLabel)
  const SOURCES: Array<[string, string]> = [
    ['dアニメストア ニコニコ支店 公式', 'https://ch.nicovideo.jp/ch2632720'],
    ['Snapshot 検索API v2 ガイド', 'https://site.nicovideo.jp/search-api-docs/snapshot'],
  ]
  for (const [text, href] of SOURCES) {
    const a = document.createElement('a')
    a.className = 'settings-source-link'
    a.href = href
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.textContent = text
    sources.appendChild(a)
  }
  infoSection.appendChild(sources)

  panel.appendChild(infoSection)
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

  function close(): void {
    if (modal) {
      modal.remove()
      modal = null
    }
    if (onKeydown) {
      document.removeEventListener('keydown', onKeydown)
      onKeydown = null
    }
  }

  function open(): void {
    if (modal) return
    modal = createModal(options)
    container.appendChild(modal)

    // 閉じるボタン
    modal.querySelector('.settings-close')?.addEventListener('click', close)

    // 背景クリックで閉じる
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close()
    })

    // Esc で閉じる（リーク防止：参照を保持して close() で除去）
    onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKeydown)

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
