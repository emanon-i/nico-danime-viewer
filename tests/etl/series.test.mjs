import { describe, it, expect, beforeEach } from 'vitest'
import {
  stripHtml,
  extractSeriesIdFromUrl,
  deriveSeriesOverviews,
  computeFranchiseKeys,
  titleStem,
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

describe('computeFranchiseKeys (F-0017 / §15)', () => {
  it('test_franchise_by_series_tag: `〜シリーズ` タグで束ねる（成分内で同一キー）', () => {
    const map = new Map([
      [1, ['アクション', 'ゆるキャン△シリーズ']],
      [2, ['ゆるキャン△シリーズ', 'ほのぼの']],
      [3, ['アクション']],
    ])
    const result = computeFranchiseKeys(map)
    expect(result.get(1)).toBeDefined()
    expect(result.get(1)).toBe(result.get(2)) // 同一フランチャイズ＝同一キー
    expect(result.has(3)).toBe(false)
  })

  it('test_franchise_null_when_unknown: 束ねる手掛かりが無ければマップに含まれない', () => {
    const map = new Map([
      [1, ['固有タグA']],
      [2, ['固有タグB']],
    ])
    const result = computeFranchiseKeys(map)
    expect(result.has(1)).toBe(false)
    expect(result.has(2)).toBe(false)
  })

  it('§15: 声優/汎用の共有タグでは束ねない（誤束ね防止）', () => {
    // 旧実装は 2〜50 件共有タグで束ねていたが、声優名等での誤束ねの主因だったため廃止
    const map = new Map([
      [1, ['岸尾だいすけ', 'unique1']],
      [2, ['岸尾だいすけ', 'unique2']],
    ])
    const result = computeFranchiseKeys(map)
    expect(result.has(1)).toBe(false)
    expect(result.has(2)).toBe(false)
  })

  it('§15: タイトル語幹（続編マーカー除去）で束ねる', () => {
    const tags = new Map([
      [1, ['アクション']],
      [2, ['アクション']],
      [3, ['日常']],
    ])
    const titles = new Map([
      [1, 'SPY×FAMILY'],
      [2, 'SPY×FAMILY Season 2'],
      [3, '全然別の作品'],
    ])
    const result = computeFranchiseKeys(tags, titles)
    expect(result.get(1)).toBeDefined()
    expect(result.get(1)).toBe(result.get(2))
    expect(result.has(3)).toBe(false)
  })

  it('titleStem: 続編/形式マーカーを除去して語幹を返す', () => {
    expect(titleStem('SPY×FAMILY Season 2')).toBe('SPY×FAMILY')
    expect(titleStem('進撃の巨人 The Final Season')).toBe('進撃の巨人')
    expect(titleStem('転生したらスライムだった件 第3期')).toBe('転生したらスライムだった件')
    expect(titleStem('Re:ゼロから始める異世界生活　2nd season')).toBe('Re:ゼロから始める異世界生活')
  })
})
