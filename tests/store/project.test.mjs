// tests/store/project.test.mjs
// プロジェクション（works.json）の firstAt 定義テスト（PH 修正: firstAt = MIN(startTime)）

import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, upsertSeries, upsertEpisodes } from '../../scripts/store/store.mjs'
import { exportWorks, exportNew } from '../../scripts/store/project.mjs'

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
      ep({
        contentId: 'so199',
        startTime: '2026-06-21T06:00:00+09:00',
        episodeNo: 18,
        title: 'S 第18話',
      }),
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

describe('exportNew pubDate 時系列ソート（④-1 RFC822 文字列ソートバグ）', () => {
  async function projectNew(store) {
    const dir = await mkdtemp(join(tmpdir(), 'new-'))
    try {
      await exportNew(store, dir, '2026-06-26T00:00:00Z')
      return JSON.parse(await readFile(join(dir, 'new.json'), 'utf-8')).items
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('RFC822 pubDate を時系列 DESC で並べる（曜日名の文字列比較に陥らない）', async () => {
    const store = createStore()
    // 曜日名で文字列ソートすると Wed(6/24) が Thu(6/25) より前に来てしまう実バグの再現データ。
    store.rss.set('w1', {
      watchId: 'w1',
      pubDate: 'Wed, 24 Jun 2026 22:30:00 +0900',
      resolutionStatus: 'resolved',
      title: '24日',
    })
    store.rss.set('w2', {
      watchId: 'w2',
      pubDate: 'Thu, 25 Jun 2026 22:30:00 +0900',
      resolutionStatus: 'resolved',
      title: '25日(最新)',
    })
    store.rss.set('w3', {
      watchId: 'w3',
      pubDate: 'Mon, 16 Jun 2026 15:00:00 +0900',
      resolutionStatus: 'resolved',
      title: '16日(最古)',
    })
    const items = await projectNew(store)
    expect(items.map((x) => x.watchId)).toEqual(['w2', 'w1', 'w3'])
    expect(items[0].title).toBe('25日(最新)')
  })

  it('pubDate 欠落/不正は末尾へ送る', async () => {
    const store = createStore()
    store.rss.set('a', {
      watchId: 'a',
      pubDate: 'Thu, 25 Jun 2026 22:30:00 +0900',
      resolutionStatus: 'resolved',
    })
    store.rss.set('b', { watchId: 'b', pubDate: null, resolutionStatus: 'pending' })
    const items = await projectNew(store)
    expect(items[0].watchId).toBe('a')
    expect(items[items.length - 1].watchId).toBe('b')
  })
})
