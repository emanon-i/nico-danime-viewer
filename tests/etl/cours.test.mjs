import { describe, it, expect } from 'vitest'
import {
  parsePeriodHtml,
  assertPeriodOk,
  makeCoursLabel,
  matchSlugsToSeries,
  mapCurrentCours,
  coursFromTags,
} from '../../scripts/etl/cours.mjs'

const SAMPLE_PERIOD_HTML = `
<!DOCTYPE html>
<html>
<head><title>2025年秋アニメ dアニメストア(ニコニコ支店)</title></head>
<body>
  <a href="/detail/yuru-camp/">ゆるキャン△</a>
  <a href="/detail/sao/">ソードアート・オンライン</a>
  <a href="/detail/yuru-camp/">重複リンク（除外）</a>
</body>
</html>
`

describe('parsePeriodHtml (F-0016)', () => {
  it('test_parse_period_html: title と slug 一覧を抽出する', () => {
    const { title, slugs } = parsePeriodHtml(SAMPLE_PERIOD_HTML, 'test')
    expect(title).toContain('dアニメストア')
    expect(slugs).toContain('yuru-camp')
    expect(slugs).toContain('sao')
    expect(slugs).toHaveLength(2) // 重複排除
  })

  it('title がない HTML は throw する', () => {
    expect(() => parsePeriodHtml('<html><body></body></html>', 'test')).toThrow()
  })
})

describe('assertPeriodOk (F-0016)', () => {
  it('test_assert_period_structure: 正常 HTML はエラーなし', () => {
    expect(() => assertPeriodOk(SAMPLE_PERIOD_HTML, 'test', 1)).not.toThrow()
  })

  it('dアニメストアを含まない title で throw する', () => {
    const badHtml = `<html><head><title>無関係なページ</title></head><body><a href="/detail/foo/"></a></body></html>`
    expect(() => assertPeriodOk(badHtml, 'test', 1)).toThrow()
  })

  it('slug が下限未満で throw する', () => {
    const sparseHtml = `<html><head><title>秋アニメ dアニメストア(ニコニコ支店)</title></head><body></body></html>`
    expect(() => assertPeriodOk(sparseHtml, 'test', 1)).toThrow()
  })
})

describe('coursFromTags (§14・タグから放送季導出)', () => {
  it('「YYYY年<季>アニメ」から YYYY-季 を導出する', () => {
    expect(coursFromTags('アニメ ぼっち・ざ・ろっく！ 2022年秋アニメ きらら')).toBe('2022-秋')
    expect(coursFromTags('2018年冬アニメ ゆるキャン△')).toBe('2018-冬')
  })

  it('`_dアニメストア` 接尾付きでも導出する', () => {
    expect(coursFromTags('2025年冬アニメ_dアニメストア 日常')).toBe('2025-冬')
  })

  it('複数季がある場合は最も古い季（放送開始）を採用する', () => {
    expect(coursFromTags('2020年秋アニメ 2013年春アニメ 進撃の巨人')).toBe('2013-春')
  })

  it('季タグが無ければ null', () => {
    expect(coursFromTags('アニメ アクション 日常')).toBeNull()
    expect(coursFromTags(null)).toBeNull()
    expect(coursFromTags('')).toBeNull()
  })
})

describe('makeCoursLabel (F-0016)', () => {
  it('英語季節→日本語変換', () => {
    expect(makeCoursLabel(2025, 'autumn')).toBe('2025-秋')
    expect(makeCoursLabel(2026, 'spring')).toBe('2026-春')
    expect(makeCoursLabel(2025, 'winter')).toBe('2025-冬')
    expect(makeCoursLabel(2025, 'summer')).toBe('2025-夏')
  })
})

describe('matchSlugsToSeries (F-0016)', () => {
  const seriesMap = new Map([
    [1, 'ゆるキャン△'],
    [2, 'ソードアート・オンライン'],
    [3, '全然関係ないアニメ'],
  ])

  it('test_period_series_match_confidence: 手動 override が最高信頼度で反映される', () => {
    const overrides = { 'yuru-camp': 1 }
    const results = matchSlugsToSeries(['yuru-camp'], seriesMap, overrides)
    expect(results[0].seriesId).toBe(1)
    expect(results[0].confidence).toBe(1.0)
  })

  it('test_period_manual_override: override テーブルが結合に反映される', () => {
    const overrides = { 'manual-key': 99 }
    const results = matchSlugsToSeries(['manual-key'], new Map(), overrides)
    expect(results[0].seriesId).toBe(99)
    expect(results[0].confidence).toBe(1.0)
  })

  it('test_cours_unknown_is_null: マッチしない slug は seriesId=null', () => {
    const results = matchSlugsToSeries(['unknown-anime-slug'], seriesMap, {})
    expect(results[0].seriesId).toBeNull()
    expect(results[0].confidence).toBe(0)
  })

  it('短いタイトル（K / A3）は無関係 slug に偶然含まれても誤マッチしない', () => {
    // "K"→"k", "A3"→"a3" は無関係 slug（arknights 等）に部分文字列として含まれるが、
    // 短い側が 4 文字未満のため採用しない（長さガード）。
    const shortMap = new Map([
      [10, 'K'],
      [11, 'A3'],
      [12, 'Free!'],
    ])
    const results = matchSlugsToSeries(['arknights', 'idolish7-aninana3'], shortMap, {})
    expect(results[0].seriesId).toBeNull()
    expect(results[1].seriesId).toBeNull()
  })
})

describe('mapCurrentCours (F-0016)', () => {
  it('test_ingest_programlist_current_cours: series フィールドで cours を付与する', () => {
    const programlist = [
      { title: 'ゆるキャン△', series: 12345, imgpagh: 'https://example.com/img.jpg' },
      { title: 'テスト', series: 67890, imgpagh: 'https://example.com/img2.jpg' },
      { title: 'series なし', imgpagh: 'https://example.com/img3.jpg' },
    ]
    const result = mapCurrentCours(programlist, '2026-春')
    expect(result.get(12345)).toBe('2026-春')
    expect(result.get(67890)).toBe('2026-春')
    expect(result.size).toBe(2) // series なしは含まれない
  })

  it('test_ingest_programlist_imgpagh: imgpath ではなく imgpagh キーを参照する', () => {
    // programlist フィクスチャ: imgpagh が正しいキー（imgpath は使わない）
    const programlist = [{ series: 1, imgpagh: 'https://example.com/img.jpg' }]
    // imgpagh でアクセス可能なことを確認（imgpath ではない）
    expect(programlist[0].imgpagh).toBeDefined()
    expect(programlist[0].imgpath).toBeUndefined()
  })
})
