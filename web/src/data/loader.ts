import type {
  WorksJson,
  RankingJson,
  TagsJson,
  CoursJson,
  KanaJson,
  NewJson,
  SeriesDetailJson,
} from './types'

const DATA_BASE = 'data/'

function isObj(d: unknown): d is Record<string, unknown> {
  return typeof d === 'object' && d !== null && !Array.isArray(d)
}

function isWorksJson(d: unknown): d is WorksJson {
  if (!isObj(d)) return false
  return typeof d['lastUpdated'] === 'string' && Array.isArray(d['works'])
}

function isRankingJson(d: unknown): d is RankingJson {
  if (!isObj(d)) return false
  return (
    typeof d['lastUpdated'] === 'string' &&
    Array.isArray(d['hot']) &&
    Array.isArray(d['popular'])
  )
}

function isTagsJson(d: unknown): d is TagsJson {
  if (!isObj(d)) return false
  return (
    typeof d['lastUpdated'] === 'string' &&
    Array.isArray(d['tags']) &&
    Array.isArray(d['topHotTags']) &&
    Array.isArray(d['topPopularTags'])
  )
}

function isCoursJson(d: unknown): d is CoursJson {
  if (!isObj(d)) return false
  return typeof d['lastUpdated'] === 'string' && Array.isArray(d['cours'])
}

function isKanaJson(d: unknown): d is KanaJson {
  if (!isObj(d)) return false
  return typeof d['lastUpdated'] === 'string' && Array.isArray(d['kana'])
}

function isNewJson(d: unknown): d is NewJson {
  if (!isObj(d)) return false
  return typeof d['lastUpdated'] === 'string' && Array.isArray(d['items'])
}

function isSeriesDetailJson(d: unknown): d is SeriesDetailJson {
  if (!isObj(d)) return false
  return (
    typeof d['lastUpdated'] === 'string' &&
    typeof d['seriesId'] === 'number' &&
    Array.isArray(d['episodes'])
  )
}

async function loadJson<T>(filename: string, guard: (d: unknown) => d is T): Promise<T> {
  const res = await fetch(DATA_BASE + filename)
  if (!res.ok) throw new Error(`[loader] HTTP ${res.status}: ${filename}`)
  const data: unknown = await res.json()
  if (!guard(data)) throw new Error(`[loader] schema mismatch: ${filename}`)
  return data
}

export const loadWorks = (): Promise<WorksJson> => loadJson('works.json', isWorksJson)
export const loadRanking = (): Promise<RankingJson> => loadJson('ranking.json', isRankingJson)
export const loadTags = (): Promise<TagsJson> => loadJson('tags.json', isTagsJson)
export const loadCours = (): Promise<CoursJson> => loadJson('cours.json', isCoursJson)
export const loadKana = (): Promise<KanaJson> => loadJson('kana.json', isKanaJson)
export const loadNew = (): Promise<NewJson> => loadJson('new.json', isNewJson)
export const loadSeriesDetail = (seriesId: number): Promise<SeriesDetailJson> =>
  loadJson(`series/${seriesId}.json`, isSeriesDetailJson)
