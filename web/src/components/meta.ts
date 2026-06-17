import { icon } from './icon'
import type { IconName } from './icon'

/**
 * メタ情報 1 単位（アイコン＋最小の単位語）の仕様。design-system §8.2。
 * 純アイコンのみは不可 → 値（最小単位語）と aria-label（言語補完）を必ず持つ。
 */
export interface MetaSpec {
  /** 先頭アイコン（play=再生数 / film=話数 / clock=投稿時間 等） */
  icon: IconName
  /** 表示値（`30万` / `12話` / `3時間前` 等・最小の単位語まで） */
  value: string
  /** 支援技術向けの言語補完（例「再生数 30万」「投稿 3時間前」） */
  label: string
  /** 強調（各話行の投稿時間など。--text／weight 500 で他メタより目立たせる） */
  emphasize?: boolean
}

/**
 * `.meta`（inline-flex・アイコン＋値）を 1 つ生成する。design-system §8.2。
 * アイコンは `aria-hidden`（icon() が付与）、意味は `.meta` の aria-label が担う。
 */
export function metaSpan(spec: MetaSpec): HTMLElement {
  const el = document.createElement('span')
  el.className = 'meta' + (spec.emphasize ? ' meta-emphasis' : '')
  el.setAttribute('aria-label', spec.label)
  el.appendChild(icon(spec.icon, 12))
  const v = document.createElement('span')
  v.className = 'meta-val'
  v.textContent = spec.value
  el.appendChild(v)
  return el
}

/**
 * 複数の `.meta` を所定クラスのコンテナに並べる（中黒なし・gap で区切る）。
 */
export function metaRow(specs: MetaSpec[], className: string): HTMLElement {
  const row = document.createElement('div')
  row.className = className
  specs.forEach((s) => row.appendChild(metaSpan(s)))
  return row
}

/** 秒を再生時間表記（`24分` / `1時間30分` / `45秒`）に整形する。 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}秒`
  const min = Math.round(s / 60)
  if (min < 60) return `${min}分`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h}時間` : `${h}時間${m}分`
}

/** 再生数を日本語の概数（308万 / 9,876）に整形する。 */
export function formatViews(n: number): string {
  if (n >= 10000) {
    const man = n / 10000
    return `${man >= 100 ? Math.round(man) : man.toFixed(1)}万`
  }
  return n.toLocaleString('ja-JP')
}

/**
 * 投稿時間を相対表記に整形する（design-system §9.3）。
 * `たった今` / `N分前` / `N時間前` / `N日前`、7 日超は `M/D`、年跨ぎは `YYYY/M/D`。
 * 解釈できない入力は空文字。`nowMs` は注入可能（テスト用）。
 */
export function formatRelativeTime(input: string, nowMs: number = Date.now()): string {
  const t = Date.parse(input)
  if (Number.isNaN(t)) return ''
  const diff = nowMs - t
  const min = 60 * 1000
  const hour = 60 * min
  const day = 24 * hour
  if (diff < 0) return 'たった今'
  if (diff < min) return 'たった今'
  if (diff < hour) return `${Math.floor(diff / min)}分前`
  if (diff < day) return `${Math.floor(diff / hour)}時間前`
  if (diff < 7 * day) return `${Math.floor(diff / day)}日前`
  const d = new Date(t)
  const now = new Date(nowMs)
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}
