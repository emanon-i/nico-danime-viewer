import { icon } from '../../components/icon'

export interface HeaderOptions {
  /**
   * true のときヘッダ🔍を初期 `aria-hidden="true"` で隠す（トップ専用＝ヒーロー検索が
   * 見えている間は出さない／スクロールで隠れたら出す）。false は常時表示（一覧/詳細）。
   */
  heroSearchToggle: boolean
}

/**
 * 全ページ共通ヘッダ（banner ランドマーク）を生成する。
 * ロゴ＋🔍検索＋☀/🌙テーマ＋⚙設定/情報。右上順は §6.4（🔍→テーマ→⚙）。
 * アイコンはバンドル SVG を DOM API で挿入（CSP・innerHTML 補間なし）。
 */
export function buildHeader(opts: HeaderOptions): HTMLElement {
  const header = document.createElement('header')
  header.className = 'site-header'
  header.setAttribute('role', 'banner')
  header.dataset.section = 'header'

  const logo = document.createElement('a')
  logo.className = 'logo'
  logo.href = '?'

  const logoImg = document.createElement('img')
  logoImg.src = `${import.meta.env.BASE_URL}favicon-32.png`
  logoImg.width = 28
  logoImg.height = 28
  logoImg.alt = ''
  logoImg.setAttribute('aria-hidden', 'true')
  logoImg.className = 'logo-icon'
  logo.appendChild(logoImg)

  const logoText = document.createElement('span')
  logoText.className = 'logo-text'
  const logoBrand = document.createElement('span')
  logoBrand.className = 'logo-brand'
  logoBrand.textContent = 'dアニメストア'
  const logoSub = document.createElement('span')
  logoSub.className = 'logo-sub'
  logoSub.textContent = 'ニコニコ支店ビューア'
  logoText.appendChild(logoBrand)
  logoText.appendChild(logoSub)
  logo.appendChild(logoText)
  header.appendChild(logo)

  const searchBtn = document.createElement('button')
  searchBtn.className = 'icon-btn header-search-btn'
  searchBtn.setAttribute('aria-label', '検索')
  if (opts.heroSearchToggle) searchBtn.setAttribute('aria-hidden', 'true')
  searchBtn.appendChild(icon('search'))
  header.appendChild(searchBtn)

  const themeBtn = document.createElement('button')
  themeBtn.className = 'icon-btn theme-btn'
  themeBtn.setAttribute('aria-label', 'テーマ切替')
  themeBtn.appendChild(icon('sun'))
  header.appendChild(themeBtn)

  const settingsBtn = document.createElement('button')
  settingsBtn.className = 'icon-btn settings-btn'
  settingsBtn.setAttribute('aria-label', '設定/情報')
  settingsBtn.appendChild(icon('settings'))
  header.appendChild(settingsBtn)

  return header
}
