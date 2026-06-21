// tests/store/project.test.mjs
// プロジェクション（works.json）の firstAt 定義テスト（PH 修正: firstAt = MIN(startTime)）

import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, upsertSeries, upsertEpisodes } from '../../scripts/store/store.mjs'
import { exportWorks } from '../../scripts/store/project.mjs'

function ep(o) {
  return {
    contentId: 'so0',
    seriesId: 1,
    episodeNo: null,
    title: 'X',
    viewCounter: 0,
    prevViewCounter: null,
    commentCounter: 0,
    likeCounter: 0,
    mylistCounter: 0,
    lengthSeconds: 60,
    startTime: '2026-06-10T06:00:00+09:00',
    thumbnailUrl: null,
    description: '',
    tags: [],
    tagsCurated: [],
    lastUpdated: null,
    ...o,
  }
}

async function projectWorks(store) {
  const dir = await mkdtemp(join(tmpdir(), 'proj-'))
  try {
    await exportWorks(store, dir, '2026-06-21T00:00:00Z', new Map())
    const json = JSON.parse(await readFile(join(dir, 'works.json'), 'utf-8'))
    return json.works
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('exportWorks firstAt/latestAt', () => {
  it('firstAt は最古話の投稿時刻（episodeNo の有無に左右されない）', async () => {
    const store = createStore()
    upsertSeries(store, [{ seriesId: 1, title: 'S', isAvailable: true }])
    // 第1〜7話は同日(6/10)・episodeNo=null。最終話だけ episodeNo=18 で後日(6/21)。
    // 旧実装は episodeNo を第1話判定の主キーにしたため firstAt=6/21 に化けた。
    upsertEpisodes(store, [
      ep({ contentId: 'so100', startTime: '2026-06-10T06:00:00+09:00', title: 'S 第1話' }),
      ep({ contentId: 'so101', startTime: '2026-06-11T06:00:00+09:00', title: 'S 第8話' }),
      ep({ contentId: 'so199', startTime: '2026-06-21T06:00:00+09:00', episodeNo: 18, title: 'S 第18話' }),
    ])
    const [w] = await projectWorks(store)
    expect(w.firstAt).toBe('2026-06-10T06:00:00+09:00')
    expect(w.latestAt).toBe('2026-06-21T06:00:00+09:00')
    expect(w.firstContentId).toBe('so100')
  })

  it('同時刻タイは so番号小（先投稿）を firstContentId に採る', async () => {
    const store = createStore()
    upsertSeries(store, [{ seriesId: 1, title: 'S', isAvailable: true }])
    upsertEpisodes(store, [
      ep({ contentId: 'so500', startTime: '2026-06-10T06:00:00+09:00', title: 'S 第3話' }),
      ep({ contentId: 'so498', startTime: '2026-06-10T06:00:00+09:00', title: 'S 第1話' }),
    ])
    const [w] = await projectWorks(store)
    expect(w.firstAt).toBe('2026-06-10T06:00:00+09:00')
    expect(w.firstContentId).toBe('so498')
  })
})
