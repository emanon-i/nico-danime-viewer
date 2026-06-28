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
  /**
   * 演者/制作（声優・スタッフ人名・制作会社・原作者等を 1 列に統合した名前タグ・1話目由来・
   * 重複除去）。人物フィルタ `?credit=<名前>` の照合用。旧 JSON（cast/staff 時代）では欠落。
   */
  credits?: string[]
  /** シリーズの各話数（episodes テーブルの件数）。「全N話」表示に使う */
  episodeCount: number
  /** 最新話の投稿時刻（episodes.start_time の最大・ISO8601）。新着順・投稿時間メタに使う（旧 JSON では欠落） */
  latestAt?: string | null
  /** 最新話の contentId（"so番号"）。sort=new の同時刻タイブレーカー用（旧 JSON では欠落） */
  latestContentId?: string | null
  /** 最古話の投稿時刻（episodes.start_time の最小・ISO8601）。投稿時間レンジ絞り込みに使う */
  firstAt?: string | null
  /** 最古話の contentId（"so番号"）。sort=created の同時刻タイブレーカー用 */
  firstContentId?: string | null
  /** シリーズ合算コメント数（総コメント数順・メタ用） */
  commentTotal?: number
  /** シリーズ合算マイリスト数 */
  mylistTotal?: number
  /** 第1話のマイリスト数（カードの常時メタ＝作品横断で比較できる人気の錨・§31） */
  mylistFirst?: number
  /** シリーズ合算再生時間（秒）。平均話長＝durationTotal/episodeCount で再生時間絞り込みに使う */
  durationTotal?: number
  /** 累計再生数（全話合算・§79）。カードの累計再生数メタ・views 並び替えに使う（旧 JSON では欠落） */
  totalViews?: number
  /** Hot 生スコア（0..1）。炎ティア（§64）を ranking.hotTiers と突合して算出する */
  hotScore?: number
  /** snapshot 由来の配信可否（false = soft tombstone・非公式・配信終了など） */
  isAvailable?: boolean
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

/** 炎ティア閾値（§64・全作品横断 percentile の hot_score 値）。t1=上位10% t2=上位5% t3=上位1% */
export interface HotTiers {
  t1: number
  t2: number
  t3: number
}

export interface RankingJson {
  lastUpdated: string
  hot: RankingEntry[]
  popular: RankingEntry[]
  hotTiers?: HotTiers
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
  resolutionStatus: 'resolved' | 'pending'
  /** 解決済み話のサムネ（episodes.thumbnail_url を resolved_content_id で join）。未解決はサムネ無し→null */
  thumbnailUrl: string | null
  /** 話番号（episodes.episode_no）。「第N話」表示に使う。nvapi 未解決なら null */
  episodeNo: number | null
  /** 話の再生数（episodes.view_counter）。未解決なら null */
  viewCounter: number | null
  /** 話のコメント数（episodes.comment_counter）。未解決/旧 JSON なら null */
  commentCounter?: number | null
  /** 話のマイリスト数（episodes.mylist_counter）。未解決/旧 JSON なら null */
  mylistCounter?: number | null
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
  /** コメント数（snapshot commentCounter・旧 JSON では欠落） */
  commentCounter?: number | null
  /** マイリスト数（snapshot mylistCounter） */
  mylistCounter?: number | null
  /** 尺（秒・snapshot lengthSeconds） */
  lengthSeconds?: number | null
  startTime: string | null
  thumbnailUrl: string | null
  /** 各話あらすじ（episodes.description・ドロワーに表示＝§51。旧 JSON では欠落） */
  description?: string | null
  /** 各話タグ（正規化済み・§77。ドロワーのメタと説明の間に表示。クールタグ除外は表示時。旧 JSON では欠落） */
  tags?: string[]
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
  /**
   * 演者/制作（声優・スタッフ人名・制作会社・原作者等を 1 列に統合した名前タグ・1話目由来・
   * 重複除去）。詳細画面のチップ表示＋ `?credit=` フィルタ用。旧 JSON では欠落＝optional。
   */
  credits?: string[]
}

export interface SeriesDetailJson {
  /** per-series JSON は冪等化のため lastUpdated を持たない（旧 JSON との互換で optional） */
  lastUpdated?: string
  seriesId: number
  title: string
  thumbnailUrl: string | null
  descriptionFirst: string | null
  tags: string[]
  cours: string | null
  colKey: string | null
  relatedSeries: RelatedSeries[]
  episodes: SeriesEpisode[]
  credits?: string[]
}
