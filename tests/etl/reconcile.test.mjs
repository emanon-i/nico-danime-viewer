import { describe, expect, it } from 'vitest'

import {
  findTitleMismatchTargets,
  inferEpisodeNo,
  isSafeTitleFallbackCandidate,
} from '../../scripts/etl/reconcile.mjs'
import {
  createStore,
  moveEpisodeToSeries,
  planAuthoritativeMoves,
  upsertEpisodes,
  upsertSeries,
} from '../../scripts/store/store.mjs'

describe('findTitleMismatchTargets', () => {
  function makeYoujoSenkiStore() {
    const store = createStore()
    upsertSeries(store, [
      { seriesId: 63038, title: '幼女戦記' },
      { seriesId: 569817, title: '幼女戦記Ⅱ' },
    ])
    upsertEpisodes(store, [
      {
        contentId: 'so46522236',
        seriesId: 63038,
        episodeNo: null,
        title: '幼女戦記Ⅱ　第1話　サラマンダー戦闘団',
      },
      {
        contentId: 'so46547458',
        seriesId: 569817,
        episodeNo: null,
        title: '幼女戦記Ⅱ　第2話　ラインの悪魔',
      },
    ])
    const byTitle = new Map([
      ['幼女戦記', 63038],
      ['幼女戦記Ⅱ', 569817],
    ])
    return { store, byTitle }
  }

  it('本番事例: 既知の幼女戦記Ⅱ ID と異なる所属の第1話を優先検証対象にする', () => {
    const { store, byTitle } = makeYoujoSenkiStore()

    expect(findTitleMismatchTargets(store, byTitle)).toEqual([
      { seriesId: 569817, contentIds: ['so46522236'] },
    ])
  })

  it('nvapi が一時的に空でも誤登録が残る限り翌日も同じ対象を返す', () => {
    const { store, byTitle } = makeYoujoSenkiStore()

    expect(planAuthoritativeMoves(store, 569817, [])).toEqual([])
    expect(findTitleMismatchTargets(store, byTitle)).toEqual([
      { seriesId: 569817, contentIds: ['so46522236'] },
    ])
  })

  it('nvapi が contentId を確認したときだけ正シリーズへ移動し、候補から消える', () => {
    const { store, byTitle } = makeYoujoSenkiStore()
    const authoritativeEpisodes = [{ contentId: 'so46522236', episodeNo: 1 }]

    for (const move of planAuthoritativeMoves(store, 569817, authoritativeEpisodes)) {
      moveEpisodeToSeries(store, move.contentId, 569817, move.episodeNo)
    }

    expect(store.episodes.get('so46522236')).toMatchObject({ seriesId: 569817, episodeNo: 1 })
    expect(findTitleMismatchTargets(store, byTitle)).toEqual([])
  })

  it('タイトル候補のシリーズが Store に無い場合は検証対象にしない', () => {
    const { store, byTitle } = makeYoujoSenkiStore()
    store.series.delete(569817)

    expect(findTitleMismatchTargets(store, byTitle)).toEqual([])
  })

  it('短い旧作名への前方一致は偽陽性として除外する', () => {
    const store = createStore()
    upsertSeries(store, [
      { seriesId: 127293, title: 'BUZZER BEATER 2nd Quarter' },
      { seriesId: 96678, title: 'BUZZER BEATER' },
    ])
    upsertEpisodes(store, [
      {
        contentId: 'so32026579',
        seriesId: 127293,
        title: 'BUZZER BEATER 2nd Quarter　第1話　OUT OF BOUNDS',
      },
    ])

    expect(findTitleMismatchTargets(store, new Map([['BUZZER BEATER', 96678]]))).toEqual([])
  })

  it('同名別版への候補は偽陽性として除外する', () => {
    const store = createStore()
    upsertSeries(store, [
      { seriesId: 95774, title: 'どろろ' },
      { seriesId: 303573, title: 'どろろ' },
    ])
    upsertEpisodes(store, [
      { contentId: 'so31969689', seriesId: 95774, title: 'どろろ　第1話　百鬼丸の巻' },
    ])

    expect(findTitleMismatchTargets(store, new Map([['どろろ', 303573]]))).toEqual([])
  })

  it('仮シリーズは確認済みの具体的な候補タイトルへ救済できる', () => {
    const store = createStore()
    upsertSeries(store, [
      { seriesId: -1, title: '魔法少女猫たると　にゃーの２' },
      { seriesId: 572284, title: '魔法少女猫たると' },
    ])
    upsertEpisodes(store, [
      {
        contentId: 'so46602808',
        seriesId: -1,
        title: '魔法少女猫たると　にゃーの２　「さいたさいた」',
      },
    ])
    const ep = store.episodes.get('so46602808')

    expect(isSafeTitleFallbackCandidate(store, ep, 572284, '魔法少女猫たると')).toBe(true)
    expect(inferEpisodeNo(ep.title)).toBe(2)
    expect(inferEpisodeNo('渡くんの××が崩壊寸前　BREAK 13　「本当に好きなの？」')).toBe(13)
  })
})
