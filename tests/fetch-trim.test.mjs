// tests/fetch-trim.test.mjs
// _trimRss の日付比較バグ回帰テスト（RSS 新着凍結の根本原因）。
// RFC822 pubDate（例 "Wed, 01 Jul 2026 22:30:00 +0900"）を文字列比較すると曜日名の
// アルファベット順で「最古」が決まってしまい、火・水曜の item だけが生き残って
// 新着が凍結する事故が起きた。Date.parse による数値比較に直したことを検証する。

import { describe, it, expect } from 'vitest'
import { createStore } from '../scripts/store/store.mjs'
import { _trimRss } from '../scripts/fetch.mjs'

function rssItem(watchId, pubDate) {
  return {
    watchId,
    guid: null,
    pubDate,
    title: `title-${watchId}`,
    titleNorm: null,
    link: null,
    description: null,
    thumbnailUrl: null,
    resolvedContentId: null,
    resolutionStatus: 'pending',
  }
}

describe('_trimRss', () => {
  it('曜日名トラップ: 新しい Fri の item は全て残り、削除されるのは古い Wed 側のみ', () => {
    const store = createStore()
    // 古い（先週水曜）150件。旧バグでは文字列比較で "Wed" > "Fri" となり最新扱いされ生き残っていた。
    for (let i = 0; i < 150; i++) {
      const wid = `old${i}`
      store.rss.set(wid, rssItem(wid, 'Wed, 01 Jul 2026 22:30:00 +0900'))
    }
    // 新しい（今週金曜）100件
    for (let i = 0; i < 100; i++) {
      const wid = `new${i}`
      store.rss.set(wid, rssItem(wid, 'Fri, 03 Jul 2026 22:30:00 +0900'))
    }
    expect(store.rss.size).toBe(250)

    _trimRss(store, 200)

    expect(store.rss.size).toBe(200)
    // 新しい Fri の item は全件残存
    for (let i = 0; i < 100; i++) {
      expect(store.rss.has(`new${i}`)).toBe(true)
    }
    // 削除は古い Wed 側の50件のみ（150件中100件残存）
    const remainingOld = [...store.rss.keys()].filter((k) => k.startsWith('old')).length
    expect(remainingOld).toBe(100)
  })

  it('pubDate が null の item は最古扱いで最優先削除される', () => {
    const store = createStore()
    store.rss.set('nodate', rssItem('nodate', null))
    for (let i = 0; i < 5; i++) {
      const wid = `dated${i}`
      store.rss.set(wid, rssItem(wid, 'Fri, 03 Jul 2026 22:30:00 +0900'))
    }
    expect(store.rss.size).toBe(6)

    _trimRss(store, 5)

    expect(store.rss.size).toBe(5)
    expect(store.rss.has('nodate')).toBe(false)
  })
})
