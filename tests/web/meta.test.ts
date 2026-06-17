import { describe, it, expect } from 'vitest'
import {
  formatNumberFull,
  formatDateTime,
  formatDuration,
  formatViews,
} from '../../web/src/components/meta'

describe('formatNumberFull（詳細用・カンマ区切り実値・§F）', () => {
  it('丸めずカンマ区切りで返す', () => {
    expect(formatNumberFull(3083914)).toBe('3,083,914')
    expect(formatNumberFull(900)).toBe('900')
    expect(formatNumberFull(0)).toBe('0')
  })
  it('一覧用 formatViews は従来どおり概数（圧縮）', () => {
    expect(formatViews(3083914)).toContain('万') // 詳細とは別＝圧縮のまま
  })
})

describe('formatDateTime（詳細用・正確日時 JST・§F）', () => {
  it('YYYY/M/D H:MM（JST）で返す', () => {
    // +09:00 の 0:30 → JST 0:30
    expect(formatDateTime('2026-06-16T00:30:00+09:00')).toBe('2026/6/16 0:30')
    // UTC 表記でも JST に変換（15:30Z = 翌0:30 JST）
    expect(formatDateTime('2026-06-15T15:30:00Z')).toBe('2026/6/16 0:30')
  })
  it('不正な入力は空文字', () => {
    expect(formatDateTime('')).toBe('')
    expect(formatDateTime('not-a-date')).toBe('')
  })
})

describe('formatDuration（実値・詳細でもそのまま）', () => {
  it('分・時間表記', () => {
    expect(formatDuration(24 * 60)).toBe('24分')
    expect(formatDuration(90 * 60)).toBe('1時間30分')
  })
})
