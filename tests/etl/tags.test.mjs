import { describe, it, expect, beforeEach } from 'vitest'
import {
  normalizeTagName,
  extractTagsFromRaw,
  processEpisodeTags,
  deriveSeriesTags,
} from '../../scripts/etl/tags.mjs'
import {
  openDatabase,
  createSchema,
  bulkUpsertEpisodes,
  bulkUpsertSeries,
} from '../../scripts/db/db.mjs'

describe('normalizeTagName (F-0013)', () => {
  it('全角英数を半角に変換する', () => {
    expect(normalizeTagName('ＳＦ')).toBe('SF')
  })

  it('英小文字を大文字化する', () => {
    expect(normalizeTagName('sf')).toBe('SF')
  })

  it('trim する', () => {
    expect(normalizeTagName('  アクション  ')).toBe('アクション')
  })
})

describe('extractTagsFromRaw (F-0013)', () => {
  it('test_normalize_suffix_curation_tag: 接尾型を除去して分割', () => {
    const { tags, isCurated } = extractTagsFromRaw('ドラマ/青春_dアニメ')
    expect(tags).toEqual(['ドラマ', '青春'])
    expect(isCurated).toBe(true)
  })

  it('test_normalize_suffix_curation_tag: dアニメストア接尾も除去', () => {
    const { tags, isCurated } = extractTagsFromRaw('音楽_dアニメストア')
    expect(tags).toEqual(['音楽'])
    expect(isCurated).toBe(true)
  })

  it('test_normalize_prefix_curation_tag: 接頭型を除去', () => {
    const { tags, isCurated } = extractTagsFromRaw('dアニメ_音楽系')
    expect(tags).toEqual(['音楽系'])
    expect(isCurated).toBe(true)
  })

  it('test_exclude_distributor_tag: 素のdアニメストアは除外', () => {
    const { tags } = extractTagsFromRaw('dアニメストア')
    expect(tags).toHaveLength(0)
  })

  it('通常タグはそのまま返す', () => {
    const { tags, isCurated } = extractTagsFromRaw('アクション')
    expect(tags).toEqual(['アクション'])
    expect(isCurated).toBe(false)
  })
})

describe('processEpisodeTags (F-0013)', () => {
  it('test_tag_alias_and_case_dedup: 重複タグを除去する', () => {
    const result = processEpisodeTags('アクション アクション')
    expect(result).toHaveLength(1)
  })

  it('test_tag_alias_and_case_dedup: 大小・全半角統一で重複を吸収', () => {
    const result = processEpisodeTags('ＳＦ SF')
    // ＳＦ → SF に正規化、SF と同一 → 1件
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('SF')
  })

  it('空文字は空配列を返す', () => {
    expect(processEpisodeTags(null)).toHaveLength(0)
    expect(processEpisodeTags('')).toHaveLength(0)
  })

  it('dアニメ キュレーション + 通常タグを混在処理', () => {
    const result = processEpisodeTags('アクション ドラマ/青春_dアニメ')
    const names = result.map((t) => t.name)
    expect(names).toContain('アクション')
    expect(names).toContain('ドラマ')
    expect(names).toContain('青春')
    expect(result.find((t) => t.name === 'ドラマ')?.isCurated).toBe(true)
    expect(result.find((t) => t.name === 'アクション')?.isCurated).toBe(false)
  })
})

describe('キュレーション is_curated 識別 (F-0013)', () => {
  it('test_curated_is_flagged: is_curated=1 で識別できる', () => {
    const result = processEpisodeTags('ドラマ/青春_dアニメ 冒険')
    const drama = result.find((t) => t.name === 'ドラマ')
    const adventure = result.find((t) => t.name === '冒険')
    expect(drama?.isCurated).toBe(true)
    expect(adventure?.isCurated).toBe(false)
  })
})

describe('deriveSeriesTags (F-0013)', () => {
  let db

  beforeEach(() => {
    db = openDatabase(':memory:')
    createSchema(db)
    bulkUpsertSeries(db, [{ seriesId: 1, title: 'テスト' }], '2026-01-01T00:00:00Z')
  })

  it('test_series_tags_from_first_episode: 最古話のタグを使う（第2話以降は混入しない）', () => {
    bulkUpsertEpisodes(
      db,
      [
        {
          contentId: 'so1',
          seriesId: 1,
          title: '第1話',
          viewCounter: 100,
          startTime: '2020-01-01T00:00:00+09:00',
          tags: 'アクション',
        },
        {
          contentId: 'so2',
          seriesId: 1,
          title: '第2話',
          viewCounter: 90,
          startTime: '2020-01-08T00:00:00+09:00',
          tags: '第2話専用タグ',
        },
      ],
      '2026-06-16T00:00:00Z'
    )

    const result = deriveSeriesTags(db)
    expect(result).toHaveLength(1)
    const tagNames = result[0].tags.map((t) => t.name)
    expect(tagNames).toContain('アクション')
    expect(tagNames).not.toContain('第2話専用タグ')
  })
})
