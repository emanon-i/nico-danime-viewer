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
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    _http.sleepFn = (ms) => new Promise((r) => setTimeout(r, ms))
    _http.nowFn = () => Date.now()
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

  it('test_503_backoff (AC-3)', async () => {
    const sleepCalls = []
    _http.sleepFn = vi.fn((ms) => {
      sleepCalls.push(ms)
      return Promise.resolve()
    })
    _http.backoff503Ms = 300000

    let call = 0
    mockFetch.mockImplementation(() => {
      call++
      return Promise.resolve({ status: call === 1 ? 503 : 200 })
    })

    const resp = await fetchWithToS('https://example.com')

    expect(resp.status).toBe(200)
    expect(call).toBe(2) // 元 + リトライ
    expect(sleepCalls).toContain(300000) // 5分バックオフ

    _http.backoff503Ms = 5 * 60 * 1000
  })

  it('passes extra headers (e.g. If-Modified-Since for conditional GET)', async () => {
    await fetchWithToS('https://example.com', {
      headers: { 'If-Modified-Since': 'Mon, 01 Jan 2024 00:00:00 GMT' },
    })
    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.headers['If-Modified-Since']).toBe('Mon, 01 Jan 2024 00:00:00 GMT')
    expect(opts.headers['User-Agent']).toBeTruthy()
  })
})
