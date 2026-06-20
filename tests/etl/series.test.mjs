import { describe, it, expect } from 'vitest'
import {
  stripHtml,
  extractSeriesIdFromUrl,
  computeFranchiseKeys,
  titleStem,
} from '../../scripts/etl/series.mjs'

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
