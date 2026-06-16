// web/src/data/types.ts
// 静的 JSON export のスキーマ型定義（データ契約の正本）
// PH-0003 以降のローダはこれを import して消費する

export interface RelatedSeries {
  seriesId: number
  title: string
  thumbnailUrl: string | null
}

export interface Work {
  seriesId: number
  title: string
  thumbnailUrl: string | null
  descriptionFirst: string | null
  tags: string[]
  cours: string | null
  franchiseKey: string | null
  colKey: string | null
  /** シリーズの各話数（episodes テーブルの件数）。「全N話」表示に使う */
  episodeCount: number
  /** 最新話の投稿時刻（episodes.start_time の最大・ISO8601）。新着順・投稿時間メタに使う（旧 JSON では欠落） */
  latestAt?: string | null
  relatedSeries: RelatedSeries[]
}

export interface WorksJson {
  lastUpdated: string
  works: Work[]
}

export interface RankingEntry {
  seriesId: number
  title: string
  thumbnailUrl: string | null
  totalViews: number
  hotScore: number | null
}

export interface RankingJson {
  lastUpdated: string
  hot: RankingEntry[]
  popular: RankingEntry[]
}

export interface Tag {
  name: string
  isCurated: boolean
  seriesCount: number
}

export interface TagsJson {
  lastUpdated: string
  tags: Tag[]
  topHotTags: string[]
  topPopularTags: string[]
}

export interface CoursGroup {
  cours: string
  seriesIds: number[]
}

export interface CoursJson {
  lastUpdated: string
  cours: CoursGroup[]
}

export interface KanaGroup {
  colKey: string
  seriesIds: number[]
}

export interface KanaJson {
  lastUpdated: string
  kana: KanaGroup[]
}

export interface NewItem {
  watchId: string
  title: string
  pubDate: string
  resolvedContentId: string | null
  resolutionStatus: 'resolved' | 'rss_only' | 'unresolved'
  /** 解決済み話のサムネ（episodes.thumbnail_url を resolved_content_id で join）。未解決はサムネ無し→null */
  thumbnailUrl: string | null
  /** 話番号（episodes.episode_no）。「第N話」表示に使う。nvapi 未解決なら null */
  episodeNo: number | null
  /** 話の再生数（episodes.view_counter）。未解決なら null */
  viewCounter: number | null
}

export interface NewJson {
  lastUpdated: string
  items: NewItem[]
}

export interface SeriesEpisode {
  contentId: string
  episodeNo: number | null
  title: string | null
  viewCounter: number
  startTime: string | null
  thumbnailUrl: string | null
}

export interface SeriesDetail {
  seriesId: number
  title: string
  thumbnailUrl: string | null
  descriptionFirst: string | null
  tags: string[]
  cours: string | null
  colKey: string | null
  relatedSeries: RelatedSeries[]
  episodes: SeriesEpisode[]
}

export interface SeriesDetailJson {
  lastUpdated: string
  seriesId: number
  title: string
  thumbnailUrl: string | null
  descriptionFirst: string | null
  tags: string[]
  cours: string | null
  colKey: string | null
  relatedSeries: RelatedSeries[]
  episodes: SeriesEpisode[]
}
