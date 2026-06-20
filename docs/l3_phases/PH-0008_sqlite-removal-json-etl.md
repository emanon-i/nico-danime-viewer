# PH-0008: 脱SQLite・純JSON＋メモリJS ETL（正本一本化）

## 目的

データ取得パイプラインから **SQLite（`better-sqlite3`）・DB用 actions/cache・JSON→DB importer をすべて廃止**し、
**JSON を唯一の正本**とする。加工は **メモリ上の JS（Map/配列）ETL** に置き換える。これにより
2026-06 の「データ痩せ→cache縮小ループ→ライブ縮小→zombie→凍結」連鎖の **根（揮発するcacheにしか紐付けが無い）を断つ**。

- 設計方針の母体は [`../l2_foundation/dataflow-redesign-plan.md`](../l2_foundation/dataflow-redesign-plan.md)（案2＝SQLite完全廃止を確定）。
- 本書は **gen-code を駆動できる詳細度** の L3 実装 Plan。**本フェーズでは実装しない**（spec-first）。
- 現行コード（`scripts/**`）・workflow・`data/**`・#21・稼働中 cron は **本フェーズでは変更しない**。

---

## 設計概要（アーキテクチャ）

```
 ┌──────────── 正本（JSON・state ブランチ＝恒久）────────────┐
 │ data/series/<id>.json … 各話の真実（view/prev/紐付け/tags） │
 │ data/state/meta.json … HWM・version・seed状態 │
 │ data/state/rss.json … RSS staging（新着解決テーブル） │
 └───────────────┬─────────────────────┬─────────────────────┘
 ① load(JSON→Map) │ ④ writeBack（検証通過時のみ）
 ▼ │
 ┌─ Store（メモリ：Map/配列。DBの役割を全代替）─┐ │
 │ series:Map episodes:Map rss:Map meta:obj │ │
 │ + upsert/join/集計/正規化を純JSメソッドで提供 │ │
 └───────────────┬───────────────────────────────┘ │
 ② fetch+ETL（mode別） │
 ▼ │
 ┌─ 検証ゲート（予防型 detectShrink・schema/件数）─┐ │
 │ 不合格 → writeBack/deploy を全 skip（正本保全） │──┘
 └───────────────┬─────────────────────────────────┘
 ③ project（正本→派生）合格時のみ
 ▼
 works/ranking/tags/cours/kana/new.json（純・派生＝projection）
 ▼
 GitHub Pages（ブラウザは JSON を読むだけ）
```

**3 つの不変条件（invariant）**

1. **正本＝JSON のみ**。SQLite/DB cache は存在しない。Store はメモリ上の揮発オブジェクト（毎回 JSON から再構築）。
2. **一方向**：`正本JSON → Store → 派生projection`。projection（works/ranking/…）を Store の入力として読み戻さない。
3. **縮小不能**：projection 出力前に予防型ガードを通し、痩せた Store からは書き戻さない（正本を保全）。

---

## §0. 改訂（Codex レビュー反映・v2・**以降の節に優先する binding 契約**）

> 2026-06 Codex 設計レビューで 12 件（CRITICAL×4/MAJOR×7/MINOR×1）を受領、全件採用。以下は**下位節の記述に優先**する。
> 主旨：「cache 縮小障害」を「JSON state drift」に置換しないため、**正本スキーマ移行・SQL 意味等価・複数ファイル state 原子性**を明示する。

### 0-1. 正本スキーマは public export と分離（C1）

現行 `data/series/<id>.json` は **非可逆に欠損**（`is_available=1` のみ出力／episode `tags` は正規化済み配列で生 tag 無し／`isCurated` 喪失／description 除去済み）。
→ **公開用 series JSON をそのまま正本にしない**。以下を正本に保持する：

- episode：`prevViewCounter`（delta 用）・**`isCurated` を含むタグ情報**・配信終了 series の **tombstone**（`isAvailable:false` ＋削除日）。
- 実現：**正本専用フィールドを `data/series/<id>.json` に内包拡張**（公開側は無視）。生 snapshot tag 文字列は **`tags`＋`tagsCurated:string[]`**（キュレーション由来 tag 名）で保持し、`processEpisodeTags` の `isCurated` を復元可能にする。
- **移行前提（M-pre）**：SQLite 削除前に、現行 `build.sqlite`（または最後の正常 DB）から **enrich 一回**で `prevViewCounter`/`isCurated`/配信終了 series を series JSON に焼き込む。**この移行が完了するまで SQLite を消さない**（§E M6→M8 へ後ろ倒し）。

### 0-2. metrics は SQL 厳密等価（C2/M2）

- delta は**クランプしない**：`deltaViews = Σ (prev==null ? 0 : (view - prev))`。**負の delta を許容**し min/max 正規化に算入（SQL `SUM(COALESCE(view-prev,0))` と一致）。
- 時刻 null：`start_time` が null/不正なら **velocity/recency の当該項を SQL の `julianday(NULL)`＝NULL 伝播と同じく「寄与なし」**に（NaN/Unix epoch 化を禁止）。first/latest が無い series は metrics 行を作らない（現行 `WHERE series_id IS NOT NULL` 相当）。
- `julianday(a)-julianday(b)` ≡ `(Date(a)-Date(b))/86400000`（有効値時のみ）。テストに **減少・単一 series でレンジ 0・null 時刻** の fixture を追加。

### 0-3. daily は global `contentId→seriesId` 索引を前提（C3/M1/M5-atomic）

- **load 時に全 series から `contentId→{seriesId,episodeNo}` 索引を構築**。snapshot フラット配列に対し：既存＝索引で所属ファillに反映、**孤児 = snapshot キー − 索引キー**（→seed）、重複 contentId は明示検出してログ。
- **書き込みは「全 update＋verify 通過後」に一括**（途中書き禁止）。`series/*.json`＋`prev-views.json`＋`meta.json`＋`rss.json` を **1 つの state トランザクション**として **temp tree へ書く→検証→atomic swap/commit**（base-SHA 照合）。crash/並行で delta が desync しない。

### 0-4. hourly は projection を入力にしない（C4）

- **works.json を読み戻さない・patch しない**（invariant 厳守）。hourly が書くのは **`new.json`＋触れた `series/<id>.json`＋state のみ**（temp+atomic rename）。
- works/ranking/tags/cours は **daily 専管**。新着の即時可視化は **`new.json` で達成**（browse 全体反映は次 daily）。
- hourly が参照する索引 **`data/state/series-index.json`（id→title/titleNorm/colKey）は必須・daily が正本から生成**（projection ではなく state）。

### 0-5. seed 候補アルゴリズムを定義（M5）

孤児は seriesId 不明＝「孤児の series を seed」は循環。候補集合を：**①新規 list series（episodes 0）→②話数が nvapi 期待より不足の series →③孤児件数が閾値超なら list 全件 fallback（`forceSeed` 相当）**。トリガ＝孤児存在 or 週次 or force。完了時のみ `meta.lastSeedAt` 更新。

### 0-6. ガードを invariant 化（M6）

「cannot shrink」は過大主張。detectShrink（ep>0×0.9）に加え **source 不変条件**を verify に追加：**(a) tombstone 無き series 削除禁止**、**(b) per-series 話数の非減（明示削除を除く）**、**(c) available 件数の期待レンジ**、**(d) prev-views/meta/rss のスキーマ検査**。いずれか違反で writeBack/deploy skip。

### 0-7. 並行制御は楽観ロック（M7）

GH Actions `concurrency` は job/workflow scope で「push 区間だけ lock」は**不可**。代わりに **git 楽観ロック**：state 復元時に **base SHA を記録 → commit 前に `pull --rebase` → non-fast-forward は retry → 触れたファイルが新しい state と overlap したら abort**。daily/hourly が同一 state から開始しても push 競合で壊れない。

### 0-8. rollback 経路を M7 観測後まで保持（N1）

`better-sqlite3`＋`scripts/db/db.mjs`＋旧 workflow を **flag 裏で温存**し、**golden SQL 出力（oracle）を凍結**。**SQLite 物理削除は M7 の本番観測 OK 後（新設 M8）**。M6 では「JS 経路を既定化」までに留める。

---

## §A. 現行 SQL ロジック → メモリJS 移植 1対1 対応表（棚卸し）

> 出典＝実コード（`scripts/db/db.mjs`・`scripts/fetch.mjs`・`scripts/etl/{metrics,cours,tags,series}.mjs`・
> `scripts/export/export.mjs`・`scripts/nico/{snapshot,rss,nvapi,list,period,filter}.mjs`・`scripts/lib/http.mjs`）。
> 「純JS」＝既に DB 非依存（引数が配列/Map）で**そのまま流用**できる関数。「要移植」＝SQL/DB API を JS へ書換。

### A-1. ストア層（`scripts/db/db.mjs`）＝全面 要移植

| 現行 SQL / DB API                                                                                 | 役割                        | メモリJS 置換（新 `scripts/store/store.mjs`）                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createSchema` / PRAGMA / `applyPragma`                                                           | テーブル定義                | `createStore()` が `{ series:Map<id,obj>, episodes:Map<contentId,obj>, rss:Map<watchId,obj>, meta:obj }` を返す。スキーマ＝JSDoc 型                                                                                                        |
| `createIndexes` / `ANALYZE`                                                                       | 索引                        | 廃止。突合が要る箇所だけ **その場で派生 Map**（例 `titleNorm→seriesId`）を組む                                                                                                                                                             |
| `registerCustomFunctions`（`log1p`/`exp_neg_div`）                                                | metrics 用スカラ関数        | `Math.log1p` / `(x,tau)=>Math.exp(-x/tau)` を直接使用                                                                                                                                                                                      |
| `bulkUpsertEpisodes`（`INSERT … ON CONFLICT DO UPDATE` で `prev_view_counter=view_counter` 退避） | 各話 upsert＋**前回値退避** | `upsertEpisodes(eps)`：`episodes.has(contentId)` なら `prevViewCounter = 旧.viewCounter` を退避して各フィールド更新／無ければ挿入し `prevViewCounter=null`。**`seriesId`/`episodeNo` は ON CONFLICT 同様に上書きしない**（既存紐付け保全） |
| `bulkUpsertSeries`（`ON CONFLICT` で title/thumb COALESCE・`is_available=1`）                     | シリーズ upsert             | `upsertSeries(list)`：存在すれば title 上書き＋`thumbnailUrl ??= 新`＋`isAvailable=true`／無ければ挿入                                                                                                                                     |
| `updateEpisodeOrderBatch`（`UPDATE … SET series_id, episode_no`）                                 | nvapi 由来の紐付け          | `linkEpisodes(updates)`：`ep.seriesId=`, `ep.episodeNo=` を Map 上で代入                                                                                                                                                                   |
| `updateSeriesFields`（whitelist UPDATE）                                                          | series 任意列更新           | `updateSeries(id, fields)`：ホワイトリスト検証のうえ Map のオブジェクトへ Object.assign                                                                                                                                                    |
| `syncSeriesThumbnails`（`UPDATE … SELECT min(start_time) …`）                                     | サムネ未設定を最古話で補完  | series ごとに「`thumbnailUrl==null` なら 最古話（start_time→episodeNo→contentId 昇順）の thumb」を代入                                                                                                                                     |
| `syncSeriesTimestamps`（first/last = min/max start_time）                                         | first/last_seen 同期        | series ごとに episodes から `firstSeen=min`, `lastSeen=max` を計算（各話 0 件はスキップ）                                                                                                                                                  |
| `getMetaState`/`updateMetaState`（単一行 + whitelist）                                            | HWM/version/seed 時刻       | `store.meta` オブジェクト（`data/state/meta.json` を読み書き）。whitelist 検証は JS で踏襲                                                                                                                                                 |
| `bulkUpsertRssItems`（`ON CONFLICT DO NOTHING`）                                                  | RSS staging                 | `rss.has(watchId)` 無いときだけ挿入                                                                                                                                                                                                        |
| `updateRssResolution`                                                                             | 解決状態更新                | `rss.get(watchId)` に `resolvedContentId`/`resolutionStatus` 代入                                                                                                                                                                          |
| `upsertTag` / `replaceSeriesTags`（`tags`＋`series_tags` の M2M）                                 | タグ辞書＋関連              | **テーブル廃止**。`series.tags = [{name,isCurated}]` を直接保持。タグ辞書/件数は projection 時に集計（§A-4 exportTags）                                                                                                                    |

### A-2. 取得層（`scripts/nico/*`・`scripts/lib/http.mjs`）＝ほぼ純JS（流用）

| 関数                                                                                                              | 判定       | 備考                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot.mjs`：`buildYearWindows`/`fetchWindow`/`fetchAllBranchEpisodes`/`fetchSnapshotVersion`                  | 純JS       | fetch 結果は配列で返る。**DB 非依存・無改修**。version ゲートも文字列比較のまま                                                                                                           |
| `filter.mjs`：`filterBranchEpisodes`（channelId===2632720）                                                       | 純JS       | 無改修                                                                                                                                                                                    |
| `rss.mjs`：`fetchRss`/`parseRssXml`/`extractWatchId`/`filterNewRssItems`/`assertRssOk`/`normalizeTitleForMatch`   | 純JS       | 無改修                                                                                                                                                                                    |
| `rss.mjs`：`resolveRssItems(db)`                                                                                  | **要移植** | DB クエリ（`rss_items` 走査＋`episodes` から正規化タイトル索引）を **Store 版** `resolveRssItems(store)` に。ロジック（unresolved+rss_only を episodes のタイトル正規化一致で解決）は同一 |
| `nvapi.mjs`：`fetchSeriesData`/`isBranchSeries`/`mapNvapiItems`/`mapNvapiEpisodes`/`seedAllSeries`/`updateSeries` | 純JS       | `seedAllSeries` のコールバックが DB 書込→Store 書込に変わるだけ（呼出側で吸収）                                                                                                           |
| `list.mjs`：`fetchListJson`/`fetchProgramlist`                                                                    | 純JS       | 無改修                                                                                                                                                                                    |
| `period.mjs`：`periodUrl`/`fetchPeriodHtml`/`enumeratePastSeasons`/`seasonOfMonth`                                | 純JS       | 無改修                                                                                                                                                                                    |
| `http.mjs`：`fetchWithToS`（UA・適応遅延・503バックオフ・条件付きGET）                                            | 純JS       | 無改修。ToS 厳守はこのまま                                                                                                                                                                |

### A-3. 派生層（`scripts/etl/*`）

| 関数                                                                                                                                                                                                             | 判定               | メモリJS 置換                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tags.mjs`：`normalizeTagName`/`extractTagsFromRaw`/`isTitleTag`/`processEpisodeTags`                                                                                                                            | 純JS               | 無改修（文字列処理のみ）                                                                                                                                                                                    |
| `tags.mjs`：`deriveSeriesTags(db)`（全話 tags を JOIN→series 単位 union）                                                                                                                                        | **要移植**         | `deriveSeriesTags(store)`：`episodes` を走査し `seriesId` 別に `processEpisodeTags(ep.tags, series.title)` を union（`isCurated` は OR 統合）。ロジック同一                                                 |
| `series.mjs`：`stripHtml`/`extractSeriesIdFromUrl`/`titleStem`/`computeFranchiseKeys`                                                                                                                            | 純JS               | 無改修（`computeFranchiseKeys` は既に Map 入出力の union-find）                                                                                                                                             |
| `series.mjs`：`deriveSeriesOverviews(db)`（最古話 description）                                                                                                                                                  | **要移植**         | `deriveSeriesOverviews(store)`：series 別に最古話（start_time→episodeNo→contentId 昇順）の `description` を `stripHtml`                                                                                     |
| `series.mjs`：`getSeriesTagsMap(db)`（series_tags JOIN）                                                                                                                                                         | **要移植**         | `store` から `Map<seriesId, string[]>`（`series.tags.map(t=>t.name)`）                                                                                                                                      |
| `cours.mjs`：`coursFromTags`/`makeCoursLabel`/`parsePeriodHtml`/`cleanPeriodTitle`/`matchPeriodEntriesToSeries`/`matchSlugsToSeries`/`mapCurrentCours`/`normalizeTitleForMatch`/`normalizeSlug`/`assertPeriodOk` | 純JS               | 無改修（Map/配列入出力）                                                                                                                                                                                    |
| `cours.mjs`：`deriveCoursFromTags(db)`（最古話 tags から `YYYY年X季アニメ`）                                                                                                                                     | **要移植**         | `deriveCoursFromTags(store)`：series 別に最古話の `tags` へ `coursFromTags`。**処理済み per-episode tags にクール文字列は残る**（`processEpisodeTags` は除外しない＝UI 側 `isCoursTag` で除外）ため再導出可 |
| `metrics.mjs`：`recalcSeriesMetrics(db)`（1本の CTE SQL：ep_agg→derived→ranges→normalized）                                                                                                                      | **要移植（中核）** | §A-5 の二段パス JS。式・重み・TAU・タイブレークは完全踏襲                                                                                                                                                   |

### A-4. オーケストレーション（`scripts/fetch.mjs`）の SQL 直書き箇所＝要移植

| 現行箇所                 | SQL 操作                                                                                    | メモリJS 置換                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `main()` Phase B         | `UPDATE series SET is_available=0`（全件）→ list 由来を upsert で 1 に戻す                  | 全 series `isAvailable=false`→ list 反映時に `true`。**list 外の series は削除せず保持**（prev/履歴温存・復活可） |
| `main()` Phase C         | seed ゲート `daysSinceRefresh>=7                                                            |                                                                                                                   | forceSeed` | **孤児駆動**（§F-0053）：`seriesId==null` の branch 孤児が在る／週次経過／`forceSeed` で seed。`last_full_refresh_at` 依存を撤去 |
| `runCoursPipeline()`     | `UPDATE series SET cours=NULL`（クリア）→ tag/programlist/period で再付与                   | Store 上で `cours` クリア→再付与（既存ロジック呼出元のみ差替）                                                    |
| `derivePastCours()`      | `SELECT series_id … WHERE cours IS NOT NULL`／`SELECT series_id,title …`                    | Store 走査で `assigned` Set と `seriesMap` を構築（ロジック同一）                                                 |
| `matchRssOnlyToSeries()` | `SELECT title FROM rss_items WHERE status='rss_only'`／`SELECT series_id,title FROM series` | Store 走査。title 前方最長一致のロジック同一                                                                      |
| `detectShrink()`         | `SELECT COUNT(DISTINCT series_id) FROM episodes WHERE series_id IS NOT NULL`                | Store 集計（distinct seriesId）。baseline は **既存 works.json（確定済み正本）** 固定（§F-0056）                  |
| `runHourly()` 空DBガード | `SELECT COUNT(*) FROM series`                                                               | Store の series 件数。0 なら skip（正本保全）                                                                     |

### A-5. metrics の SQL→二段パス JS（最重要・式は不変）

```
// pass1: series 別集計（episodes を1回走査・seriesId!=null のみ）
// ★delta はクランプしない（§0-2）。prev=null→0、それ以外は view-prev（負も算入）＝SQL COALESCE 等価
agg[sid] = { totalViews:Σview, deltaViews:Σ(prev==null ? 0 : (view - prev)),
 latest:max(startTime), first:min(startTime) } // null/不正 startTime は寄与なし（§0-2）
velocity[sid] = totalViews / Math.max(1, daysBetween(now, first)) // julianday 差→日数
recencyDays[sid] = daysBetween(now, latest)
// グローバル min/max（正規化レンジ）
deltaMin/Max, velLogMin/Max = min/max over (deltaViews), (log1p(velocity))
// pass2: 正規化＋ブレンド
delta_n = (deltaMax==deltaMin)?0:(d-deltaMin)/(deltaMax-deltaMin)
velocity_n = (velLogMax==velLogMin)?0:(log1p(v)-velLogMin)/(velLogMax-velLogMin)
recency_n = exp(-recencyDays/TAU) // TAU=14
hot_score = 0.5*delta_n + 0.3*velocity_n + 0.2*recency_n
```

- `julianday(a)-julianday(b)` は **`(Date(a)-Date(b))/86400000`** で同値（UTC ms 差）。TZ 付き ISO はそのまま `Date` で解釈可。
- 重み `(0.5,0.3,0.2)`・`TAU=14`・`defaultMetricsConfig` は据置（設定外出し維持）。タイブレーク（hot→totalViews→seriesId）は ranking 並べ替えで踏襲。

### A-6. export（`scripts/export/export.mjs`）＝SQL を Store 走査へ（出力スキーマ不変）

| 現行 export                 | SQL                                                                                                                   | メモリJS 置換（**出力 JSON 形は不変**＝web 側の契約を壊さない）                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `exportWorks`               | series＋相関サブクエリ（episodeCount/latest/first/Σcomment/Σmylist/mylistFirst/Σlength/Σview/hot）＋tags map＋related | Store 走査で同集計。related は franchise グループから。**1ファイル（14.8MB）一括 write**        |
| `exportRanking`             | hot/popular を ORDER BY+LIMIT 200、percentile で hotTiers                                                             | JS sort（hot：hot→total→id／popular：total→id）+ slice(200)。tiers＝昇順 hot 配列の p90/p95/p99 |
| `exportTags`                | tags GROUP BY＋hot/popular top20 の頻出タグ                                                                           | series.tags を集計（name→件数・isCurated OR）。top タグは metrics 上位 20 の tag 頻度           |
| `exportCours`/`exportKana`  | GROUP BY cours / col_key                                                                                              | Map でグルーピング（順序：cours desc、kana は colKey→title）                                    |
| `exportNew`                 | rss_items LEFT JOIN episodes（resolved_content_id）                                                                   | rss を pubDate desc 100 件、resolved は episodes から thumb/ep_no/各counter を引く              |
| `exportSeries`              | per-series：tags map＋related＋各話（ORDER BY episodeNo,start_time）                                                  | series 別に書き出し。**lastUpdated を入れない**現行仕様を踏襲（差分ノイズ抑止）                 |
| `writeJson`（無インデント） | —                                                                                                                     | 無改修（純JS）                                                                                  |

> **棚卸し結論**：DB に固有な操作は ①upsert＋prev退避 ②join（ep↔series・series↔tags・rss↔ep）③集計（Σ/min/max/distinct）④set-based 正規化（metrics）⑤GROUP BY（cours/kana/tags）。
> すべて **Map 走査＋reduce＋sort** で 1対1 に置換でき、**外部依存の喪失なし**（唯一の追加要件＝`prevViewCounter` の永続化＝§B-2）。

---

## §B. JSON データモデル＝正本の定義

### B-1. 正本ファイル群（authoritative・state ブランチで恒久）

| ファイル                     | 役割                                       | 主キー               | 主フィールド                                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/series/<id>.json`      | **各話と紐付けの真実**（＋browser 詳細用） | seriesId             | `seriesId,title,thumbnailUrl,descriptionFirst,tags[],cours,colKey,isAvailable,relatedSeries[]`／`episodes[]:{contentId,episodeNo,title,viewCounter,commentCounter,mylistCounter,lengthSeconds,startTime,thumbnailUrl,description,tags[]}` |
| `data/state/meta.json`       | 増分 state（HWM・version・seed）           | （単一オブジェクト） | `rssLastGuid, snapshotVersionLastModified, lastSeedAt, schemaVersion`                                                                                                                                                                     |
| `data/state/prev-views.json` | **delta 用 前回 view（1スロット）**        | contentId            | `{ [contentId]: prevViewCounter }`（数値のみ・約8.7万件）                                                                                                                                                                                 |
| `data/state/rss.json`        | RSS staging（解決テーブル）                | watchId              | `{watchId,guid,pubDate,title,resolvedContentId,resolutionStatus}`                                                                                                                                                                         |

**設計判断（重要）**

- **紐付け（contentId→seriesId/episodeNo）は `series/<id>.json` の `episodes[]` に内在**＝高コスト nvapi seed の成果が正本に永続化される。
  → cache 喪失も「痩せ」も起き得ない（再構築に nvapi 不要）。L2 案1の importer は **不要**（正本がそのまま Store の入力）。
- **`prevViewCounter` だけが現行 public series JSON に無い**ため、`data/state/prev-views.json` に**内部 state として分離**して持つ。
- 理由：prev は delta 専用の内部値。series 公開ファイルに混ぜると payload 増＋毎日 diff ノイズ。`is_available=0` の系列も含め contentId 単位で保持。
- 正本が失われた回は delta を無効扱い（prev 欠落→delta=0、velocity/recency 主体）と**正直に**扱う（ 既定を踏襲）。
- **`is_available=0` の series も `series/<id>.json` を保持**（`isAvailable:false`）。list 復活時に履歴/prev を失わない（現行 DB が cache で保持していた性質を JSON で代替）。projection は `isAvailable` で除外。

### B-2. 派生ファイル群（projection・読み戻さない）

`works.json`／`ranking.json`／`tags.json`／`cours.json`／`kana.json`／`new.json` は **毎 daily に正本から再生成**。
スキーマは現行のまま（web 側の `web/src/data/types.ts` 契約を変えない）。`exportSeries` の per-series 公開部分は
正本 `series/<id>.json` と**同一ファイル**（公開と正本を兼ねる・読み取りは browser のみ＝一方向は保たれる）。

### B-3. 一方向フロー（正本→Store→projection）

1. **load**：`series/*.json`＋`state/*.json` → Store（Map）。`prev-views.json` を episodes に合流。
2. **fetch+ETL**：mode 別に Store を更新（§F）。
3. **verify**：予防型 detectShrink ＋ schema/件数アサート。
4. **writeBack（合格時のみ）**：Store → `series/*.json`（変更分のみ diff）＋`state/*.json`、続いて projection を再生成。
5. **deploy/commit**：state ブランチへ push → Pages。projection を Store 入力に**読み戻さない**。

---

## §C. SQLite / DB cache / importer の廃止

| 廃止対象                                                  | 現状                                                  | 廃止後                                                                            |
| --------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `better-sqlite3` 依存                                     | `package.json` dependencies / `onlyBuiltDependencies` | **削除**（`@types/better-sqlite3` も）。ネイティブビルド不要化＝CI 高速・堅牢     |
| `scripts/db/db.mjs`                                       | スキーマ/PRAGMA/upsert                                | **削除**し `scripts/store/store.mjs`（純JS）へ置換                                |
| `data/build.sqlite`（+ wal/shm）                          | actions/cache の唯一の住処                            | **生成しない**。`.gitignore` の `*.sqlite*` は無害なので残置可                    |
| `sqlite-daily-<os>-*` cache（hourly restore／daily save） | DB 永続化＝痩せ連鎖の温床                             | **両 workflow から cache step を撤去**。状態は state ブランチ JSON で復元（正本） |
| L2 案1 の JSON→SQLite importer                            | 検討案                                                | **作らない**（正本＝Store 入力で再構築が自明）                                    |
| pnpm setup-node の `cache:'pnpm'`                         | 依存キャッシュ                                        | **存置**（DB と無関係の高速化。痩せ連鎖に無関係）                                 |

> actions/cache は **DB 用途を完全撤去**。必要が生じれば「依存（pnpm）」専用に限定（現状維持）。軽量キャッシュの新規用途は本フェーズでは追加しない。

---

## 機能一覧（gen-code 駆動単位）

### F-0050: メモリ Store（DB 全代替）＋ JSON load/writeBack

**対応REQ**: REQ-0001 / dataflow-redesign-plan §4・§5

`scripts/store/store.mjs` を新設。`createStore()` がメモリ Map 群を返し、§A-1 の全 API を純JS で提供。
`loadStore(dataDir)` が `series/*.json`＋`state/*.json`（meta/prev-views/rss）を Store に再構築、
`writeBackStore(store,dataDir)` が変更分の `series/<id>.json`＋`state/*.json` を書き出す（projection は別関数）。

**受け入れ条件**:

- [ ] `createStore()` が series/episodes/rss/meta を保持し、§A-1 の upsert/link/update/sync API を提供する
- 検証: `test_store_upsert_episode_prev_retain`（再upsertで prevViewCounter=旧view・seriesId 保全）
- [ ] `loadStore` が正本 JSON から Store を復元し、`prev-views.json` を episodes に合流する
- 検証: `test_loadstore_roundtrip`（writeBack→loadStore で series/episodes/meta が同値）
- [ ] `is_available=0` の series も保持・往復し、projection で除外される
- 検証: `test_unavailable_series_persisted`
- [ ] DB（better-sqlite3）への依存が Store 経路から消える
- 検証: `grep` で `scripts/store|fetch` に `better-sqlite3`/`openDatabase` 参照が無い（lint ルール or テスト）

---

### F-0051: daily フル（snapshot 全体・SQLite無し・二段 metrics・全 projection）

**対応REQ**: REQ-0001/0002 / dataflow.md §3・§6.2

`--mode=full`：loadStore → Phase A(snapshot)→B(list.json)→C(seed・F-0053)→D(RSS)→E(派生)→verify→F(metrics・§A-5)→project(全)→writeBack。
現行 `main()` の Phase 順・アサートを踏襲し、DB 操作のみ Store へ。

**受け入れ条件**:

- [ ] snapshot 全件が Store に upsert され、既存 contentId は `prevViewCounter` 退避のうえ view 更新される
- 検証: `test_daily_snapshot_upsert_prev`
- [ ] list.json で `isAvailable` を全クリア→現行リストのみ true、list 外は削除せず保持
- 検証: `test_daily_availability_sync`
- [ ] metrics が二段パス JS で算出され、現行 SQL と同じ hot_score/tiers を再現する
- 検証: `test_metrics_js_matches_sql`（同一入力で SQL 実装と数値一致・移行検証用に一時併走）
- [ ] 全 projection（works/ranking/tags/cours/kana/new/series）が出力され、スキーマが `types.ts` 契約と一致
- 検証: `test_export_all_json_files` 移植版＋スキーマ assert
- [ ] verify 不合格時は writeBack/projection/deploy を行わず正本を保全
- 検証: `test_daily_guard_blocks_shrink`

---

### F-0052: hourly 部分増分（全件を触らない・縮小不能）

**対応REQ**: REQ-0010 / dataflow-redesign-plan §5.2・§5.3b

`--mode=hourly`：**全 series を読まない**。① `state/meta.json`＋**軽量 series 索引**（id→title/titleNorm/colKey。`works.json` か小型 `data/state/series-index.json` から）を load。
② RSS 取得→新規 item を rss staging→`matchRssOnlyToSeries`（索引で title 前方一致）。
③ 一致 series の **当該ファイルだけ load**→nvapi で各話 append→`series/<id>.json` 書き戻し（temp+atomic rename）。
④ **`new.json` のみ再生成**（新着枠）。⑤ 新規話があれば `.deploy-needed`。
**works/ranking/tags/cours は触らない・読み戻さない**（daily 専管・§0-4 invariant）。works 反映は次 daily。

**受け入れ条件**:

- [ ] hourly が全 series ファイル（172MB）を一括ロードしない（索引＋触れた series のみ）
- 検証: `test_hourly_partial_load`（load 対象が「索引＋一致 series」に限定される）
- [ ] hourly は `works.json` を **読み戻さない・書かない**（projection 非入力 invariant・§0-4）
- 検証: `test_hourly_projection_not_input`（works/ranking/tags/cours がバイト不変）
- [ ] 新規話が無い時間は `new.json`/touched series のみ更新、deploy skip
- 検証: `test_hourly_idempotent_no_new`
- [ ] 空 state（series 索引 0 件）なら何もせず正本保全
- 検証: `test_hourly_empty_guard`
- [ ] hourly は構造的に全件 projection を縮小し得ない（projection を一切書かない）
- 検証: `test_hourly_cannot_shrink`

---

### F-0053: seed 孤児駆動（時刻フラグ依存の撤去）

**対応REQ**: REQ-0001 / dataflow-redesign-plan §3(W3)・§5.3c

seed トリガを **観測量（孤児件数）**へ：`episodes` に `seriesId==null` の branch 孤児が在る **OR** `lastSeedAt` から週次経過 **OR** `forceSeed`。
seed は **孤児 contentId を持つ series（と新規 series）だけ** nvapi 取得して `linkEpisodes`。完了時のみ `meta.lastSeedAt` 更新。

**受け入れ条件**:

- [ ] 孤児（seriesId=null）が存在すれば、時刻フラグに関係なく seed が走る
- 検証: `test_seed_triggers_on_orphans`
- [ ] seed 完了時のみ `lastSeedAt` を更新し、毎回更新の回帰を起こさない
- 検証: `test_seed_timestamp_only_on_run`（孤児注入→次回自動解消、`lastSeedAt` が seed 時だけ進む）
- [ ] `forceSeed` で全 branch series を再 seed できる（部分→フル復旧の退避路）
- 検証: `test_force_seed_all`
- [ ] 正本に紐付けが在る通常起動では seed 対象が差分（新規）のみで短時間
- 検証: `test_seed_skips_when_no_orphans`

---

### F-0054: 予防型 detectShrink ＋ verify ゲート（JS）

**対応REQ**: REQ-0001 / dataflow-redesign-plan §5.3e（W8）

`detectShrink(store, dataDir)` を Store 版で移植。baseline＝**確定済み `works.json`（自分が書く前の正本）固定**で ratchet-down を防止。
**`shrink` なら writeBack/projection/deploy を全 skip**（hourly/daily 共通）。schema/件数アサート（works/ranking/tags/cours/kana/new 生成確認）も verify に統合。

**受け入れ条件**:

- [ ] ep>0 series 数が baseline×0.9 を割る入力で projection/writeBack/deploy が skip される
- 検証: `test_detectshrink_blocks`（痩せ Store → 出力なし・正本不変）
- [ ] baseline は書込前 works.json 固定で、自分の痩せ出力を基準にしない
- 検証: `test_baseline_is_committed_truth`
- [ ] 生成 JSON 一式の存在/スキーマアサートが verify に含まれる
- 検証: `test_verify_schema_assert`

---

### F-0055: workflow（cache撤去・最小ロック・zombie耐性）

**対応REQ**: REQ-0010 / dataflow-redesign-plan §5.3f（W5/W7）

`fetch-hourly.yml`/`fetch-daily.yml` から **DB cache step を撤去**。状態復元は state ブランチ JSON のみ。
concurrency は **state への commit/push 区間だけを最小ロック**化（取得/加工は lock 外）＋ **古い run の stale 検出 cancel**。
daily `timeout-minutes` は seed 短縮（F-0053）後に圧縮（force_seed 例外時のみ長時間）。Node に `--max-old-space-size`（§D）。

**受け入れ条件**:

- [ ] 両 workflow に sqlite cache の save/restore step が存在しない
- 検証: yml 静的検査（`actions/cache` の sqlite key 不在）
- [ ] 取得/加工が lock 外で走り、commit/push のみ直列化される
- 検証: ジョブ構成レビュー＋模擬 stuck で hourly が時間内完走（`test`/手動 dispatch）
- [ ] 模擬 zombie（stuck daily）が hourly を恒久ブロックしない
- 検証: dry-run シナリオ（M5）で後続が reclaim/cancel される
- [ ] daily が `NODE_OPTIONS=--max-old-space-size=4096` 下で OOM せず完走
- 検証: M5 実測（§D）

> 注：稼働中 cron / #21 には触れない。workflow 改修は M5 で**手動 dispatch 検証 → 最終段(M_n)で cron 再開**。

---

## §D. 性能・メモリ妥当性（6,352 series / 約87,000 話）

**実測ベース**（`data/` 現況）：`works.json`=14.8MB、`tags.json`=2.8MB、`ranking.json`=81KB、
`series/`=**172MB / 6,352 ファイル**（最大 ~516KB）。episodes 総数 ≈ 8.7万。

| 局面                                                  | ピーク常駐                                                           | 妥当性                                                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **daily 全ロード**（`series/*.json` 172MB を Map 化） | JS heap ≈ **0.5–1.0GB**（JSON→V8 で約 3–6×。文字列主体なので下寄り） | runner 7GB。`--max-old-space-size=4096` で安全。**必要時は series 逐次ストリーム**（後述）で 200–400MB に圧縮可 |
| **snapshot 結果**（~87k 話・title/desc/tags 文字列）  | ≈ **150–250MB**                                                      | 単独では軽量。daily の支配項                                                                                    |
| **metrics 二段パス**                                  | 集計は per-series の数値のみ（6,352×数十バイト ≈ 数MB）              | episodes 本体は pass1 で解放可。実質無視できる                                                                  |
| **hourly**                                            | 索引（id→title ≈ 1–3MB）＋触れた数 series のみ                       | **172MB ロードを回避**＝毎時軽量。RSS 数KB＋nvapi 数件                                                          |
| **書き出し**                                          | per-series は 1 ファイルずつ stream write                            | I/O は現行 export と同等（既に 6,352 files 書込済み）                                                           |

**最適化指針（gen-code で適用）**

- daily は **series 逐次処理**を既定にする：`for (file of seriesFiles){ load1 → snapshot map で更新 → 集計を記録 → writeBack1 → 解放 }`。
  常駐＝「snapshot map（~200MB）＋ per-series 集計（~数MB）＋ 1 series」。**全 series を同時に Map 保持しない**設計を推奨。
- 例外：franchise union-find と tags 辞書集計は全 series の `title`/`tags` を要する。これらは **軽量フィールドのみ**（title/tags 文字列）を別 Map に集約（episodes 本体は不要）＝ ~数十MB。
- `JSON.parse`/`stringify` の累積 CPU：6,352 ファイル × 2（読+書）≈ 軽い（現行 export 実績内）。daily 全体は数十秒〜数分想定（ネットワーク待ちが支配）。
- **結論：純JS でメモリ・時間とも妥当**。SQLite 撤去でネイティブビルド/cache 依存が消え、むしろ CI は安定化。

---

## §I. 運用 Q&A（フルロード/冪等/頻度/性能/ToS・数字根拠つき）

> v2（§0）前提。**取得層 `scripts/nico/*`・`scripts/lib/http.mjs` は無改修**＝リクエスト数・間隔は現行と不変。

### I-1. フルロードで何が起きるか（daily full・逐次ストリーム既定）

`loadStore`（`series/*.json`＋`state/*` を parse・global `contentId→seriesId` 索引構築）→ snapshot フル取得（フラット配列）→
**series 逐次**で `upsertEpisodes`（既存＝prev 退避し view 更新／新規＝孤児）→ list.json で availability 同期 →
seed（孤児駆動・週次/force）→ RSS → ETL 派生（overview/tags/cours/franchise/thumb/timestamp）→ metrics 二段パス（全体 min/max）→
verify（detectShrink＋invariant・§0-6）→ **1 state トランザクションで writeBack**（temp→検証→atomic swap・§0-3）→ projection 全生成 → deploy。
常駐を抑えるため **snapshot map（~200MB）＋ 1 series ファイル＋軽量集計**だけを保持（全 series 同時 Map 化は回避）。

### I-2. 日次でアップサートされるか（冪等）

`episodes:Map<contentId>`。**既存**＝`prevViewCounter=旧view`に退避し view/counts/tags 上書き（seriesId/episodeNo 保全）、**新規**＝挿入（prev=null）。
現行 SQL `ON CONFLICT(content_id)` と同一。**identity（contentId）で重複せず**、同 snapshot 再実行は prev=view となり delta=0 に収束＝冪等。書き戻しは決定的シリアライズ（変化したファイルのみ diff）。

### I-3. データフロー（一方向・3 経路）

`取得(snapshot/rss/nvapi) → Store(JS Map) → 派生/集計 → projection(JSON) → state push → Pages`。**projection を Store 入力に読み戻さない**。

- **daily（全体）**：snapshot 全件 upsert＋全派生＋全 projection。
- **hourly（部分増分）**：RSS 新着 → 触れた series のみ append＋`new.json` のみ。works/ranking/tags/cours は不変（§0-4）。
- **seed（孤児駆動）**：孤児存在/週次/force で候補 series（新規 list→話数不足→閾値超で全件 fallback）を nvapi 紐付け（§0-5）。

### I-4. 全作品の再生数等はいつ更新されるか

**全件 refresh＝daily full の 1 日 1 回**（snapshot version 変化時。不変なら version gate で skip＝その日は据置＝負荷削減の設計）。
hourly は**触れたシリーズ（新着のあった作品）だけ**＝全件は更新しない。ranking/Hot 再計算も daily のみ。→ **「全件最新化＝日次」**で確定。

### I-5. フルロード所要（純JS化後・実測ベース）

| ケース                     | 現状        | 純JS後                                                       | 律速                                           |
| -------------------------- | ----------- | ------------------------------------------------------------ | ---------------------------------------------- |
| snapshot 単体（seed 無し） | ~18 分      | **~18–20 分**（+JSON load/parse 172MB ~10–20s、export 同等） | **ネットワーク＋ToS≥500ms**（JS 処理は数秒〜） |
| seed 込み（週次）          | ~100–120 分 | **~100–105 分**（snapshot ~18＋seed ~85）                    | seed = 6,299×≥500ms≈85 分（network 律速）      |

SQLite→JS の差は **誤差（数十秒）**。fetch が支配的で、加工が SQL か JS かは所要にほぼ無影響。

### I-6. メモリは足りるか

| 方式                           | heap ピーク                                                         | 妥当性               |
| ------------------------------ | ------------------------------------------------------------------- | -------------------- |
| 逐次ストリーム（既定）         | **~250–400MB**（snapshot map ~150–250MB＋1 series＋軽量集計 ~数MB） | runner 7GB に余裕    |
| 全 series 同時ロード（非推奨） | ~0.5–1.2GB                                                          | それでも収まるが回避 |

`NODE_OPTIONS=--max-old-space-size=4096` を安全弁に設定。87k 話×~600B＋V8 overhead が見積り根拠。

### I-7. ニコニコ API 負荷（源ごとに正当化の根拠が異なる・「ToS 順守」と一括できない）

> 根拠：`.claude/skills/nico-snapshot-api/SKILL.md` は依存先を **公式/半公式/非公式の 3 段階**に明記（同 L27–31）。
> **純JS 化で取得回数・間隔は一切変わらない**（`scripts/lib/http.mjs` の `fetchWithToS` 無改修）。源ごとに切り分ける：

**(a) snapshot 検索API v2 ＝ 公式 API（公式ガイドライン準拠）**

- 公式ガイド：https://site.nicovideo.jp/search-api-docs/snapshot （SKILL.md L11「本書はこのガイドに準拠」・L29 公式段）。
- ガイドが定める**定性レート規範に実装が直接対応**（SKILL.md L13–22）：
- 非営利のみ（L15）／UA 必須・アプリ名入り（L16）→ `NICO_USER_AGENT`。
- 「連打しない＝**前回レスポンスにかかった時間ぶん待ってから**次」（L17）→ `Math.max(_lastResponseMs, 500)` で**逐次・≥500ms**。
- 503 は **5 分以上空けてリトライ**（L18）→ `backoff503Ms=5*60*1000`。
- 索引は **AM5:00 頃の日次更新・高頻度取得に意味なし**（L19）→ JST05:00 起動＋**version gate で不変日 skip**。
- `_context` 必須（L52）。CORS 回避で CI fetch→静的 JSON（L20）。
- 我々の量：15 年窓×ページ（`_limit=100`）＝概ね **~1–2 千 req/日**（pre-filter 行数依存の**当方見積り**・上限値はガイド非明記＝数値準拠は主張しない）。**定性規範には適合**。
- **結論：この源は「公式ガイドライン準拠」と根拠づけられる。**

**(b) RSS（`ch2632720/video?rss=2.0`）＝ 公開フィード（半公式・SKILL.md L30）**

- **1 req/時（page1）・条件付き GET（304 ならほぼ無負荷）**（L133）。公開フィードの低頻度・良識的利用。公式 API 規約ではない＝「規約準拠」とは言わず**公開フィードの常識的利用**と位置づける。変更検知アサート必須（L135）。

**(c) nvapi `v2/series/<id>` ＝ 非公式の内部 API（規約上の明示許可なし・SKILL.md L31）**

- SKILL.md は nvapi を「**非公式（ドキュメント無し・予告なく仕様変更/廃止されうる）**」と明記（L31）。**公式開発者規約で利用が明示許可されているわけではない**＝**「ToS 順守」と断言できない**。
- 実際の正当化は **「人間のブラウザ閲覧と同等以下の低負荷な良識的利用」**：逐次・**≥500ms**・UA＋`X-Frontend-Id:6`・**週次**・低 volume（seed ~6,299 req/週・hourly は新規シリーズ時のみ数件）。連続バーストや並列はしない。
- **リスクとフォールバック**（誇張せず明記）：いつ壊れてもおかしくない前提で**変更検知アサートで守る**（SKILL.md L23–25）。nvapi が失敗/廃止された場合：
- **既存の紐付けは正本 JSON（§0-1）に永続済み＝無影響**。snapshot/RSS/list/period は継続。
- **新規シリーズの紐付けのみ縮退**：未解決話は `rss_only` として `new.json` に出すに留め（誤統合しない）、シリーズ束ねは nvapi 回復まで保留。アサート失敗は fail させ痩せ JSON を公開しない。
- **結論：この源は「公式規約準拠」ではなく「低負荷の良識的利用＋縮退設計」。** snapshot で代替不能（series id を持たないため）な箇所に限定して使う。

**まとめ（負荷ポリシー）**：公式(snapshot)＝**ガイドライン準拠**／半公式(RSS)＝**公開フィードの低頻度利用**／非公式(nvapi)＝**規約上の明示許可ではない、ブラウザ同等以下の良識的利用＋フォールバック**。純JS 化はこの姿勢を一切変えない（取得層無改修）。

---

## §E. 段階移行（M0–M8・cron 再開→物理削除は最終段）

> 各段は独立ロールバック可能。**稼働中 cron は M7 まで触れない**（現状 disabled の前提を維持）。ライブ 6,299 を壊さない。

| 段        | 作業                                                                                                                          | 成果物                                         | 検証/Exit                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| **M0**    | 本 L3 確定・型/契約レビュー（`types.ts` 不変を確認）                                                                          | 合意済み PH-0008                               | 受け入れ条件が全 F に存在                                                    |
| **M-pre** | **正本 enrich 移行**（§0-1）：現行 DB から `prevViewCounter`/`isCurated`/配信終了 series を series JSON＋state に焼き込む     | 正本スキーマ確立                               | enrich 後の正本だけで Store 復元でき、後続が DB を要さない                   |
| **M1**    | `scripts/store/store.mjs`（F-0050）＋単体テスト                                                                               | Store + load/writeBack                         | `test_store_*`/`test_loadstore_roundtrip` green                              |
| **M2**    | etl/export/rss を Store 版へ移植（A-3/A-4/A-6）・**SQL 実装と数値一致の併走テスト**＋順序/null/tiebreak fixture（§0-2/M3/M4） | 移植済み関数群＋golden SQL oracle 凍結（§0-8） | `test_metrics_js_matches_sql` 等で SQL ⇄ JS 等価                             |
| **M3**    | `fetch.mjs --mode=full` を Store 経路に（F-0051/0053/0054・**global 索引＋state トランザクション**§0-3）                      | 純JS daily（ローカル）                         | ローカルで `data/` 再生成し ep>0=6,299 再現・projection スキーマ一致         |
| **M4**    | `--mode=hourly` 部分増分（F-0052・**works 読み戻し無し**§0-4）                                                                | 純JS hourly                                    | `test_hourly_no_global_rewrite`/`cannot_shrink`/`projection_not_input` green |
| **M5**    | workflow 改修（F-0055・cache撤去/**楽観ロック**§0-7/zombie/`max-old-space`）を**手動 dispatch のみ**で検証                    | 改修 yml（cron 無効・旧経路 flag 温存）        | 手動 run で daily/hourly 完走・OOM 無し・push 競合/stuck 模擬で非破壊        |
| **M6**    | **JS 経路を既定化**（旧 DB 経路は flag 裏に温存・物理削除しない・§0-8）                                                       | 既定＝純JS                                     | `pnpm test/typecheck/lint/build` 全通過・既定経路に DB 参照 0                |
| **M7**    | **cron 再開**（hourly→daily 順・24h+観測）                                                                                    | 本番稼働                                       | 痩せ/churn/zombie/state drift 無し（invariant ログ健全）                     |
| **M8**    | **SQLite 物理削除**（`better-sqlite3`/`db.mjs`/旧 workflow/oracle 撤去）                                                      | 脱 SQLite 完了                                 | M7 観測 OK 後のみ実施・DB 参照 0                                             |

---

## §F. ファイル変更スコープ（新規/改修/削除）

| 区分       | パス                                                                                             | 内容                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **新規**   | `scripts/store/store.mjs`                                                                        | メモリ Store（DB 全代替・§A-1）＋ `loadStore`/`writeBackStore`                          |
| 新規       | `scripts/store/project.mjs`                                                                      | projection 生成（works/ranking/tags/cours/kana/new・§A-6 を export.mjs から移設）       |
| 新規       | `data/state/{meta,prev-views,rss}.json`（生成物・gitignore 外＝state 正本）                      | 増分 state（§B-1）                                                                      |
| 新規(任意) | `data/state/series-index.json`                                                                   | hourly 用軽量索引（§F-0052）                                                            |
| **改修**   | `scripts/fetch.mjs`                                                                              | DB 呼出を Store 呼出へ。seed を孤児駆動（F-0053）。detectShrink を予防型（F-0054）      |
| 改修       | `scripts/nico/rss.mjs`                                                                           | `resolveRssItems(db)`→`(store)`                                                         |
| 改修       | `scripts/etl/{tags,series,cours,metrics}.mjs`                                                    | DB 引数の 5 関数を Store/二段パスへ（§A-3/A-5）。純JS 関数は無改修                      |
| 改修       | `scripts/export/export.mjs`                                                                      | Store 走査へ（→ project.mjs へ移設も可）。出力スキーマ不変                              |
| 改修       | `scripts/backfill.mjs`                                                                           | `bulkUpsertEpisodes`/`updateEpisodeOrderBatch` を Store API へ（seed/backfill 共通化）  |
| 改修       | `.github/workflows/fetch-{hourly,daily}.yml`                                                     | DB cache step 撤去・最小ロック・zombie 対策・`NODE_OPTIONS`（F-0055・M5）               |
| 改修       | `package.json`                                                                                   | `better-sqlite3`/`@types/better-sqlite3`/`onlyBuiltDependencies` から sqlite 除去（M6） |
| **削除**   | `scripts/db/db.mjs`                                                                              | Store へ全面置換（M6）                                                                  |
| 削除       | DB cache 関連 yml step・`data/build.sqlite` 生成                                                 | §C                                                                                      |
| 不変       | `web/**`・`scripts/nico/{snapshot,list,period,filter}.mjs`・`http.mjs`・`scripts/lib/logger.mjs` | 取得層/フロントは無改修（契約維持）                                                     |

---

## §G. テスト・検証計画（既存テスト移行を含む）

**既存テストの現況**：`tests/db/db.test.mjs`・`tests/etl/metrics.test.mjs` 等は `openDatabase(':memory:')`＋`createSchema` で
実 DB を組む（例：metrics.test は `bulkUpsertSeries/Episodes`→`recalcSeriesMetrics`）。

| 既存テスト                                                                       | 移行方針                                                                                                                                             |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/db/db.test.mjs`                                                           | `tests/store/store.test.mjs` へ。`openDatabase(':memory:')`→`createStore()`、upsert/link/sync を Store API で検証（prev 退避・thumb/timestamp 同期） |
| `tests/etl/metrics.test.mjs`                                                     | setup を Store へ差替。**SQL ⇄ JS 等価テスト**（`test_metrics_js_matches_sql`）を M2 限定で併走（M6 で SQL 側撤去）                                  |
| `tests/etl/{tags,series,cours}.test.mjs`                                         | DB 引数の 3 関数（`deriveSeriesTags`/`deriveSeriesOverviews`/`getSeriesTagsMap`/`deriveCoursFromTags`）を Store 入力に。純JS テストは無改修          |
| `tests/export/export.test.mjs`                                                   | Store→projection で同スキーマ assert（出力契約不変を担保）                                                                                           |
| `tests/nico/rss.test.mjs`                                                        | `resolveRssItems` を Store 版に。他は無改修                                                                                                          |
| `tests/nico/{snapshot,filter,assert,period,nvapi,http}.test.mjs`・`tests/web/**` | **無改修**（取得層/フロントは契約維持）                                                                                                              |

**新規テスト**：F-0050〜0055 各受け入れ条件のテスト（上記 `test_*`）。

**統合/性能検証**

- **等価性**：移行前後で `data/*.json` を生成し diff（集計の浮動小数許容）＝ ep>0 distinct=6,299・works 行数不変。
- **縮小不能ファズ**：state を空/痩せ/壊れで与え、projection が baseline×0.9 を割らない（割る入力は skip）。
- **hourly blast radius**：実行前後で ranking/tags/cours がバイト不変。
- **冪等**：同入力 2 回連続で state diff が 2 回目空。
- **メモリ**：M5 で daily を `--max-old-space-size=4096` 実測（OOM 無し・ピーク記録）。
- `pnpm test`/`typecheck`/`lint`/`build` 全通過（M6 で better-sqlite3 不在のまま green）。

---

## Exit Criteria

- [ ] `better-sqlite3`・`scripts/db/db.mjs`・DB cache が**完全に消え**、`pnpm fetch`（full/hourly）が純JS で `data/*.json` を生成する
- [ ] 正本＝`series/*.json`＋`state/*.json` から Store を再構築でき、cache 喪失時も nvapi 無しで完全復元（importer 不要）
- [ ] daily 全体／hourly 部分増分／seed 孤児駆動が SQLite 無しで動作し、**hourly は全件を縮小し得ない**
- [ ] 予防型 detectShrink＋verify が痩せ出力を構造的に阻止（baseline=確定済み正本固定）
- [ ] workflow から DB cache が撤去され、最小ロック＋zombie 耐性で連鎖凍結が起きない（M5 検証）
- [ ] 6,352 series/8.7万話を `--max-old-space-size=4096` 内で完走（§D 実測）
- [ ] 既存テスト移行＋新規テストが green・`types.ts` 出力契約は不変
- [ ] cron 再開（M7）後 24h 観測で痩せ/churn/zombie 無し
