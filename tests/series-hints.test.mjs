import { describe, expect, it } from 'vitest'

import { mergeSeriesTitleHints } from '../scripts/series-hints.mjs'

describe('series title hints', () => {
  it('list indexへ確認済みIDを併合する', () => {
    const byTitle = new Map()
    const bySeriesId = new Map()
    mergeSeriesTitleHints(byTitle, bySeriesId)

    expect(byTitle.get('魔法少女猫たると')).toBe(572284)
    expect(byTitle.get('渡くんの××が崩壊寸前')).toBe(572266)
    expect(bySeriesId.get(572284)).toBe('魔法少女猫たると')
  })

  it('list.jsonと異なるIDが現れたら黙って上書きしない', () => {
    expect(() => mergeSeriesTitleHints(new Map([['魔法少女猫たると', 999999]]))).toThrow(
      /hint conflict/
    )
  })
})
