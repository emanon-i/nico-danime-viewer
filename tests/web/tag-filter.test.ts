import { describe, it, expect } from 'vitest'
import {
  isCoursTag,
  isStructuralTag,
  isHiddenTag,
  withoutHiddenTagNames,
} from '../../web/src/shared/tag-filter'

describe('isStructuralTag（構造的定番タグ・§C）', () => {
  it('最終回系を構造タグと判定する', () => {
    for (const t of ['最終回', 'いい最終回だった', '1期最終回', '本編最終回', '感動の最終回']) {
      expect(isStructuralTag(t)).toBe(true)
    }
  })

  it('神回系を構造タグと判定する（ただし「神回避」は除外しない）', () => {
    expect(isStructuralTag('神回')).toBe(true)
    expect(isStructuralTag('超神回')).toBe(true)
    expect(isStructuralTag('約束された神回')).toBe(true)
    // 「神回避」は別語（神＋回避）＝内容/ミーム → 構造タグにしない
    expect(isStructuralTag('神回避')).toBe(false)
  })

  it('記念回・総集編・各話番号を構造タグと判定する', () => {
    expect(isStructuralTag('記念回')).toBe(true)
    expect(isStructuralTag('総集編')).toBe(true)
    expect(isStructuralTag('第100話')).toBe(true)
    expect(isStructuralTag('100話')).toBe(true)
    expect(isStructuralTag('#12')).toBe(true)
  })

  it('内容タグ（水着回・ジャンル等）は構造タグにしない＝残す', () => {
    for (const t of [
      '水着回',
      'お風呂/温泉',
      'SF/ファンタジー',
      'アクション/バトル',
      '日常/ほのぼの',
      'コメディ/ギャグ',
      '1話完結おすすめ話',
      '文化祭/ライブ/劇',
    ]) {
      expect(isStructuralTag(t)).toBe(false)
    }
  })
})

describe('isHiddenTag / withoutHiddenTagNames（UI 非表示＝クール＋構造）', () => {
  it('クール由来も構造的定番も隠す', () => {
    expect(isHiddenTag('2026年春アニメ')).toBe(true) // クール（§68）
    expect(isHiddenTag('最終回')).toBe(true) // 構造（§C）
    expect(isHiddenTag('SF/ファンタジー')).toBe(false) // 内容＝残す
    expect(isHiddenTag('水着回')).toBe(false)
  })

  it('withoutHiddenTagNames は非表示タグを除く', () => {
    const got = withoutHiddenTagNames([
      'SF/ファンタジー',
      '最終回',
      '2025年冬アニメ',
      '水着回',
      '神回',
    ])
    expect(got).toEqual(['SF/ファンタジー', '水着回'])
  })

  it('isCoursTag は従来どおりクールのみ（構造は判定しない）', () => {
    expect(isCoursTag('2026年春アニメ')).toBe(true)
    expect(isCoursTag('最終回')).toBe(false)
  })
})
