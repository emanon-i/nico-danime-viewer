import { describe, it, expect, beforeEach } from 'vitest'
import {
  stripHtml,
  extractSeriesIdFromUrl,
  deriveSeriesOverviews,
  computeFranchiseKeys,
} from '../../scripts/etl/series.mjs'
import {
  openDatabase,
  createSchema,
  bulkUpsertEpisodes,
  bulkUpsertSeries,
} from '../../scripts/db/db.mjs'

describe('stripHtml (F-0014)', () => {
  it('test_strip_html_in_overview: HTMLタグを除去する', () => {
    expect(stripHtml('<p>テスト</p>')).toBe('テスト')
  })

  it('<br> を改行に変換する', () => {
    expect(stripHtml('行1<br>行2')).toBe('行1\n行2')
  })

  it('HTML実体参照を変換する', () => {
    expect(stripHtml('&amp;&lt;&gt;&quot;')).toBe('&<>"')
  })

  it('null/空文字は空文字を返す', () => {
    expect(stripHtml(null)).toBe('')
    expect(stripHtml('')).toBe('')
  })
})

describe('extractSeriesIdFromUrl (F-0015)', () => {
  it('URL からシリーズIDを数値で抽出する', () => {
    expect(extractSeriesIdFromUrl('https://www.nicovideo.jp/series/12345')).toBe(12345)
  })

  it('不正な URL は null を返す', () => {
    expect(extractSeriesIdFromUrl('https://example.com/foo')).toBeNull()
    expect(extractSeriesIdFromUrl(null)).toBeNull()
  })
})

describe('deriveSeriesOverviews (F-0014)', () => {
  let db

  beforeEach(() => {
    db = openDatabase(':memory:')
    createSchema(db)
    bulkUpsertSeries(db, [{ seriesId: 1, title: 'テストシリーズ' }], '2026-01-01T00:00:00Z')
  })

  it('test_series_overview_from_first_episode: 最古話の description から概要を生成', () => {
    bulkUpsertEpisodes(
      db,
      [
        {
          contentId: 'so1',
          seriesId: 1,
          title: '第1話',
          viewCounter: 100,
          startTime: '2020-01-01T00:00:00+09:00',
          description: '<p>あらすじ</p>',
        },
        {
          contentId: 'so2',
          seriesId: 1,
          title: '第2話',
          viewCounter: 90,
          startTime: '2020-01-08T00:00:00+09:00',
          description: '第2話の説明（混入しない）',
        },
      ],
      '2026-06-16T00:00:00Z'
    )

    const result = deriveSeriesOverviews(db)
    expect(result).toHaveLength(1)
    expect(result[0].seriesId).toBe(1)
    expect(result[0].descriptionFirst).toBe('あらすじ') // HTML除去済み
  })
})

describe('computeFranchiseKeys (F-0017)', () => {
  it('test_franchise_by_shared_tag: 共有タグで束ねる', () => {
    const map = new Map([
      [1, ['アクション', 'ゆるキャン△シリーズ']],
      [2, ['ゆるキャン△シリーズ', 'ほのぼの']],
      [3, ['アクション']],
    ])
    const result = computeFranchiseKeys(map)
    // シリーズ1と2は「ゆるキャン△シリーズ」で束ねられる
    expect(result.get(1)).toBe('ゆるキャン△シリーズ')
    expect(result.get(2)).toBe('ゆるキャン△シリーズ')
  })

  it('test_franchise_null_when_unknown: 共有タグがない場合はマップに含まれない', () => {
    const map = new Map([
      [1, ['固有タグA']],
      [2, ['固有タグB']],
    ])
    const result = computeFranchiseKeys(map)
    // 共有タグなし → franchise_key = NULL（マップに含まれない）
    expect(result.has(1)).toBe(false)
    expect(result.has(2)).toBe(false)
  })

  it('シリーズ正規化タグ（〜シリーズ）が共有タグより優先される', () => {
    const map = new Map([
      [1, ['共有タグ', 'ゆるキャン△シリーズ']],
      [2, ['共有タグ', 'ゆるキャン△シリーズ']],
    ])
    const result = computeFranchiseKeys(map)
    expect(result.get(1)).toBe('ゆるキャン△シリーズ')
    expect(result.get(2)).toBe('ゆるキャン△シリーズ')
  })

  it('2作品以上共有するタグがフランチャイズ候補になる', () => {
    const map = new Map([
      [1, ['共有', 'unique1']],
      [2, ['共有', 'unique2']],
      [3, ['unique3']], // 共有なし
    ])
    const result = computeFranchiseKeys(map)
    expect(result.get(1)).toBe('共有')
    expect(result.get(2)).toBe('共有')
    expect(result.has(3)).toBe(false)
  })
})
