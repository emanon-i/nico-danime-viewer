import { describe, it, expect } from 'vitest'
import {
  normalizeTagName,
  extractTagsFromRaw,
  processEpisodeTags,
} from '../../scripts/etl/tags.mjs'

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
  it('test_normalize_suffix_curation_tag: 接尾型を除去（/ では分割しない）', () => {
    const { tags, isCurated } = extractTagsFromRaw('ドラマ/青春_dアニメ')
    expect(tags).toEqual(['ドラマ/青春'])
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

  it('dアニメ キュレーション + 通常タグを混在処理（/ は結合タグのまま）', () => {
    const result = processEpisodeTags('アクション ドラマ/青春_dアニメ')
    const names = result.map((t) => t.name)
    expect(names).toContain('アクション')
    expect(names).toContain('ドラマ/青春')
    expect(result.find((t) => t.name === 'ドラマ/青春')?.isCurated).toBe(true)
    expect(result.find((t) => t.name === 'アクション')?.isCurated).toBe(false)
  })

  it('ノイズタグ「アニメ」「第1話/第一話」を除外する（§27・全半角とも）', () => {
    const names = processEpisodeTags('アニメ 第1話 第１話 第一話 日常').map((t) => t.name)
    expect(names).not.toContain('アニメ')
    expect(names).not.toContain('第1話')
    expect(names).not.toContain('第一話')
    expect(names).toContain('日常')
  })

  it('作品名そのもののタグは除外される（§2(b)）', () => {
    const result = processEpisodeTags(
      'ぼっち・ざ・ろっく！ 日常/ほのぼの_dアニメ',
      'ぼっち・ざ・ろっく！'
    )
    const names = result.map((t) => t.name)
    expect(names).not.toContain('ぼっち・ざ・ろっく！')
    expect(names).toContain('日常/ほのぼの')
  })
})

describe('キュレーション is_curated 識別 (F-0013)', () => {
  it('test_curated_is_flagged: is_curated=1 で識別できる', () => {
    const result = processEpisodeTags('ドラマ/青春_dアニメ 冒険')
    const drama = result.find((t) => t.name === 'ドラマ/青春')
    const adventure = result.find((t) => t.name === '冒険')
    expect(drama?.isCurated).toBe(true)
    expect(adventure?.isCurated).toBe(false)
  })
})
