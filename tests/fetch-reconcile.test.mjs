import { describe, expect, it, vi } from 'vitest'

import { _reconcilePostRescueMismatches } from '../scripts/fetch.mjs'
import { createStore, upsertEpisodes, upsertSeries } from '../scripts/store/store.mjs'

describe('_reconcilePostRescueMismatches', () => {
  it('A2 が第1期へ再投入した第2期12話を同じrun内で戻し、相対話数を復元する', async () => {
    const store = createStore()
    upsertSeries(store, [
      { seriesId: 109057, title: 'テイルズ オブ ゼスティリア ザ クロス' },
      { seriesId: 109065, title: 'テイルズ オブ ゼスティリア ザ クロス　第2期' },
    ])
    upsertEpisodes(store, [
      {
        contentId: 'so36357921',
        seriesId: 109065,
        episodeNo: null,
        title: 'テイルズ オブ ゼスティリア ザ クロス　第2期　第14話(#13)　穢れなき世界',
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        contentId: `wrong-${index + 2}`,
        seriesId: 109057,
        episodeNo: null,
        title: `テイルズ オブ ゼスティリア ザ クロス\u3000第2期\u3000第${index + 15}話(#${index + 14})`,
      })),
    ])

    const byTitle = new Map([
      ['テイルズ オブ ゼスティリア ザ クロス', 109057],
      ['テイルズ オブ ゼスティリア ザ クロス　第2期', 109065],
    ])
    const bySeriesId = new Map([...byTitle].map(([title, seriesId]) => [seriesId, title]))
    const fetchSeries = vi.fn().mockResolvedValue({
      detail: {
        title: 'テイルズ オブ ゼスティリア ザ クロス 第2期',
        owner: { channel: { id: 'ch2632720' } },
      },
      items: [],
    })

    await _reconcilePostRescueMismatches(store, byTitle, bySeriesId, fetchSeries)

    const targetEpisodes = [...store.episodes.values()]
      .filter((ep) => ep.seriesId === 109065)
      .sort((a, b) => a.episodeNo - b.episodeNo)
    expect(fetchSeries).toHaveBeenCalledOnce()
    expect(fetchSeries).toHaveBeenCalledWith(109065)
    expect(targetEpisodes).toHaveLength(13)
    expect(targetEpisodes.map((ep) => ep.episodeNo)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ])
    expect([...store.episodes.values()].filter((ep) => ep.seriesId === 109057)).toHaveLength(0)
  })
})
