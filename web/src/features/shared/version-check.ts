/**
 * 新バージョン検知＋更新バナー（§92）。スマホ中心でハードリフレッシュしづらく、古い
 * キャッシュで壊れて見える問題への自動解消。
 *
 * - 実行中バンドルは __BUILD_ID__（ビルド時に焼き込み）を持つ。
 * - `version.json`（デプロイ毎に build 値が変わる）を `cache:'no-store'`＋`?t=` で**確実に最新**取得。
 * - 値が食い違えば新デプロイあり → 控えめな更新バナーを出す（自動リロードはしない＝入力取りこぼし防止）。
 * - 取得タイミング: 起動時／タブ可視化（visibilitychange）／フォーカス／長め間隔のポーリング。
 * - CSP: inline style/script を使わずクラスで。a11y: role=status＋フォーカス可能ボタン。
 */
const VERSION_URL = `${import.meta.env.BASE_URL}version.json`
const POLL_MS = 5 * 60 * 1000 // 5 分ごと（可視時のみ）

let bannerShown = false

async function fetchLatestBuild(): Promise<string | null> {
  try {
    // CDN/ブラウザキャッシュを確実に回避（no-store＋クエリ）。
    const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return null
    const data: unknown = await res.json()
    const build = (data as { build?: unknown } | null)?.build
    return typeof build === 'string' ? build : null
  } catch {
    return null // ネットワーク不調時は黙って次の機会に再試行
  }
}

function showUpdateBanner(): void {
  if (bannerShown || document.getElementById('update-banner')) return
  bannerShown = true

  const banner = document.createElement('div')
  banner.id = 'update-banner'
  banner.className = 'update-banner'
  banner.setAttribute('role', 'status')
  banner.setAttribute('aria-live', 'polite')

  const text = document.createElement('span')
  text.className = 'update-banner-text'
  text.textContent = '新しいバージョンがあります'
  banner.appendChild(text)

  const reload = document.createElement('button')
  reload.type = 'button'
  reload.className = 'update-banner-reload'
  reload.textContent = '更新'
  reload.addEventListener('click', () => location.reload())
  banner.appendChild(reload)

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'update-banner-close'
  close.setAttribute('aria-label', '更新の通知を閉じる')
  close.textContent = '×'
  close.addEventListener('click', () => banner.remove())
  banner.appendChild(close)

  document.body.appendChild(banner)
}

async function checkVersion(): Promise<void> {
  if (bannerShown) return
  const latest = await fetchLatestBuild()
  if (latest && latest !== __BUILD_ID__) showUpdateBanner()
}

/** バージョン監視を開始する（1 回だけ）。 */
export function initVersionCheck(): void {
  if ((initVersionCheck as { done?: boolean }).done) return
  ;(initVersionCheck as { done?: boolean }).done = true

  // タブが見えたとき／フォーカス時に最新を確認（スマホで戻ってきた瞬間に検知）。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkVersion()
  })
  window.addEventListener('focus', () => void checkVersion())
  // 可視中は控えめにポーリング（非可視時は無駄打ちしない）。
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void checkVersion()
  }, POLL_MS)
}
