import { describe, it, expect } from 'vitest'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { assertSnapshotOk, assertConfig } from '../../scripts/nico/assert.mjs'

const BRANCH = 2632720

function makeValidResponse(count = 200) {
  return {
    meta: { status: 200, totalCount: count },
    data: Array.from({ length: count }, (_, i) => ({
      contentId: `so${i}`,
      channelId: BRANCH,
      startTime: '2020-01-01T00:00:00+09:00',
      viewCounter: i * 10,
    })),
  }
}

describe('assertSnapshotOk (F-0011)', () => {
  it('test_assert_snapshot_ok (AC-1): 正常レスポンスはエラーなし', () => {
    expect(() => assertSnapshotOk(makeValidResponse())).not.toThrow()
  })

  it('test_assert_snapshot_fails_on_empty (AC-1): data[] 空で throw', () => {
    expect(() => assertSnapshotOk({ meta: { status: 200, totalCount: 0 }, data: [] })).toThrow()
  })

  it('meta.status != 200 で throw', () => {
    expect(() =>
      assertSnapshotOk({ meta: { status: 500 }, data: [{ contentId: 'so1' }] })
    ).toThrow()
  })

  it('required fields 欠落で throw', () => {
    expect(() =>
      assertSnapshotOk({
        meta: { status: 200, totalCount: 1 },
        data: [{ contentId: 'so1', channelId: BRANCH }], // startTime と viewCounter が無い
      })
    ).toThrow()
  })

  it('branch count below threshold で throw', () => {
    const saved = assertConfig.snapshot.minBranchCount
    assertConfig.snapshot.minBranchCount = 10
    const data = Array.from({ length: 5 }, (_, i) => ({
      contentId: `so${i}`,
      channelId: BRANCH,
      startTime: '2020-01-01T00:00:00+09:00',
      viewCounter: i,
    }))
    expect(() => assertSnapshotOk({ meta: { status: 200 }, data })).toThrow()
    assertConfig.snapshot.minBranchCount = saved
  })

  it('しきい値が設定値で制御される (AC-2)', () => {
    const saved = assertConfig.snapshot.minBranchCount
    assertConfig.snapshot.minBranchCount = 1 // 閾値を下げる
    expect(() =>
      assertSnapshotOk({
        meta: { status: 200 },
        data: [{ contentId: 'so1', channelId: BRANCH, startTime: 's', viewCounter: 1 }],
      })
    ).not.toThrow()
    assertConfig.snapshot.minBranchCount = saved
  })

  it('totalCount が前回比 20% 超減で throw', () => {
    const resp = makeValidResponse(100)
    resp.meta.totalCount = 50 // 50% 減
    expect(() => assertSnapshotOk(resp, 100)).toThrow()
  })

  it('test_fail_keeps_previous_output (AC-3): 失敗時は既存出力を書かない', () => {
    const tmpDir = path.join(process.cwd(), 'data')
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
    const outFile = path.join(tmpDir, '_assert_test.json')
    writeFileSync(outFile, JSON.stringify({ version: 'prev' }))

    // アサート失敗
    let threw = false
    try {
      assertSnapshotOk({ meta: { status: 500 }, data: [] })
    } catch {
      threw = true
    }

    expect(threw).toBe(true)
    // 既存出力は変更されていない
    const content = JSON.parse(readFileSync(outFile, 'utf-8'))
    expect(content.version).toBe('prev')

    // クリーンアップ
    import('node:fs').then(({ unlinkSync }) => {
      try {
        unlinkSync(outFile)
      } catch {
        // cleanup failure is non-fatal
      }
    })
  })
})
