// tests/store/characterization.test.mjs
// リファクタリング前の特性テスト（prevViewCounter・exportTags 順序）

import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, upsertEpisodes, upsertSeries } from '../../scripts/store/store.mjs'
import { exportTags } from '../../scripts/store/project.mjs'

describe('upsertEpisodes: prevViewCounter', () => {
  it('新規作成時は prevViewCounter=null', () => {
    const store = createStore()
    upsertEpisodes(store, [{ contentId: 'so1', title: 'ep1', viewCounter: 100 }])
    const ep = store.episodes.get('so1')
    expect(ep.viewCounter).toBe(100)
    expect(ep.prevViewCounter).toBeNull()
  })

  it('同値 upsert でも prevViewCounter が現 viewCounter で上書きされる（現行挙動）', () => {
    const store = createStore()
    upsertEpisodes(store, [{ contentId: 'so1', title: 'ep1', viewCounter: 100 }])
    upsertEpisodes(store, [{ contentId: 'so1', viewCounter: 100 }])
    const ep = store.episodes.get('so1')
    expect(ep.prevViewCounter).toBe(100)
  })

  it('viewCounter 変化時に旧値が prevViewCounter に退避される', () => {
    const store = createStore()
    upsertEpisodes(store, [{ contentId: 'so1', title: 'ep1', viewCounter: 100 }])
    upsertEpisodes(store, [{ contentId: 'so1', viewCounter: 100 }])
    upsertEpisodes(store, [{ contentId: 'so1', viewCounter: 120 }])
    const ep = store.episodes.get('so1')
    expect(ep.viewCounter).toBe(120)
    expect(ep.prevViewCounter).toBe(100)
  })
})

describe('exportTags: seriesCount 降順で出力される（重複数なしフィクスチャ）', () => {
  it('タグ A(3) > B(2) > C(1) の順に並ぶ', async () => {
    const store = createStore()
    upsertSeries(store, [
      { seriesId: 1, title: 'S1', isAvailable: true, tags: [{ name: 'A', isCurated: false }] },
      { seriesId: 2, title: 'S2', isAvailable: true, tags: [{ name: 'A', isCurated: false }] },
      { seriesId: 3, title: 'S3', isAvailable: true, tags: [{ name: 'A', isCurated: false }] },
      { seriesId: 4, title: 'S4', isAvailable: true, tags: [{ name: 'B', isCurated: false }] },
      { seriesId: 5, title: 'S5', isAvailable: true, tags: [{ name: 'B', isCurated: false }] },
      { seriesId: 6, title: 'S6', isAvailable: true, tags: [{ name: 'C', isCurated: false }] },
    ])

    const dir = await mkdtemp(join(tmpdir(), 'tags-'))
    try {
      await exportTags(store, dir, '2026-07-04T00:00:00Z', new Map())
      const json = JSON.parse(await readFile(join(dir, 'tags.json'), 'utf-8'))
      expect(json.tags.map((t) => t.name)).toEqual(['A', 'B', 'C'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
