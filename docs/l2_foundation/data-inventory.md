# データインベントリ（Data Dictionary）

dアニメストア ニコニコ支店ビューア — システムが保持する全データの一覧。
「何のデータをどこにどう持っているか」を網羅した参照ドキュメント。

---

## 目次

1. [データレイヤー概要](#1-データレイヤー概要)
2. [State ブランチ — 永続正本](#2-state-ブランチ--永続正本)
   - [state/meta.json](#21-statemeta-json)
   - [state/prev-views.json](#22-stateprev-viewsjson)
   - [state/rss.json — RssEntry](#23-staterss-json--rssentry)
   - [state/series-index.json](#24-stateseries-indexjson)
   - [state/list-index.json](#25-statelist-indexjson)
   - [series/\<id\>.json — SeriesEntry + EpisodeEntry](#26-seriesid-json--seriesentry--episodeentry)
3. [仮シリーズ（負 seriesId）](#3-仮シリーズ負-seriesid)
4. [配信 output — 毎日再生成](#4-配信-output--毎日再生成)
   - [works.json](#41-worksjson)
   - [ranking.json](#42-rankingjson)
   - [tags.json](#43-tagsjson)
   - [cours.json](#44-coursjson)
   - [kana.json](#45-kanajson)
   - [new.json](#46-newjson)
5. [Repo Config](#5-repo-config)
6. [揮発データ](#6-揮発データ)
7. [データフロー](#7-データフロー)

---

## 1. データレイヤー概要

| レイヤー        | 場所                             | 性質                             |
| --------------- | -------------------------------- | -------------------------------- |
| **State 正本**  | `data/state/` + `data/series/`   | 永続・プロセス跨ぎで保持         |
| **配信 output** | `data/*.json`（works/ranking等） | 毎日再生成・git 追跡・Pages 配信 |
| **Repo Config** | `docs/data/`                     | 手動設定（現在は空）             |
| **揮発**        | メモリ・一時ファイル             | プロセス終了で消滅               |

`data/series/` と `data/state/` は `.gitignore` 対象（main ブランチ管理外）。
state ブランチへの rsync で永続化される。

---

## 2. State ブランチ — 永続正本

### 2.1 `state/meta.json`

システム全体のカーソル・バージョン情報。毎時・日次ともに最後に上書き。

| フィールド                    | 型             | 内容                                                        | 更新タイミング    |
| ----------------------------- | -------------- | ----------------------------------------------------------- | ----------------- |
| `rssLastGuid`                 | `string\|null` | 毎時 RSS ページング cursor（既読の最新 guid）               | 毎時 D フェーズ   |
| `snapshotLastStartTime`       | `string\|null` | snapshot 増分取得用（前回最終 startTime）                   | 日次 Phase A      |
| `snapshotVersionLastModified` | `string\|null` | 日次 version gate の前回値（変化なし → 早期終了）           | 日次 Phase A      |
| `lastSeedAt`                  | `string\|null` | nvapi seed 最終実行時刻                                     | 日次（seed 時）   |
| `snapshotFetchedAt`           | `string\|null` | Phase A 完全完了の ISO8601（E7 isAvailable 評価の基準時刻） | 日次 Phase A 末尾 |

lifecycle: **永続（毎回上書き）**

---

### 2.2 `state/prev-views.json`

```json
{ "so1234567": 430000, "so7654321": 82000, ... }
```

| キー                    | 値       | 内容                             |
| ----------------------- | -------- | -------------------------------- |
| `contentId`（so… 形式） | `number` | 前回日次終了時点の `viewCounter` |

**用途**: 次回日次実行時に `loadStore` が EpisodeEntry.prevViewCounter に注入 → delta/hotScore 計算の差分元。
`series/*.json` には書かない（メモリ注入専用）。

lifecycle: **毎日全件上書き**（`writeBackStore` 末尾で全 ep を一括書き出し）

---

### 2.3 `state/rss.json` — RssEntry

```json
{
  "lastGuid": "tag:nicovideo.jp,...",
  "items": [ ...RssEntry ]
}
```

`lastGuid` は `meta.rssLastGuid` の別名（互換フィールド）。`items` の上限は **200 件**（resolved → pending の古い順で trim）。

**RssEntry 全フィールド**:

| フィールド          | 型                      | 内容                                                                        | 更新元       |
| ------------------- | ----------------------- | --------------------------------------------------------------------------- | ------------ |
| `watchId`           | `string`                | 数値 watch ID（RSS 由来）。`so…` contentId とは別形式                       | RSS fetch    |
| `guid`              | `string\|null`          | RSS `<guid>` 文字列                                                         | RSS fetch    |
| `pubDate`           | `string\|null`          | 公開日時（RFC2822 or ISO8601）                                              | RSS fetch    |
| `title`             | `string\|null`          | 話タイトル生文字列                                                          | RSS fetch    |
| `titleNorm`         | `string\|null`          | 正規化タイトル（マッチング用）※現在は常に null                              | 未実装       |
| `link`              | `string\|null`          | 公式視聴 URL                                                                | RSS fetch    |
| `description`       | `string\|null`          | `<description>` HTML CDATA（暫定あらすじ）                                  | RSS fetch    |
| `thumbnailUrl`      | `string\|null`          | `<media:thumbnail>` URL。contentId 復元（`contentIdFromThumbnail()`）に必須 | RSS fetch    |
| `resolvedContentId` | `string\|null`          | thumbnailUrl から復元した `so…` contentId                                   | 毎時 D2      |
| `resolutionStatus`  | `'pending'\|'resolved'` | 解決状態                                                                    | 毎時 D2 / D3 |

lifecycle: **ローテーション（上限 200 の滑走窓）**

---

### 2.4 `state/series-index.json`

```json
{ "so1234567": 1000001, "so9876543": -78665789, ... }
```

全エピソードの `contentId → seriesId` 逆引きインデックス。

| 内容     | 詳細                                                                  |
| -------- | --------------------------------------------------------------------- |
| キー     | `contentId`（so… 形式）                                               |
| 値       | `seriesId`（正数 = 実、負数 = 仮）                                    |
| 読む場所 | 毎時 `loadPartialStore` — series-index から D2 の直接解決マップを構築 |
| 書く場所 | 日次 `writeBackStore`（全件）、毎時（dirty 差分マージ）               |

lifecycle: **毎回全件上書き（日次）/ 差分マージ（毎時）**

---

### 2.5 `state/list-index.json`

```json
[{ "seriesId": 1000001, "title": "〇〇の物語" }, ...]
```

`list.json` 由来のタイトル → seriesId マップ（配列形式で永続化、読込時に Map 化）。

| 内容                 | 詳細                                                                |
| -------------------- | ------------------------------------------------------------------- |
| 書く場所             | 日次 Phase B5（detectShrink 通過後に書く）                          |
| 読む場所             | 毎時 D2 — `loadListIndexCache()` で Map に変換して RSS タイトル照合 |
| list.json 取得失敗時 | スキップ（上書きせず古いキャッシュを保持）                          |

lifecycle: **日次再生成**

---

### 2.6 `series/<id>.json` — SeriesEntry + EpisodeEntry

1 ファイル = 1 シリーズ（正数 id = 実シリーズ、負数 id = 仮シリーズ）。
format は両者同一。

#### SeriesEntry フィールド

**ファイル永続化フィールド**（`_buildSeriesJson` が書き出す）:

| フィールド         | 型                                      | 内容                                                               | 更新元                       |
| ------------------ | --------------------------------------- | ------------------------------------------------------------------ | ---------------------------- |
| `seriesId`         | `number`                                | 正数 = nvapi 実 ID、負数 = djb2 ハッシュ仮 ID（不変）              | 初期化時のみ                 |
| `title`            | `string`                                | シリーズ名                                                         | nvapi / list.json / RSS 抽出 |
| `colKey`           | `string\|null`                          | 五十音分類キー（`list.json` 固有）                                 | Phase B4                     |
| `thumbnailUrl`     | `string\|null`                          | サムネ URL（COALESCE: 既存があれば保護、なければ最古 ep から補完） | Phase E6 syncThumbs          |
| `descriptionFirst` | `string\|null`                          | 最古話の HTML 剥ぎ description                                     | Phase E1                     |
| `firstSeen`        | `string\|null`                          | 最古話 startTime ISO8601                                           | Phase E5 syncTimestamps      |
| `lastSeen`         | `string\|null`                          | 最新話 startTime ISO8601                                           | Phase E5 syncTimestamps      |
| `lastSeenAt`       | `string\|null`                          | snapshot に最後に登場した日時（E7 isAvailable 評価に使う）         | Phase A 日次                 |
| `cours`            | `string\|null`                          | 放送季 `'YYYY-季'` 形式（タグ主源）                                | Phase E3                     |
| `franchiseKey`     | `string\|null`                          | シリーズタグ union-find キー（関連シリーズ束ね）                   | Phase E4                     |
| `isAvailable`      | `boolean`                               | 配信中フラグ（E7 grace で自動 on/off）                             | Phase E7                     |
| `tags`             | `{name:string, isCurated:boolean}[]`    | 正規化済みシリーズタグ                                             | Phase E2                     |
| `relatedSeries`    | `{seriesId,title,thumbnailUrl\|null}[]` | 同フランチャイズ内の他シリーズ                                     | Phase E4                     |
| `episodes`         | `EpisodeEntry[]`                        | 話一覧（chronoSort 順）                                            | 各フェーズ                   |

**メモリのみ（ファイル非永続）**:

| フィールド   | 型  | 内容                            |
| ------------ | --- | ------------------------------- |
| `lastSeenAt` | —   | ※上表に含む（ファイルにも書く） |

> **注**: `tags` はファイルでは `string[]`（name のみ）で書き出し、ロード時に `{name, isCurated:false}` に変換される。isCurated 情報は実行時のみ。

---

#### EpisodeEntry フィールド

**ファイル永続化フィールド**（series JSON の `episodes[]` 配列内）:

| フィールド       | 型             | 内容                                             | 更新元           |
| ---------------- | -------------- | ------------------------------------------------ | ---------------- |
| `contentId`      | `string`       | `so…` 形式 ID（不変）                            | snapshot / RSS   |
| `episodeNo`      | `number\|null` | 話番号（nvapi 由来・一度確定したら保護）         | nvapi            |
| `title`          | `string`       | 話タイトル（nvapi 由来優先・一度確定したら保護） | snapshot / nvapi |
| `viewCounter`    | `number\|null` | 再生数（snapshot 毎回上書き）                    | snapshot         |
| `commentCounter` | `number\|null` | コメント数                                       | snapshot         |
| `likeCounter`    | `number\|null` | いいね数                                         | snapshot         |
| `mylistCounter`  | `number\|null` | マイリスト数                                     | snapshot         |
| `lengthSeconds`  | `number\|null` | 尺（秒）                                         | snapshot         |
| `startTime`      | `string\|null` | 公開日時 ISO8601（nvapi 由来優先・保護）         | snapshot / nvapi |
| `thumbnailUrl`   | `string\|null` | サムネ URL                                       | snapshot         |
| `description`    | `string\|null` | あらすじ生 HTML（HTML strip は projection 時）   | snapshot         |
| `tags`           | `string[]`     | 正規化タグ名配列                                 | snapshot / E2    |
| `tagsCurated`    | `string[]`     | キュレーションタグ部分集合（`tags` の subset）   | E2               |
| `lastUpdated`    | `string\|null` | 実変化があった最終 ISO8601                       | 変化時           |

**メモリのみ — ファイル非永続**:

| フィールド        | 型             | 内容                                                                                 | 注入元                                             |
| ----------------- | -------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `seriesId`        | `number\|null` | null=orphan、負=仮シリーズ。series JSON のファイル名（キー）から再構築される         | `_ingestSeriesJson()`                              |
| `prevViewCounter` | `number\|null` | 前回 viewCounter（delta/hotScore 計算用）。writeBack 時は series JSON に**含めない** | `_loadState()` が `state/prev-views.json` から注入 |

---

## 3. 仮シリーズ（負 seriesId）

RSS 新着またはスナップショット ep のシリーズが特定できないとき、仮の負数 ID でシリーズを登録する仕組み。

### ID 生成式（djb2 variant）

```js
// provisionalSeriesId(seriesTitle) in scripts/nico/list.mjs
let h = 0
for (const ch of title) h = (Math.imul(h, 31) + ch.codePointAt(0)) | 0
return h <= 0 ? h - 1 : -h // 必ず負数・0 にならない
```

同タイトルなら常に同じ負数 ID になる（決定的）。

### ライフサイクル

| フェーズ                      | 処理                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **作成（毎時 D2）**           | RSS ep が `list-index` でタイトル未解決 → `registerProvisionalSeries()` → `seriesId<0` の series + ep を store に登録                                                                                                                   |
| **作成（日次 A2 step3）**     | snapshot ep が全解決ルート失敗 → 同関数を呼んで仮シリーズ登録                                                                                                                                                                           |
| `isAvailable`                 | 常に `true` 固定（E7 grace の評価対象外）                                                                                                                                                                                               |
| **reconciliation（日次 B6）** | 実シリーズの `allTitles` マップと完全一致照合 → nvapi 検証（支店判定 + 仮 ep の contentId が nvapi 話一覧に存在）→ 検証 OK なら ep の `seriesId` を実 ID に付け替え → `store.series.delete(neg)` + `unlinkSync(data/series/<neg>.json)` |
| **cleanup（日次 A2 末尾）**   | A2 step2 で ep が実 ID に付け替えられた後、空になった仮シリーズを B6 同様に `delete` + `unlinkSync`                                                                                                                                     |
| **ファイル残存リスク**        | 削除せずに次回 `loadStore` で再インジェストされると seriesId が揺れる → B6/A2 cleanup で必ず消す設計                                                                                                                                    |

---

## 4. 配信 output — 毎日再生成

`scripts/store/project.mjs` の `projectAll()` が Store → 配信 JSON を生成する。
`data/series/*.json` は `writeBackStore()` が担当（project.mjs は書かない）。

### 4.1 `works.json`

全シリーズのサマリー（`isAvailable=false` の tombstone も含む）。

```json
{ "lastUpdated": "ISO8601", "works": [ ...WorkEntry ] }
```

**WorkEntry フィールド**:

| フィールド         | 型                                | 内容                           |
| ------------------ | --------------------------------- | ------------------------------ |
| `seriesId`         | `number`                          | シリーズ ID                    |
| `title`            | `string`                          | シリーズ名                     |
| `thumbnailUrl`     | `string\|null`                    | サムネ URL                     |
| `descriptionFirst` | `string\|null`                    | 最古話あらすじ（HTML剥ぎ済み） |
| `tags`             | `string[]`                        | 正規化タグ名                   |
| `cours`            | `string\|null`                    | 放送季                         |
| `franchiseKey`     | `string\|null`                    | フランチャイズキー             |
| `colKey`           | `string\|null`                    | 五十音キー                     |
| `isAvailable`      | `boolean`                         | 配信中フラグ                   |
| `episodeCount`     | `number`                          | 話数                           |
| `latestAt`         | `string\|null`                    | 最新話 startTime               |
| `firstAt`          | `string\|null`                    | 最古話 startTime               |
| `commentTotal`     | `number`                          | コメント数合計                 |
| `mylistTotal`      | `number`                          | マイリスト数合計               |
| `mylistFirst`      | `number`                          | 第1話マイリスト数              |
| `durationTotal`    | `number`                          | 総尺（秒）                     |
| `totalViews`       | `number`                          | 累計再生数                     |
| `hotScore`         | `number`                          | 勢いスコア（0〜1）             |
| `relatedSeries`    | `{seriesId,title,thumbnailUrl}[]` | 関連シリーズ                   |

ソート: `seriesId` 昇順（決定的順序）。
`isAvailable=false`: **含む**（UI 側でフィルタ）。

---

### 4.2 `ranking.json`

```json
{
  "lastUpdated": "ISO8601",
  "hot": [ ...RankEntry(上位200) ],
  "popular": [ ...RankEntry(上位200) ],
  "hotTiers": { "t1": 0.xx, "t2": 0.xx, "t3": 0.xx }
}
```

**RankEntry**: `{ seriesId, title, thumbnailUrl, totalViews, hotScore }`

**hotScore 算式** (`recalcSeriesMetricsJS`):

```
delta_n   = 正規化( Σ(viewCounter - prevViewCounter) )  ← 前日比
velocity_n = 正規化( log1p(totalViews / max(1, daysSinceFirst)) )  ← 速度
recency_n  = exp( -recencyDays / 14 )                   ← 新しさ（τ=14日）
hotScore   = 0.5×delta_n + 0.3×velocity_n + 0.2×recency_n
```

**hotTiers**: 全シリーズ hotScore の percentile（t1=90th、t2=95th、t3=99th）。UI の炎ティア表示に使う。

`isAvailable=false`: **除外**。

---

### 4.3 `tags.json`

```json
{
  "lastUpdated": "ISO8601",
  "tags": [ { "name": "魔法少女", "isCurated": true, "seriesCount": 42 }, ... ],
  "topHotTags": ["魔法少女", ...],
  "topPopularTags": ["魔法少女", ...]
}
```

| フィールド       | 内容                                      |
| ---------------- | ----------------------------------------- |
| `tags`           | 全タグ一覧（`seriesCount` 降順）          |
| `topHotTags`     | hot 上位 20 シリーズの頻出タグ上位 10     |
| `topPopularTags` | popular 上位 20 シリーズの頻出タグ上位 10 |

`isAvailable=false`: **除外**。

---

### 4.4 `cours.json`

```json
{
  "lastUpdated": "ISO8601",
  "cours": [
    { "cours": "2025-夏", "seriesIds": [1000001, 1000002, ...] },
    ...
  ]
}
```

放送季（`YYYY-季`）→ seriesId[] のグルーピング。ソート: cours 降順、seriesIds 昇順。

`isAvailable=false`: **除外**。

---

### 4.5 `kana.json`

```json
{
  "lastUpdated": "ISO8601",
  "kana": [
    { "colKey": "あ", "seriesIds": [1000001, 1000002, ...] },
    ...
  ]
}
```

colKey（五十音分類キー）→ seriesId[] のグルーピング。colKey 昇順、seriesIds はタイトル昇順。

`isAvailable=false`: **colKey があれば含む**（五十音 UI でグレーアウト表示）。

---

### 4.6 `new.json`

```json
{
  "lastUpdated": "ISO8601",
  "items": [ ...NewItem(最新100件) ]
}
```

**NewItem フィールド**:

| フィールド          | 型                      | 内容                                        |
| ------------------- | ----------------------- | ------------------------------------------- |
| `watchId`           | `string`                | 数値 watch ID                               |
| `title`             | `string\|null`          | 話タイトル                                  |
| `pubDate`           | `string\|null`          | 公開日時                                    |
| `resolvedContentId` | `string\|null`          | 解決済み contentId（so… 形式）              |
| `resolutionStatus`  | `'pending'\|'resolved'` | 解決状態                                    |
| `thumbnailUrl`      | `string\|null`          | ep のサムネ（resolvedContentId 経由で取得） |
| `episodeNo`         | `number\|null`          | 話番号                                      |
| `viewCounter`       | `number\|null`          | 再生数                                      |
| `commentCounter`    | `number\|null`          | コメント数                                  |
| `mylistCounter`     | `number\|null`          | マイリスト数                                |

ソート: `pubDate` 降順、上位 100 件。
`new.json` のみ**毎時**も再生成（`exportNew` が hourly でも呼ばれる）。

---

## 5. Repo Config

| ファイル              | 場所                            | 中身 | 状態                                                                                                                                                                  |
| --------------------- | ------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cours-override.json` | `docs/data/cours-override.json` | `{}` | git 追跡済み・**コードからの参照なし**。PH-0002 で手動クール上書き用として雛形追加されたが未実装の遺物。将来実装する際はここに `{ seriesId: "YYYY-季" }` を書く想定。 |

---

## 6. 揮発データ

| データ               | 場所               | 消えるタイミング               | 内容                                                                                                        |
| -------------------- | ------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `store.series`       | プロセスメモリ     | プロセス終了                   | `Map<number, SeriesEntry>`                                                                                  |
| `store.episodes`     | プロセスメモリ     | プロセス終了                   | `Map<string, EpisodeEntry>`（prevViewCounter 含む）                                                         |
| `store.rss`          | プロセスメモリ     | プロセス終了                   | `Map<string, RssEntry>`                                                                                     |
| `store.meta`         | プロセスメモリ     | プロセス終了                   | MetaRecord オブジェクト                                                                                     |
| `store._dirtySeries` | プロセスメモリ     | `writeBackStore` 後にクリア    | `Set<number>`（変化シリーズの ID）                                                                          |
| `.deploy-needed`     | `data/` 直下       | CI deploy ジョブが消費後に削除 | `'daily\n'`（日次）または `'${insertedEpisodes}\n'`（毎時）。これが存在すると CI が Pages deploy を走らせる |
| `dist/`              | プロジェクトルート | `pnpm build` 毎に再生成        | Vite ビルド済み静的サイト                                                                                   |
| `*.tmp`              | 各 JSON の隣       | atomic rename 直後に消滅       | `_writeJsonCompact` が tmp 書き→ rename で atomic 更新する中間ファイル                                      |

---

## 7. データフロー

```
【毎時】
RSS ch.nicovideo.jp
  └─ fetchRssMultiPage() ──→ state/rss.json（+200件窓）
                         ──→ series/<neg>.json（仮シリーズ: list-index 未解決時）
                         ──→ series/<id>.json（D3 nvapi: 解決済みシリーズ差分）
                         ──→ state/series-index.json（差分マージ）
                         ──→ data/new.json（毎時再生成）
                         ──→ .deploy-needed（新 ep があれば）

【日次】
snapshot API ──────────→ episodes（viewCounter/tags/desc/...）→ missedContentIds 収集
list/programlist/theme JSON → seriesId union → B3 nvapi → series/*.json（新規）
                           → B4 col_key パッチ
                           → B6 仮シリーズ reconciliation（nvapi 検証 → 実 ID に統合）
A2 救出（missedContentIds） → nvapi / タイトル照合 / 仮シリーズ登録
E1-E7 ETL（descriptionFirst / tags / cours / franchiseKey / timestamps / thumbs / isAvailable）
detectShrink guard
  ├─ 縮小検出 → meta.json のみ保存・export スキップ
  └─ 正常 → writeBackStore (series/*.json + state/*.json 全量)
           → projectAll (works/ranking/tags/cours/kana.json)
           → .deploy-needed → Pages deploy

【lookup chain（仮シリーズ解消順）】
RSS watchId → list-index タイトル照合 → 解決
           → 解決失敗 → 仮シリーズ登録（series/<neg>.json）
                      ↓（次回日次 B6）
             allTitles 完全一致 + nvapi 検証 → 実 seriesId に統合 → 仮ファイル削除
```
