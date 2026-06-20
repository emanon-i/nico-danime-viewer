import { describe, it, expect } from 'vitest'
import {
  coursFromTags,
  normalizeTitleForMatch,
  deriveCoursFromTagsFromStore,
} from '../../scripts/etl/cours.mjs'

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

describe('normalizeTitleForMatch', () => {
  it('全角スペース・記号を半角スペースに畳んで trim する', () => {
    expect(normalizeTitleForMatch('ゆるキャン△　SEASON 3')).toBe('ゆるキャン△ season 3')
  })

  it('【】・「」・（）・句読点・！？を除去する', () => {
    expect(normalizeTitleForMatch('【アニメ】ソードアート・オンライン！')).toBe(
      'アニメ ソードアート オンライン'
    )
  })

  it('null は空文字に変換する', () => {
    expect(normalizeTitleForMatch(null)).toBe('')
  })

  it('undefined は空文字に変換する', () => {
    expect(normalizeTitleForMatch(undefined)).toBe('')
  })

  it('英字を小文字化する', () => {
    expect(normalizeTitleForMatch('ISEKAI')).toBe('isekai')
  })

  it('末尾スペースを trim する', () => {
    expect(normalizeTitleForMatch('タイトル  ')).toBe('タイトル')
  })
})

describe('deriveCoursFromTagsFromStore', () => {
  // chronoSort: startTime 昇順（古いほど小さい）
  const chronoSort = (a, b) => {
    const at = a.startTime ?? ''
    const bt = b.startTime ?? ''
    return at < bt ? -1 : at > bt ? 1 : 0
  }

  const makeStore = (seriesList, episodeList) => ({
    series: new Map(seriesList.map((s) => [s.seriesId, s])),
    episodes: new Map(episodeList.map((ep) => [ep.contentId, ep])),
  })

  it('isAvailable なシリーズの第1話タグからクールを導出する', () => {
    const store = makeStore(
      [{ seriesId: 1, isAvailable: true }],
      [
        {
          contentId: 'so1',
          seriesId: 1,
          tags: ['2022年秋アニメ', 'ほのぼの'],
          startTime: '2022-10-01T00:00:00+09:00',
        },
      ]
    )
    const result = deriveCoursFromTagsFromStore(store, chronoSort)
    expect(result.get(1)).toBe('2022-秋')
  })

  it('isAvailable=false のシリーズはスキップする', () => {
    const store = makeStore(
      [{ seriesId: 2, isAvailable: false }],
      [
        {
          contentId: 'so2',
          seriesId: 2,
          tags: ['2023年春アニメ'],
          startTime: '2023-04-01T00:00:00+09:00',
        },
      ]
    )
    const result = deriveCoursFromTagsFromStore(store, chronoSort)
    expect(result.has(2)).toBe(false)
  })

  it('複数エピソードがある場合は最古話のタグを採用する', () => {
    const store = makeStore(
      [{ seriesId: 3, isAvailable: true }],
      [
        {
          contentId: 'so31',
          seriesId: 3,
          tags: ['2024年春アニメ'],
          startTime: '2024-04-01T00:00:00+09:00',
        },
        {
          contentId: 'so32',
          seriesId: 3,
          tags: ['2024年夏アニメ'],
          startTime: '2024-07-01T00:00:00+09:00',
        },
      ]
    )
    const result = deriveCoursFromTagsFromStore(store, chronoSort)
    expect(result.get(3)).toBe('2024-春')
  })

  it('季タグがないシリーズは結果に含まれない', () => {
    const store = makeStore(
      [{ seriesId: 4, isAvailable: true }],
      [
        {
          contentId: 'so4',
          seriesId: 4,
          tags: ['アクション', 'バトル'],
          startTime: '2022-01-01T00:00:00+09:00',
        },
      ]
    )
    const result = deriveCoursFromTagsFromStore(store, chronoSort)
    expect(result.has(4)).toBe(false)
  })

  it('エピソードが 0 件のシリーズはスキップする', () => {
    const store = makeStore([{ seriesId: 5, isAvailable: true }], [])
    const result = deriveCoursFromTagsFromStore(store, chronoSort)
    expect(result.has(5)).toBe(false)
  })

  it('_dアニメストア 接尾タグでも正しく導出する', () => {
    const store = makeStore(
      [{ seriesId: 6, isAvailable: true }],
      [
        {
          contentId: 'so6',
          seriesId: 6,
          tags: ['2025年夏アニメ_dアニメストア', '日常'],
          startTime: '2025-07-01T00:00:00+09:00',
        },
      ]
    )
    const result = deriveCoursFromTagsFromStore(store, chronoSort)
    expect(result.get(6)).toBe('2025-夏')
  })
})
