// scripts/nico/period.mjs
// 過去季クールの取得元: anime.nicovideo.jp/period/<年>-<英語季>-danime.html
// （foundation.md §1.2 / validation 5回目C）。startTime はバルク投稿日のため過去季の
// クール判定に使えない → period HTML が正本。支店明示・過去季も取得可。

import { fetchWithToS } from '../lib/http.mjs'

const SEASON_EN = { winter: 'winter', spring: 'spring', summer: 'summer', autumn: 'autumn' }

/** period ページの URL を生成（例 2026-spring-danime.html） */
export function periodUrl(year, season) {
  const en = SEASON_EN[season] ?? season
  return `https://anime.nicovideo.jp/period/${year}-${en}-danime.html`
}

/**
 * period HTML を取得する。404（その季のページ無し）は { status, body:null } を返す。
 * @returns {Promise<{ status: number, body: string | null }>}
 */
export async function fetchPeriodHtml(year, season) {
  const resp = await fetchWithToS(periodUrl(year, season))
  if (resp.status === 200) return { status: 200, body: await resp.text() }
  return { status: resp.status, body: null }
}

const SEASONS = ['winter', 'spring', 'summer', 'autumn']

/** 月（1-12）から英語季を返す */
export function seasonOfMonth(month) {
  if (month <= 3) return 'winter'
  if (month <= 6) return 'spring'
  if (month <= 9) return 'summer'
  return 'autumn'
}

/**
 * 過去季を新しい順に列挙する（現行季は除外＝programlist が担当）。
 * @param {Date} now
 * @param {number} fromYear - 遡る下限の年（含む）
 * @returns {{ year: number, season: string }[]} 新しい順
 */
export function enumeratePastSeasons(now, fromYear) {
  const curYear = now.getFullYear()
  const curSeason = seasonOfMonth(now.getMonth() + 1)
  const list = []
  for (let y = curYear; y >= fromYear; y--) {
    for (const s of SEASONS) list.push({ year: y, season: s })
  }
  // 新しい順（年降順・季は winter<spring<summer<autumn の暦順を逆に）
  list.sort((a, b) =>
    a.year !== b.year ? b.year - a.year : SEASONS.indexOf(b.season) - SEASONS.indexOf(a.season)
  )
  // 現行季・未来季を除外
  const curIdx = SEASONS.indexOf(curSeason)
  return list.filter((e) => {
    if (e.year > curYear) return false
    if (e.year === curYear && SEASONS.indexOf(e.season) >= curIdx) return false
    return true
  })
}
