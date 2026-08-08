import { describe, expect, it } from 'vitest'

import { findTitleMismatchTargets } from '../../scripts/etl/reconcile.mjs'
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
})
