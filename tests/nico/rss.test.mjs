import { describe, it, expect } from 'vitest'
import {
  parseRssXml,
  filterNewRssItems,
  assertRssOk,
  extractWatchId,
  normalizeTitleForMatch,
} from '../../scripts/nico/rss.mjs'

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title><![CDATA[dアニメストア ニコニコ支店の動画]]></title>
    <item>
      <title><![CDATA[ゆるキャン△ 第1話「ふじさんとカレーめん」]]></title>
      <link>https://www.nicovideo.jp/watch/1234567890</link>
      <guid>https://www.nicovideo.jp/watch/1234567890</guid>
      <pubDate>Mon, 16 Jun 2026 10:00:00 +0900</pubDate>
    </item>
    <item>
      <title><![CDATA[ゆるキャン△ 第2話]]></title>
      <link>https://www.nicovideo.jp/watch/9876543210</link>
      <guid>https://www.nicovideo.jp/watch/9876543210</guid>
      <pubDate>Mon, 09 Jun 2026 10:00:00 +0900</pubDate>
    </item>
  </channel>
</rss>`

describe('parseRssXml (F-0019)', () => {
  it('test_parse_rss_xml: CDATA チャンネルタイトルを抽出する', () => {
    const { channelTitle, items } = parseRssXml(SAMPLE_RSS)
    expect(channelTitle).toContain('dアニメストア')
    expect(items).toHaveLength(2)
  })

  it('test_parse_rss_item_fields: title / link / guid / pubDate を抽出する', () => {
    const { items } = parseRssXml(SAMPLE_RSS)
    expect(items[0].title).toContain('ゆるキャン△ 第1話')
    expect(items[0].link).toBe('https://www.nicovideo.jp/watch/1234567890')
    expect(items[0].guid).toBe('https://www.nicovideo.jp/watch/1234567890')
    expect(items[0].pubDate).toContain('2026')
  })
})

describe('filterNewRssItems (F-0019)', () => {
  const items = [
    { guid: 'guid-3', title: '最新' },
    { guid: 'guid-2', title: '2番目' },
    { guid: 'guid-1', title: '旧' },
  ]

  it('test_rss_hwm_filter: lastGuid 以前を除いて新着のみ返す', () => {
    const result = filterNewRssItems(items, 'guid-2')
    expect(result).toHaveLength(1)
    expect(result[0].guid).toBe('guid-3')
  })

  it('lastGuid が null の場合は全件返す（初回）', () => {
    expect(filterNewRssItems(items, null)).toHaveLength(3)
  })

  it('lastGuid が見つからない場合は全件返す', () => {
    expect(filterNewRssItems(items, 'not-exist')).toHaveLength(3)
  })

  it('lastGuid が先頭の場合は空配列', () => {
    expect(filterNewRssItems(items, 'guid-3')).toHaveLength(0)
  })
})

describe('assertRssOk (F-0019)', () => {
  const validItems = [
    { link: 'https://www.nicovideo.jp/watch/12345' },
    { link: 'https://www.nicovideo.jp/watch/67890' },
  ]

  it('test_assert_rss_structure: 正常 RSS はエラーなし', () => {
    expect(() => assertRssOk(validItems, 'dアニメストア ニコニコ支店')).not.toThrow()
  })

  it('channelTitle に dアニメストアがなければ throw', () => {
    expect(() => assertRssOk(validItems, '別のチャンネル')).toThrow('[assert:rss]')
  })

  it('items が空配列なら throw', () => {
    expect(() => assertRssOk([], 'dアニメストア ニコニコ支店')).toThrow('[assert:rss]')
  })

  it('watch URL でない link は throw', () => {
    const badItems = [{ link: 'https://example.com/video/123' }]
    expect(() => assertRssOk(badItems, 'dアニメストア')).toThrow('[assert:rss]')
  })
})

describe('extractWatchId (F-0019)', () => {
  it('test_resolve_watch_id_to_content_id: watch URL から watch_id を抽出する', () => {
    expect(extractWatchId('https://www.nicovideo.jp/watch/1234567890')).toBe('1234567890')
  })

  it('不正な URL は null を返す', () => {
    expect(extractWatchId('https://example.com/foo')).toBeNull()
    expect(extractWatchId(null)).toBeNull()
    expect(extractWatchId('')).toBeNull()
  })
})

describe('normalizeTitleForMatch (F-0019)', () => {
  it('空白を正規化してトリムする', () => {
    expect(normalizeTitleForMatch('  タイトル  ')).toBe('タイトル')
    expect(normalizeTitleForMatch('ゆるキャン△　第1話')).toBe(
      normalizeTitleForMatch('ゆるキャン△ 第1話')
    )
  })

  it('小文字変換する', () => {
    expect(normalizeTitleForMatch('ABC')).toBe('abc')
  })
})
