const WATCH_BASE = 'https://www.nicovideo.jp/watch/'
const SERIES_BASE = 'https://www.nicovideo.jp/series/'

/** `so\d+` 形式の contentId から watch URL を生成。不正な場合 null */
export function watchLink(contentId: string): string | null {
  if (!/^so\d+$/.test(contentId)) return null
  return WATCH_BASE + contentId
}

/** 正整数の seriesId から series URL を生成。不正な場合 null */
export function seriesLink(seriesId: number): string | null {
  if (!Number.isInteger(seriesId) || seriesId <= 0) return null
  return SERIES_BASE + seriesId
}
