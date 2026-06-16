// scripts/lib/http.mjs
// ToS準拠HTTPクライアント: UA必須・前回レスポンス時間ぶん待機・503バックオフ・条件付きGET対応

import { logger } from './logger.mjs'

const DEFAULT_UA =
  'nico-danime-viewer/dev (non-commercial; https://github.com/emanon-i/nico-danime-viewer)'

// Injectable for testing
export const _http = {
  sleepFn: (ms) => new Promise((r) => setTimeout(r, ms)),
  nowFn: () => Date.now(),
  backoff503Ms: 5 * 60 * 1000, // 5 minutes
}

let _lastResponseMs = 0

/** テスト用: 適応的遅延状態をリセット */
export function _resetAdaptiveDelay() {
  _lastResponseMs = 0
}

/**
 * ToS 準拠の fetch。
 * - User-Agent ヘッダ必須
 * - 前回レスポンス時間ぶん待機（適応的レート制限）
 * - 503 は 5 分バックオフ後に1回リトライ
 * - If-Modified-Since / ETag は options.headers で渡すことで条件付き GET に対応
 */
export async function fetchWithToS(url, options = {}) {
  const ua = process.env.NICO_USER_AGENT ?? DEFAULT_UA
  const headers = { 'User-Agent': ua, ...options.headers }

  if (_lastResponseMs > 0) {
    await _http.sleepFn(Math.max(_lastResponseMs, 500))
  }

  const t0 = _http.nowFn()
  let resp = await fetch(url, { ...options, headers })
  _lastResponseMs = _http.nowFn() - t0

  if (resp.status === 503) {
    logger.warn('http', '503 received, backing off', {
      url,
      backoffMs: _http.backoff503Ms,
    })
    await _http.sleepFn(_http.backoff503Ms)
    const t1 = _http.nowFn()
    resp = await fetch(url, { ...options, headers })
    _lastResponseMs = _http.nowFn() - t1
  }

  return resp
}
