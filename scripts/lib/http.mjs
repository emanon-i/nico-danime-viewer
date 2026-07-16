// scripts/lib/http.mjs
// ToS準拠HTTPクライアント: UA必須・前回レスポンス時間ぶん待機・リトライ・条件付きGET対応

import { logger } from './logger.mjs'

const DEFAULT_UA =
  'nico-danime-viewer/dev (non-commercial; https://github.com/emanon-i/nico-danime-viewer)'

// Injectable for testing
export const _http = {
  sleepFn: (ms) => new Promise((r) => setTimeout(r, ms)),
  nowFn: () => Date.now(),
  randomFn: () => Math.random(), // jitter 用（テストで固定して決定的にする）
  backoff503Ms: 5 * 60 * 1000, // Retry-After / 指数バックオフの上限キャップ（暴走・悪意ヘッダ対策）
  retryDelaysMs: [2000, 6000, 18000], // 指数バックオフ基準値（jitter 前）: 2s → 6s → 18s
}

let _lastResponseMs = 0

/** テスト用: 適応的遅延状態をリセット */
export function _resetAdaptiveDelay() {
  _lastResponseMs = 0
}

// リトライ対象ステータス: 403（一時的な弾かれ）/ 429（レート制限）/ 5xx（サーバ側障害）。
// それ以外（2xx/3xx/404 等の 4xx）は成功扱いで即返す。
function _isRetryableStatus(status) {
  return status === 403 || status === 429 || (status >= 500 && status < 600)
}

// Retry-After ヘッダ（秒数）を ms に変換。無い/不正なら null。
function _retryAfterMs(resp) {
  const v = resp?.headers?.get?.('retry-after')
  if (v == null) return null
  const sec = Number(v)
  if (!Number.isFinite(sec) || sec < 0) return null
  return sec * 1000
}

// 指数バックオフ ± 20% jitter。backoff503Ms を上限キャップにして暴走を防ぐ。
function _backoffMs(attempt) {
  const base = _http.retryDelaysMs[Math.min(attempt, _http.retryDelaysMs.length - 1)]
  const jitter = base * 0.2 * (_http.randomFn() * 2 - 1)
  return Math.min(Math.max(base + jitter, 0), _http.backoff503Ms)
}

/**
 * ToS 準拠の fetch。
 * - User-Agent ヘッダ必須
 * - 前回レスポンス時間ぶん待機（適応的レート制限）
 * - 403 / 429 / 5xx / ネットワーク例外は指数バックオフ＋jitterでリトライ
 *   （429・503 は Retry-After ヘッダを尊重・backoff503Ms を上限キャップ）
 * - リトライ回数は既定3・`NICO_HTTP_RETRIES` で上書き可（0でリトライ無効）
 * - If-Modified-Since / ETag は options.headers で渡すことで条件付き GET に対応
 */
export async function fetchWithToS(url, options = {}) {
  const ua = process.env.NICO_USER_AGENT ?? DEFAULT_UA
  const headers = { 'User-Agent': ua, ...options.headers }
  // 非数値・負値は既定3にフォールバック（NaN 比較で無限リトライにならないようガード）
  const parsedRetries = Number(process.env.NICO_HTTP_RETRIES ?? 3)
  const maxRetries = Number.isFinite(parsedRetries) && parsedRetries >= 0 ? parsedRetries : 3

  if (_lastResponseMs > 0) {
    await _http.sleepFn(Math.max(_lastResponseMs, 500))
  }

  for (let attempt = 0; ; attempt++) {
    const t0 = _http.nowFn()
    let resp
    let networkErr = null
    try {
      resp = await fetch(url, { ...options, headers })
    } catch (err) {
      networkErr = err
    }
    _lastResponseMs = _http.nowFn() - t0

    const retryable = networkErr ? true : _isRetryableStatus(resp.status)
    if (!retryable || attempt >= maxRetries) {
      if (networkErr) throw networkErr
      return resp
    }

    let delayMs = _backoffMs(attempt)
    if (!networkErr && (resp.status === 429 || resp.status === 503)) {
      const retryAfter = _retryAfterMs(resp)
      if (retryAfter != null) delayMs = Math.min(Math.max(retryAfter, delayMs), _http.backoff503Ms)
    }

    logger.warn('http', 'retrying after failure', {
      url,
      status: networkErr ? undefined : resp.status,
      error: networkErr ? networkErr.message : undefined,
      attempt: attempt + 1,
      delayMs: Math.round(delayMs),
    })

    await _http.sleepFn(delayMs)
  }
}
