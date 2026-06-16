import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readdirSync } from 'node:fs'
import { logger } from '../scripts/lib/logger.mjs'

describe('structured logger (F-0004)', () => {
  let stdoutSpy
  let stderrSpy
  const savedLevel = process.env.LOG_LEVEL

  beforeEach(() => {
    delete process.env.LOG_LEVEL
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (savedLevel === undefined) delete process.env.LOG_LEVEL
    else process.env.LOG_LEVEL = savedLevel
  })

  it('outputs JSON line with ts/level/source/message keys (AC-1)', () => {
    logger.info('snapshot', 'test message')
    expect(stdoutSpy).toHaveBeenCalledOnce()
    const line = String(stdoutSpy.mock.calls[0][0]).trim()
    const parsed = JSON.parse(line)
    expect(parsed).toMatchObject({ level: 'info', source: 'snapshot', message: 'test message' })
    expect(typeof parsed.ts).toBe('string')
  })

  it('includes extra fields in output', () => {
    logger.info('src', 'msg', { count: 42, key: 'val' })
    const parsed = JSON.parse(String(stdoutSpy.mock.calls[0][0]).trim())
    expect(parsed.count).toBe(42)
    expect(parsed.key).toBe('val')
  })

  it('test_change_detection_log_fields (AC-2)', () => {
    logger.warn('snapshot', 'change detection failed', {
      sourceName: 'snapshot',
      expectedMin: 1000,
      actual: 0,
      context: 'totalCount dropped below threshold',
    })
    const parsed = JSON.parse(String(stderrSpy.mock.calls[0][0]).trim())
    expect(parsed.sourceName).toBe('snapshot')
    expect(parsed.expectedMin).toBe(1000)
    expect(parsed.actual).toBe(0)
    expect(parsed.context).toBe('totalCount dropped below threshold')
  })

  it('warn/error go to stderr, info/debug go to stdout', () => {
    logger.warn('s', 'w')
    expect(stderrSpy).toHaveBeenCalledOnce()
    expect(stdoutSpy).not.toHaveBeenCalled()

    vi.clearAllMocks()
    logger.error('s', 'e')
    expect(stderrSpy).toHaveBeenCalledOnce()

    vi.clearAllMocks()
    logger.debug('s', 'd')
    // debug is suppressed by default (level=info)
    expect(stdoutSpy).not.toHaveBeenCalled()
  })

  it('LOG_LEVEL=warn suppresses info (AC-3)', () => {
    process.env.LOG_LEVEL = 'warn'
    logger.info('test', 'should be suppressed')
    expect(stdoutSpy).not.toHaveBeenCalled()
    logger.warn('test', 'should appear')
    expect(stderrSpy).toHaveBeenCalledOnce()
  })

  it('no log files created after logging (F-0005 AC-1)', () => {
    const before = readdirSync('.').filter((f) => f.endsWith('.log'))
    logger.info('test', 'no file should be created')
    const after = readdirSync('.').filter((f) => f.endsWith('.log'))
    expect(after.length).toBe(before.length)
  })
})
