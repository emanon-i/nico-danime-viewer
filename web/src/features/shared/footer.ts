const REPO_URL = 'https://github.com/emanon-i/nico-danime-viewer'

const SOURCES: Array<[string, string]> = [
  ['dアニメストア ニコニコ支店 公式', 'https://ch.nicovideo.jp/ch2632720'],
  ['Snapshot 検索API v2 ガイド', 'https://site.nicovideo.jp/search-api-docs/snapshot'],
]

export interface FooterOptions {
  /** データ最終更新（ISO8601 等の文字列）。null は「不明」 */
  lastUpdated?: string | null
  /** リポジトリ URL。null/未指定はリンクを出さない */
  repoUrl?: string | null
}

/** 「YYYY-MM-DD HH:mm」へ整形（パース不能はそのまま返す） */
function formatUpdated(s: string): string {
  const t = Date.parse(s)
  if (Number.isNaN(t)) return s
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 全ページ共通フッター（contentinfo ランドマーク）。
 * 情報（データ出典・最終更新・リポジトリ）をここに集約する（⚙ 設定モーダルは設定専用＝§10）。
 */
export function renderFooter(opts: FooterOptions = {}): HTMLElement {
  const footer = document.createElement('footer')
  footer.className = 'site-footer'
  footer.setAttribute('role', 'contentinfo')

  const inner = document.createElement('div')
  inner.className = 'site-footer-inner'

  // 非公式注記
  const note = document.createElement('p')
  note.className = 'footer-note'
  note.textContent =
    '非公式・非営利のビューア。ドワンゴ／dアニメストアとは関係ありません。視聴は公式プレイヤーへ。'
  inner.appendChild(note)

  // メタ行（出典・更新・リポジトリ）
  const meta = document.createElement('div')
  meta.className = 'footer-meta'

  const updated = document.createElement('span')
  updated.className = 'footer-updated'
  updated.textContent = `データ最終更新: ${opts.lastUpdated ? formatUpdated(opts.lastUpdated) : '不明'}`
  meta.appendChild(updated)

  for (const [text, href] of SOURCES) {
    const a = document.createElement('a')
    a.className = 'footer-link'
    a.href = href
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.textContent = text
    meta.appendChild(a)
  }

  const repo = opts.repoUrl ?? REPO_URL
  if (repo) {
    const a = document.createElement('a')
    a.className = 'footer-link'
    a.href = repo
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.textContent = 'リポジトリ (GitHub)'
    meta.appendChild(a)
  }

  inner.appendChild(meta)
  footer.appendChild(inner)
  return footer
}
