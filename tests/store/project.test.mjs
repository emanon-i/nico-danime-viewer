// tests/store/project.test.mjs
// プロジェクション（works.json）の firstAt 定義テスト（PH 修正: firstAt = MIN(startTime)）

import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, upsertSeries, upsertEpisodes } from '../../scripts/store/store.mjs'
import { exportWorks, exportNew, exportWorksPartial } from '../../scripts/store/project.mjs'

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

describe('exportWorksPartial creditNames マージ（既存表示名を優先・恒久決定化）', () => {
  it('毎時 partial は既存 key の表示名を上書きせず、未知 key だけ追加・既存は欠落させない', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'partial-'))
    try {
      // 既存 works.json（前回ビルド）: type-moon=正規 casing、別 partial に出ない key も保持されること。
      await writeFile(
        join(dir, 'works.json'),
        JSON.stringify({
          lastUpdated: '2026-06-20T00:00:00Z',
          works: [{ seriesId: 2, title: '別作品', credits: ['other-only'] }],
          creditNames: { 'type-moon': 'TYPE-MOON', 'other-only': '別表記スタジオ' },
        })
      )

      // 今回の毎時対象（seriesId=1）: 1話目に casing 違いの Type-Moon と新規 key（諏訪部 順一）。
      const store = createStore()
      upsertSeries(store, [{ seriesId: 1, title: 'S', isAvailable: true }])
      upsertEpisodes(store, [
        ep({
          contentId: 'so100',
          seriesId: 1,
          description: 's。\n\n原作:Type-Moon／声の出演:諏訪部 順一',
        }),
      ])

      await exportWorksPartial(store, new Set([1]), dir, '2026-06-21T00:00:00Z')
      const json = JSON.parse(await readFile(join(dir, 'works.json'), 'utf-8'))

      // 既存 casing は不変（partial の 'Type-Moon' で上書きしない）
      expect(json.creditNames['type-moon']).toBe('TYPE-MOON')
      // 既存に無い key は partial から追加（key≠display）
      expect(json.creditNames['諏訪部順一']).toBe('諏訪部 順一')
      // partial 非対象の既存 key は carry-forward（欠落しない）
      expect(json.creditNames['other-only']).toBe('別表記スタジオ')
      // key/フィルタは決定的: 対象シリーズの credits は再算出されている
      const w1 = json.works.find((w) => w.seriesId === 1)
      expect(w1.credits).toContain('type-moon')
      expect(w1.credits).toContain('諏訪部順一')
      // 既存シリーズ2も保持
      expect(json.works.find((w) => w.seriesId === 2)).toBeTruthy()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
