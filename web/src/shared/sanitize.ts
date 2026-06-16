const ALLOWED_VOID_TAGS = new Set(['br'])

/** 概要 HTML を allowlist でサニタイズする（<br> のみ許可）*/
export function sanitizeOverview(html: string): string {
  if (!html) return ''
  let result = html
  // <script> タグをコンテンツごと除去
  result = result.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  // on* イベント属性を除去
  result = result.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
  // style 属性を除去
  result = result.replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
  // javascript: スキームの href を無効化
  result = result.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href=""')
  // 許可外タグを除去（コンテンツは残す）、<br> は保持
  result = result.replace(/<\/?([\w-]+)\b[^>]*\/?>/g, (_match, tag: string) => {
    return ALLOWED_VOID_TAGS.has(tag.toLowerCase()) ? '<br>' : ''
  })
  return result
}

/** 取り込み時テキストの制御文字を正規化する（LF=10, CR=13, TAB=9 は保持）*/
export function normalizeIngestText(text: string): string {
  if (!text) return ''
  return [...text]
    .filter((ch) => {
      const c = ch.charCodeAt(0)
      if (c === 9 || c === 10 || c === 13) return true // TAB / LF / CR
      if (c < 32) return false // U+0000-U+001F 制御文字
      if (c === 127) return false // DEL
      if (c >= 128 && c <= 159) return false // C1 制御文字
      return true
    })
    .join('')
}

const ALLOWED_EXTERNAL_HOSTS = [
  'nicovideo.jp',
  'www.nicovideo.jp',
  'ch.nicovideo.jp',
  'anime.nicovideo.jp',
  'nimg.jp',
] as const

/**
 * 外部 URL を allowlist で検証する。
 * https: かつ許可ホスト（*.nicovideo.jp, *.nimg.jp）のみ有効とする。
 */
export function validateExternalUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase()
  const allowed = ALLOWED_EXTERNAL_HOSTS.some((h) => host === h || host.endsWith('.' + h))
  return allowed ? parsed.href : null
}
