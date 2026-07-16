import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchWithToS, _http, _resetAdaptiveDelay } from '../../scripts/lib/http.mjs'

describe('fetchWithToS (F-0006)', () => {
  let mockFetch

  beforeEach(() => {
    _resetAdaptiveDelay()
    mockFetch = vi.fn().mockResolvedValue({ status: 200 })
    vi.stubGlobal('fetch', mockFetch)
    // 遅延なしにするためスリープをノーオプに
    _http.sleepFn = vi.fn().mockResolvedValue(undefined)
    _http.nowFn = vi.fn().mockReturnValue(0)
    _http.randomFn = () => 0.5 // jitter を中立化（±0）して決定的にする
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    _http.sleepFn = (ms) => new Promise((r) => setTimeout(r, ms))
    _http.nowFn = () => Date.now()
    _http.randomFn = () => Math.random()
    _http.backoff503Ms = 5 * 60 * 1000
    _http.retryDelaysMs = [2000, 6000, 18000]
    delete process.env.NICO_HTTP_RETRIES
  })

  it('test_request_has_user_agent (AC-1)', async () => {
    await fetchWithToS('https://example.com')
    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.headers?.['User-Agent']).toBeTruthy()
  })

  it('uses NICO_USER_AGENT env var if set', async () => {
    process.env.NICO_USER_AGENT = 'custom-ua/1.0'
    await fetchWithToS('https://example.com')
    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.headers['User-Agent']).toBe('custom-ua/1.0')
    delete process.env.NICO_USER_AGENT
  })

  it('test_sequential_with_adaptive_delay (AC-2)', async () => {
    const sleepCalls = []
    _http.sleepFn = vi.fn((ms) => {
      sleepCalls.push(ms)
      return Promise.resolve()
    })
    let t = 0
    _http.nowFn = vi.fn(() => {
      t += 100 // 各呼び出しで 100ms 進む
      return t
    })

    await fetchWithToS('https://example.com/1')
    await fetchWithToS('https://example.com/2')

    // 2回目の呼び出し前に sleep が発生すること
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1)
    expect(sleepCalls[0]).toBeGreaterThan(0)
  })

  it('passes extra headers (e.g. If-Modified-Since for conditional GET)', async () => {
    await fetchWithToS('https://example.com', {
      headers: { 'If-Modified-Since': 'Mon, 01 Jan 2024 00:00:00 GMT' },
    })
    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.headers['If-Modified-Since']).toBe('Mon, 01 Jan 2024 00:00:00 GMT')
    expect(opts.headers['User-Agent']).toBeTruthy()
  })

  describe('retry (403 / 429 / 5xx / network error)', () => {
    it('403 then 200 recovers (jitter 中立で正確に retryDelaysMs[0] 待つ)', async () => {
      const sleepCalls = []
      _http.sleepFn = vi.fn((ms) => {
        sleepCalls.push(ms)
        return Promise.resolve()
      })
      let call = 0
      mockFetch.mockImplementation(() => {
        call++
        return Promise.resolve({ status: call === 1 ? 403 : 200, headers: { get: () => null } })
      })

      const resp = await fetchWithToS('https://example.com')

      expect(resp.status).toBe(200)
      expect(call).toBe(2)
      // sleepCalls[0] は適応ペーシング(no-op、_lastResponseMs=0で呼ばれない) → sleepCalls[0] はリトライ待機
      expect(sleepCalls).toContain(2000)
    })

    it('5xx (503) は Retry-After 無指定なら指数バックオフ（旧: 無条件5分待ちではない）', async () => {
      const sleepCalls = []
      _http.sleepFn = vi.fn((ms) => {
        sleepCalls.push(ms)
        return Promise.resolve()
      })
      let call = 0
      mockFetch.mockImplementation(() => {
        call++
        return Promise.resolve({ status: call === 1 ? 503 : 200, headers: { get: () => null } })
      })

      const resp = await fetchWithToS('https://example.com')

      expect(resp.status).toBe(200)
      expect(sleepCalls).toContain(2000)
      expect(sleepCalls).not.toContain(300000)
    })

    it('429 with Retry-After: ヘッダの秒数を尊重（backoff503Ms を上限にキャップ）', async () => {
      const sleepCalls = []
      _http.sleepFn = vi.fn((ms) => {
        sleepCalls.push(ms)
        return Promise.resolve()
      })
      _http.backoff503Ms = 300000
      let call = 0
      mockFetch.mockImplementation(() => {
        call++
        return Promise.resolve({
          status: call === 1 ? 429 : 200,
          headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '120' : null) },
        })
      })

      const resp = await fetchWithToS('https://example.com')

      expect(resp.status).toBe(200)
      expect(sleepCalls).toContain(120000) // Retry-After: 120s → 120000ms（< cap 300000）
    })

    it('429 with Retry-After がキャップ(backoff503Ms)を超えるとキャップされる', async () => {
      const sleepCalls = []
      _http.sleepFn = vi.fn((ms) => {
        sleepCalls.push(ms)
        return Promise.resolve()
      })
      _http.backoff503Ms = 5000
      let call = 0
      mockFetch.mockImplementation(() => {
        call++
        return Promise.resolve({
          status: call === 1 ? 429 : 200,
          headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '9999' : null) },
        })
      })

      const resp = await fetchWithToS('https://example.com')

      expect(resp.status).toBe(200)
      expect(sleepCalls).toContain(5000) // キャップされる
    })

    it('network error then success (fetch reject からの回復)', async () => {
      _http.sleepFn = vi.fn().mockResolvedValue(undefined)
      let call = 0
      mockFetch.mockImplementation(() => {
        call++
        if (call === 1) return Promise.reject(new Error('ECONNRESET'))
        return Promise.resolve({ status: 200, headers: { get: () => null } })
      })

      const resp = await fetchWithToS('https://example.com')
      expect(resp.status).toBe(200)
      expect(call).toBe(2)
    })

    it('permanent failure: 最大リトライ後も最後のレスポンスをそのまま返す', async () => {
      _http.sleepFn = vi.fn().mockResolvedValue(undefined)
      mockFetch.mockResolvedValue({ status: 500, headers: { get: () => null } })

      const resp = await fetchWithToS('https://example.com')

      expect(resp.status).toBe(500)
      expect(mockFetch).toHaveBeenCalledTimes(4) // 初回 + 既定3リトライ
    })

    it('permanent network error: 最大リトライ後は最後のエラーを rethrow する', async () => {
      _http.sleepFn = vi.fn().mockResolvedValue(undefined)
      mockFetch.mockRejectedValue(new Error('permanent network failure'))

      await expect(fetchWithToS('https://example.com')).rejects.toThrow('permanent network failure')
      expect(mockFetch).toHaveBeenCalledTimes(4)
    })

    it('NICO_HTTP_RETRIES=0 でリトライを無効化できる', async () => {
      process.env.NICO_HTTP_RETRIES = '0'
      _http.sleepFn = vi.fn().mockResolvedValue(undefined)
      mockFetch.mockResolvedValue({ status: 503, headers: { get: () => null } })

      const resp = await fetchWithToS('https://example.com')

      expect(resp.status).toBe(503)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('404 等の非対象ステータスは即返す（リトライしない）', async () => {
      _http.sleepFn = vi.fn().mockResolvedValue(undefined)
      mockFetch.mockResolvedValue({ status: 404, headers: { get: () => null } })

      const resp = await fetchWithToS('https://example.com')

      expect(resp.status).toBe(404)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('jitter は randomFn 注入で決定的（同一シードで同一遅延）', async () => {
      const sleepCalls = []
      _http.sleepFn = vi.fn((ms) => {
        sleepCalls.push(ms)
        return Promise.resolve()
      })
      _http.randomFn = () => 1 // 最大 +20%
      let call = 0
      mockFetch.mockImplementation(() => {
        call++
        return Promise.resolve({ status: call === 1 ? 500 : 200, headers: { get: () => null } })
      })

      const resp = await fetchWithToS('https://example.com')
      expect(resp.status).toBe(200)
      expect(sleepCalls).toContain(2400) // 2000 * 1.2
    })
  })
})
