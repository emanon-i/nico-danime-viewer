import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseRssXml,
  filterNewRssItems,
  assertRssOk,
  extractWatchId,
  normalizeTitleForMatch,
  resolveRssItems,
} from '../../scripts/nico/rss.mjs'
import {
  openDatabase,
  createSchema,
  bulkUpsertEpisodes,
  bulkUpsertRssItems,
  pruneRssItems,
} from '../../scripts/db/db.mjs'

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

describe('resolveRssItems (F-0019)', () => {
  let db

  beforeEach(() => {
    db = openDatabase(':memory:')
    createSchema(db)
  })

  it('test_rss_title_match: タイトル正規化突合で contentId を解決する', () => {
    // episodes に突合先を追加
    bulkUpsertEpisodes(
      db,
      [
        {
          contentId: 'so1001',
          title: 'ゆるキャン△ 第1話',
          viewCounter: 100,
          startTime: '2026-06-01T00:00:00+09:00',
        },
      ],
      '2026-06-16T00:00:00Z'
    )

    // rss_items に未解決アイテムを追加
    bulkUpsertRssItems(db, [
      {
        watchId: '9876543210',
        title: 'ゆるキャン△ 第1話',
        pubDate: '2026-06-01T10:00:00+09:00',
        guid: null,
        titleNorm: null,
        link: null,
      },
    ])

    resolveRssItems(db)

    const resolved = db.prepare('SELECT * FROM rss_items WHERE watch_id = ?').get('9876543210')
    expect(resolved.resolution_status).toBe('resolved')
    expect(resolved.resolved_content_id).toBe('so1001')
  })

  it('test_rss_only_when_no_match: エピソードにないタイトルは rss_only', () => {
    bulkUpsertRssItems(db, [
      {
        watchId: '1111111111',
        title: '存在しないアニメ 第1話',
        pubDate: '2026-06-01T10:00:00+09:00',
        guid: null,
        titleNorm: null,
        link: null,
      },
    ])

    resolveRssItems(db)

    const item = db.prepare('SELECT * FROM rss_items WHERE watch_id = ?').get('1111111111')
    expect(item.resolution_status).toBe('rss_only')
    expect(item.resolved_content_id).toBeNull()
  })
})

describe('pruneRssItems（rss_items 有界化・運用監査）', () => {
  let db

  beforeEach(() => {
    db = openDatabase(':memory:')
    createSchema(db)
  })

  it('watch_id 降順で最新 keep 件だけ残し古いものを削除する', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      watchId: String(1000 + i), // 1000..1009（大きいほど新しい）
      title: `動画${i}`,
      pubDate: '2026-06-01T10:00:00+09:00',
      guid: null,
      titleNorm: null,
      link: null,
    }))
    bulkUpsertRssItems(db, rows)
    const removed = pruneRssItems(db, 3)
    expect(removed).toBe(7)
    const kept = db
      .prepare('SELECT watch_id FROM rss_items ORDER BY CAST(watch_id AS INTEGER) DESC')
      .all()
      .map((r) => r.watch_id)
    expect(kept).toEqual(['1009', '1008', '1007']) // 最新 3 件だけ残る
  })

  it('keep 件以下なら何も削除しない', () => {
    bulkUpsertRssItems(db, [
      { watchId: '5', title: 'a', pubDate: 'x', guid: null, titleNorm: null, link: null },
      { watchId: '6', title: 'b', pubDate: 'x', guid: null, titleNorm: null, link: null },
    ])
    expect(pruneRssItems(db, 500)).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM rss_items').get().c).toBe(2)
  })
})
