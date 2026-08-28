---
title: データフロー仕様
layer: L2
status: current
updated: 2026-08-08
---

# データフロー仕様（L2）

> 本書は稼働中の取得・整合化・配信フローの正本。変更の経緯は [`CHANGELOG.md`](../../CHANGELOG.md) に記録する。

---

## 1. アーキテクチャ概要

```
外部API群
  │
  ▼
scripts/fetch.mjs（GitHub Actions 内・サーバなし）
  ├─ state ブランチ（meta.json / rss.json / prev-views.json / series-index.json / list-index.json）← 永続状態
  ├─ data/series/{id}.json（正整数 = 本物・負整数 = 仮シリーズ）← 系列別エピソードリスト
  └─ data/works.json 等（配信用 JSON）→ GitHub Pages
       ▲
       ブラウザは読み取るだけ（DB直叩きなし・CORS関係なし）
```

- **インメモリ Store**: `Map<seriesId, Series>` / `Map<contentId, Episode>` / `Map<watchId, RssItem>` を起動時にロード → 処理 → 書き出し
- **永続**: state ブランチ + `data/series/{id}.json` への atomic rename（tmp→本体）
- **2 ジョブ**: 毎時（hourly-js）/ 日次（full-js）
- **isAvailable**: snapshot 由来。`series.lastSeenAt` ＋ `meta.snapshotFetchedAt` で grace 付き評価（Phase E7）。仮シリーズ（seriesId < 0）は grace 対象外
- **seriesId 解決**: 全 static JSON と確認済み title hint から候補を作り、nvapi の支店所有情報と各話一覧で検証する。`items` が取得できない環境では、支店所有・シリーズタイトル一致・厳格な各話タイトル照合がすべて成立する場合だけ補完する。未解決話は負数の仮 seriesId で保持する
- **整合化**: 毎時 B6/D3b は仮→実を統合する。日次 B7 は既知の正→正不一致を毎回優先しつつ全正シリーズを巡回し、A2 後の B7b が export 前に不一致を再確認する

---

## 2. フローチャート

### 2-1. 全体俯瞰図

どのデータソースをどのジョブが使い、何を出力するかを示す。

```mermaid
flowchart TB
    subgraph SRC["データソース"]
        RSS["チャンネル RSS\n新着（最大 5 ページ・100件）"]
        NV["nvapi v2/series\n全話・再生数・コメント・尺"]
        SN["snapshot 検索 v2\ntags / desc / 全話"]
        LJ["全 static JSON × 8\nlist / programlist /\nexclusiveAndFastest /\narchiveExclusive / theme1〜6"]
    end

    H["⏰ 毎時\nhourly-js"]
    FJ["📅 日次\nfull-js"]

    subgraph OUT["出力（state ブランチ + Pages）"]
        ST["state ブランチ\nmeta / rss / series-index / list-index"]
        SJ["series/{id}.json\n（正整数=本物・負整数=仮）"]
        GP["GitHub Pages\nworks / ranking / new …"]
    end

    RSS -->|"Phase D"| H
    NV -->|"D3（正整数 seriesId のみ）"| H
    H --> ST & SJ
    H -->|"insertedEpisodes>0\nOR hasProvisional"| GP

    SN -->|"Phase A"| FJ
    LJ -->|"Phase B: union→nvapi→col_key\n→reconciliation"| FJ
    NV -->|"B3 新規シリーズ / A2 救出"| FJ
    FJ --> ST & SJ & GP
```

---

### 2-2. 毎時フロー

**設計方針**: RSS pending item → list-index（タイトル照合）で seriesId 解決。照合失敗は仮シリーズ登録。正整数 seriesId のみ nvapi で全話更新。watch ページは使わない。

**判定ルール:**

1. **RSS 新着ゼロ → 即終了**（list-index 照合・nvapi・デプロイ一切なし）
2. `pending` item → list-index 照合（正規化タイトル前方一致）
3. 照合成功 → `resolved` 昇格（resolvedSeriesIds に追加）
4. 照合失敗 → 仮シリーズ登録（thumbnailUrl → contentId 復元・タイトル抽出・負数 seriesId）
5. **D3 = 正整数 seriesId のみ**（`resolvedSeriesIds.filter(sid => sid > 0)`）
6. **deploy = `insertedEpisodes > 0 || hasProvisional`**（新着 ep 追加 OR 仮シリーズあり → deploy）

```mermaid
flowchart TD
    A(["⏰ hourly-js 起動"]) --> B["Phase D: RSS fetch\nmaxPages=5（各20件・最大100件）\nguid HWM で既知ページを早期終了\nwatchId Map で item 単位 dedup"]
    B --> C{"新 item あり?"}
    C -->|"**ゼロ → 即終了**\nnvapi/deploy なし"| Z["meta.json + rss.json 書き戻し"]
    C -->|"あり"| D["storeUpsertRss\ndescription = RSS HTML CDATA as-is\nrss.json → 200件 trim\n（resolved 優先削除・pending 最後）"]
    D --> E["Phase D2: pending 解決\nlist-index.json（前回日次の B5 出力）をロード\n各 pending item:\n  タイトル照合成功 → resolved 昇格\n  照合失敗 → 仮シリーズ登録\n    thumbnailUrl → contentId(so…) 復元\n    タイトル → seriesTitle 抽出\n    provisionalSeriesId(title) → 負数 seriesId\n    storeUpsertSeries + storeUpsertEps\n    status → resolved（仮 seriesId で）"]
    E --> F{"resolvedSeriesIds に\n正整数 seriesId あり?"}
    F -->|"なし（仮のみ or 0件）"| ZW["_trimRss + writeSeriesFiles\nseries-index 更新"]
    F -->|"あり"| G["Phase D3: nvapi v2/series × 正整数 seriesId\n全話 × viewCounter/commentCounter\nlikeCounter/mylistCounter\nregisteredAt/duration/thumbnailUrl"]
    G --> H2["storeUpsertEps（実変化チェック）\n→ _dirtySeries 更新\ninsertedEpisodes カウント"]
    H2 --> I["_trimRss(200)\nseries/{id}.json 書き出し\nseries-index 更新（負数含む）"]
    I --> J{"insertedEpisodes > 0\nOR hasProvisional?"}
    J -->|"なし"| Z
    J -->|"あり"| K["new.json 更新\nstate 書き戻し\n.deploy-needed → Pages deploy"]
    ZW --> Z
    Z --> END([" 終了"])
    K --> END
```

---

### 2-3. 日次フロー

**早期 exit ルール**: **version gate 変化なし → 即終了**（B/B7/A2/B7b/E/deploy は一切走らない）

日次の処理順: Phase A（snapshot） → Phase B（候補構築・B6/B7 整合化） → Phase A2（取得漏れ救出） → B7b（救出後整合化） → Phase E（ETL） → detectShrink → deploy

```mermaid
flowchart TD
    A(["📅 full-js 起動\nJST 07:30"]) --> B["snapshot/version 取得"]
    B --> C{"version gate\nlast_modified 変化?"}
    C -->|"**変化なし → 即終了**\nB/B7/A2/B7b/E/deploy は走らない"| ENDEARLY([" 終了（早期）"])
    C -->|"変化あり"| D["Phase A: snapshot 全件取得\n年ウィンドウ分割 ≈17分\nupsertEps（viewCounter/tags/desc/…）\n→ missedContentIds 収集（seriesId=null の ep）\n→ meta.snapshotFetchedAt = now"]
    D --> P["Phase B: 全 static JSON union（8 本）\nlist.json / programlist.json /\nexclusiveAndFastest.json / archiveExclusive.json /\ntheme1〜6.json"]
    P --> B2["B2: 各 JSON から href=/series/<id> または series:<数値> 抽出\n全 seriesId を Set に union"]
    B2 --> B3["B3: store 未保有の新 seriesId → nvapi v2/series\n支店所有と payload を検証して\n各話・シリーズ情報を取り込む"]
    B3 --> B4["B4: list.json 掲載シリーズに\ncol_key パッチ + isAvailable=true 強制"]
    B4 --> B5["B5: list-index.json 保存\n（タイトル→seriesId Map・毎時 D2 が参照）"]
    B5 --> B6["B6: 仮シリーズ(seriesId<0) → 実シリーズ統合\nitems 非空: contentId 所属で確認\nitems 空: 支店・detail.title・各話タイトルを厳格確認\n確認済み話を移動し仮シリーズファイルを削除"]
    B6 --> B7R["B7: 日次メンバーシップ整合化\n既知タイトル不一致を毎回最優先\n+ 空シリーズ全件 + 正ID 1/7 巡回\nitems 非空は contentId 所属・話順を採用\nitems 空は安全条件成立時だけタイトル補完"]
    B7R --> A2["Phase A2: 取得漏れ救出\n① store の contentId→seriesId Map で直接解決\n② タグ/タイトル照合（最終手段）→ nvapi → ep 付け替え\n③ 全失敗 → 仮シリーズ登録（thumbnailUrl→contentId・負数 seriesId）"]
    A2 --> B7B["B7b: 救出後の既知タイトル不一致を再抽出\nB7 と同じ検証規則で export 前に整合化"]
    B7B --> LS["lastSeenAt = now\n（snapshot 出現シリーズのうち seriesId > 0）"]
    LS --> E["Phase E: ETL 派生\nE1: descriptionFirst（最古話 description）\nE2: tags 正規化（dアニメ接頭/接尾除去）\nE3: cours（タグ主源）\nE4: franchiseKey + relatedSeries\nE5: timestamps 同期\nE6: thumbnails 同期\nE7: isAvailable grace\n    snapshotFetchedAt > 3日前 → 評価スキップ\n    lastSeenAt < (snapshotFetchedAt - 2日) → false\n    ※ seriesId < 0（仮）は grace スキップ（isAvailable 固定 true）"]
    E --> F{"detectShrink\nep>0件数 < baseline×90%?"}
    F -->|"縮小検出"| G["meta.json のみ保存\nexport/deploy スキップ"]
    F -->|"正常"| H2["Phase F: writeBackStore\n（_dirtySeries の series/*.json\n+ state/*.json 全量）\nPhase G: projectAll\nworks/ranking/tags/kana/new 生成\n.deploy-needed → Pages deploy"]
    G --> END([" 終了"])
    H2 --> END
```

---

## 3. データソース別取得情報（採用ソースのみ）

| データソース             | 利用ジョブ                             | URL                                                                                                                                        | 取得できるもの                                                                                                   | 注意点                                                                                                                                 | 実測値                |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **snapshot 検索 v2**     | 日次 Phase A                           | `snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search`                                                                       | contentId(so…) / title / viewCounter / tags / startTime / thumbnailUrl / channelId / description / lengthSeconds | seriesId フィールドなし。channelId フィルタ不可（取得後にコードで絞る）。`fields=`（アンダースコアなし）が正しい                       | ≈550ms/req・全体≈17分 |
| **チャンネル RSS**       | 毎時 Phase D                           | `ch.nicovideo.jp/ch2632720/video?rss=2.0`                                                                                                  | watchId（数値）/ title / pubDate / guid / link / description（HTML CDATA）/ thumbnailUrl（media:thumbnail）      | contentId(so…)・seriesId は含まれない                                                                                                  | ≈400ms                |
| **nvapi v2/series/{id}** | 毎時 D3/D3b / 日次 B3・B6・B7・A2・B7b | `nvapi.nicovideo.jp/v2/series/<seriesId>`                                                                                                  | `detail`（タイトル・支店所有）/ `items`（contentId・話順・各種カウンタ・時刻・尺・サムネ）                       | HTTP 200 でも GitHub hosted runner では有料各話の `items` が空配列になり得る。`detail` と `items` を別々に検証し、負数 ID では呼ばない | 環境依存              |
| **全 static JSON × 8**   | 日次 Phase B                           | `site.nicovideo.jp/danime/static/data/` + list.json / programlist.json / exclusiveAndFastest.json / archiveExclusive.json / theme1〜6.json | seriesId 一覧 / col_key（list.json のみ・五十音唯一の取得源）                                                    | Promise.allSettled で並列取得・失敗 JSON はスキップ。col_key は list.json 固有                                                         | ≈150〜300ms           |

### snapshot の重要制約

- **`fields=`（アンダースコアなし）** が正しいパラメータ名。`_fields=` を使うと `data: []` になる（実測確認）
- `_sort` 必須
- `_offset` 上限 100,000 → **年ウィンドウ分割**（2012〜現在）で回避
- `filters[channelId][0]=2632720` は URL エンコードで壊れるため**取得後にコードで絞る**

---

## 4. seriesId 解決の経路

**watchページは使わない。** seriesId は以下の優先順で解決する。

### 主経路: 全 static JSON union → nvapi（日次 Phase B）

1. `site.nicovideo.jp/danime/static/data/` 配下の 8 本の静的 JSON を並列取得
2. 各 JSON の `href: "/series/<id>"` または `series: <数値>` フィールドから seriesId を抽出
3. store に未登録の新 seriesId → `nvapi v2/series/<id>` を取得し、支店所有と payload 形状を検証
4. `items` が利用可能なら各話と話順を取り込み、`detail` からシリーズ情報を反映

候補 seriesId の網羅は static JSON union と確認済み title hint が担い、各話メンバーシップは nvapi または §4-2 の安全な補完規則で確定する。

### 補助経路: list-index タイトル照合（毎時 D2 / 日次 A2）

前回日次の B5 で保存した `list-index.json`（タイトル→seriesId の Map）を用いた前方一致照合。

- タイトル前方一致 + 語境界ガード（`/^[\s第#（(「『[【・\d]/`）で偽陽性を防ぐ
- **シーズン標識ガード**（`resolveByTitle`）: 一致した基底タイトルの「残り」が別シーズン標識（`第N期`・`第Nシーズン`・`シーズンN`・`Season N`・全角序数 `２ｎｄ` 等）で始まる候補は棄却する。これにより **seriesId 未取得の 第N期 各話が隣接シーズン（例: 第1期）に誤吸着せず**、`resolveByTitle==null` → 仮シリーズ（負 seriesId）へフォールバックする。話数標識（`第N話`・`第N章/巻/夜/回`・`#N`・`EP N`・`本編`・数字のみ 等＝「期」を含まない）は棄却しない。
- タグ正規化（アンダースコア→スペース）からも照合試みる
- これは**最終手段**であり、主経路（B3 nvapi）が充足している場合は実質不要

### 仮シリーズ（SANDA 型）: 照合全失敗時のフォールバック

照合が全失敗した ep に対して、タイトルから seriesTitle を抽出し `provisionalSeriesId(title)` で負数 seriesId を生成してシリーズを仮登録する（§4-1 参照）。

### Phase A2: 取得漏れ救出ループ（日次）

snapshot に登場したが seriesId が未解決の ep を救出する。

```
1. store の contentId→seriesId Map に既にある → 直接解決（nvapi 不要）
2. ep のタグ/タイトル照合 → seriesId 候補 → nvapi v2/series → 全話取得 → ep 付け替え
   2b. nvapi 失敗でも list.json 掲載作品なら seriesId を確定（applyListJsonRescue）:
       list-index.json のタイトル照合で seriesId が得られた場合、nvapi エラーでも
       list.json 掲載＝支店公式ラインナップ確認済みを権威として seriesId を確定する。
       nvapi 再試行なし・ep は確定 seriesId で付け替え。
3. 全失敗 → 仮シリーズ登録（thumbnailUrl → contentId 復元・provisionalSeriesId）
```

A2 は正の seriesId を持つ既存話を再利用するため、別シリーズ由来の所属を持ち込む可能性がある。直後の B7b が既知タイトル不一致を再抽出し、同一 run の export 前に再検証する。

---

### 4-1. 仮シリーズ（SANDA 型）の仕組み

| 項目                   | 内容                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **seriesId**           | `provisionalSeriesId(seriesTitle)` が返す**負整数**（決定的・再実行で同値）                                                                                                                                                                                                                                |
| **ハッシュ式**         | djb2 変形: `h = Math.imul(h,31) + ch.codePointAt(0) \| 0`（全文字）。`h <= 0 ? h-1 : -h` で必ず負数                                                                                                                                                                                                        |
| **contentId 復元**     | `thumbnailUrl` の `/thumbnails/<N>/` → `so<N>` （`contentIdFromThumbnail`）                                                                                                                                                                                                                                |
| **seriesTitle 抽出**   | `extractSeriesTitle`（「第N話」「#N」「Episode N」前の語を抽出）                                                                                                                                                                                                                                           |
| **フロント表示**       | `seriesId < 0` → 公式シリーズページボタンを disabled + ツールチップ「公式シリーズ情報を取得中です」                                                                                                                                                                                                        |
| **isAvailable**        | 仮登録時は `true`（E7 grace 対象外・仮のまま）                                                                                                                                                                                                                                                             |
| **解消タイミング**     | 毎時 D3b と日次 B6 で候補を再検証する。カタログまたは確認済み title hint に候補が無い間は仮シリーズを維持する                                                                                                                                                                                              |
| **B6 reconciliation**  | 仮 seriesId × タイトル照合で実 ID 候補を作る。`items` 非空なら仮話の contentId が含まれること、空配列なら支店所有・`detail.title` 一致・全仮話の厳格タイトル照合を要求する。確認後に各話を移動し、負 ID と `data/series/<neg>.json` を削除する。毎時は `NICO_HOURLY_RECONCILE_LIMIT`（既定20）で呼数を制限 |
| **ハッシュ衝突リスク** | 32-bit ハッシュで異なるタイトルが同じ負数になる確率 ≈ 2^-32。実用上許容                                                                                                                                                                                                                                    |

---

### 4-2. シリーズメンバーシップ整合化

各話の `seriesId` は次の2種類の証拠で確定する。どちらも `detail.owner.channel.id === "ch2632720"` と `items` が配列であることを前提とする。

1. **各話一覧による確定**: `items` が非空なら、対象 contentId が含まれるシリーズだけを所属先とする。`episodeNo` は `items` の配列順（1始まり）を採用する。
2. **制限付きタイトル補完**: `items` が空配列なら、`detail.title` とカタログ候補タイトルが正規化一致し、対象となる全話が厳格なタイトル照合を通る場合だけ所属を補完する。正シリーズから正シリーズへ移す場合は、現在のシリーズタイトルが各話に一致しないか、移動先タイトルの方が具体的であることも要求する。

タイトル正規化は前後空白・連続空白・全角空白、アポストロフィ表記、全角アンパサンドを吸収する。候補 seriesId は static JSON、`list.json`、確認済み title hint から作る。hint と `list.json` のタイトルまたは ID が衝突した場合は処理を停止し、黙って上書きしない。

| フェーズ     | 対象                                                 | 動作                                                                                                                                                                |
| ------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B3**       | 新規の正 seriesId                                    | nvapi が非空の各話一覧を返した場合、別シリーズにある同じ contentId を移動し、未登録話を作成する                                                                     |
| **B6 / D3b** | 仮シリーズ（負 ID）                                  | タイトルから実 ID 候補を作り、各話一覧または制限付きタイトル補完で確認できた場合に全話を移動して仮シリーズを削除する                                                |
| **B7**       | 既知タイトル不一致、空の正シリーズ、正 ID の巡回対象 | 既知タイトル不一致を毎 run 優先し、残りは `sweepCursor` から 1/7 ずつ巡回する。各話一覧が非空なら正確な所属と話順を反映し、空なら制限付きタイトル補完だけを許可する |
| **B7b**      | A2 完了後の既知タイトル不一致                        | B7 と同じ検証規則を適用し、A2 が追加・再利用した話を export 前に再整合化する。全巡回は繰り返さない                                                                  |

- **既知タイトル不一致**: `list.json` と hint の正規タイトルから導ける候補 seriesId と、現在の正 seriesId が異なる各話。候補シリーズが Store に存在し、安全なタイトル照合を通るものだけを対象にする。不一致が残る間は日次 full pipeline の実行ごとに再選出する。
- **移動**: `moveEpisodeToSeries` が `ep.seriesId` と `episodeNo` を更新し、移動元・移動先の両シリーズを dirty にする。正の移動元シリーズ自体は削除しない。
- **話数表記**: `第N話`、`#N` / `＃N`、`BREAK N`、`にゃーのN`、`EPISODE N`、`Chapter N`、全角数字を認識する。対象シリーズに一貫した既存オフセットがあればシリーズ内話数へ変換し、アンカーが無ければ候補群の最小表示話数をシリーズ内第1話とする。
- **nvapi 統計**: run ごとに `ok` / `failed` / `usable` / `empty` / `invalid` を集計する。`nvapiLastOkAt` は `usable > 0` の run だけ更新し、HTTP 200 の空配列を正常な各話取得として扱わない。
- **未確認時**: HTTP エラー、非支店、`items` 非配列、または安全条件を満たさない空配列では所属を変更しない。既知不一致は次の日次で再試行する。

#### 実装契約（レビュー基準）

1. タイトル候補だけで各話を移動してはならない。`items` による contentId 確認、または上記の制限付きタイトル補完が必要。
2. B7 の対象集合は「既知タイトル不一致（優先）∪ 空の正シリーズ ∪ 巡回対象」。`NICO_SWEEP_LIMIT`（既定1500）は全体の処理上限とする。
3. A2 の直後、lastSeen/ETL/writeback より前に B7b を実行する。
4. `items` が非空ならその membership と話順をタイトル推測より優先する。
5. 仮シリーズはフロントに表示し続け、実 ID を確認できた時点で削除・統合する。

---

## 5. 2 ジョブの詳細

### 全体トリガー

| ジョブ   | cron（UTC）   | JST 相当     | コマンド                    |
| -------- | ------------- | ------------ | --------------------------- |
| **毎時** | `0 * * * *`   | 毎時 00 分   | `--mode=hourly`             |
| **日次** | `30 22 * * *` | 翌 07:30 JST | `--mode=full`（デフォルト） |

**cron タイミング**:
snapshot 索引は毎日 **UTC 22:06 頃**に更新される（実測）。日次 cron は `30 22 * * *`（UTC 22:30）なので **24 分の余裕**がある。索引更新が遅延して 22:30 時点で前回値と同じ場合、version gate がスキップ → 翌日自動回収（保守的設計）。強制実行: `NICO_FORCE_SNAPSHOT=1`。

---

### ジョブ①: hourly-js（毎時）— `runHourlyJS()`

```
Phase D  : RSS fetch
              maxPages=5（各ページ 20件・最大 100件）
              guid HWM（filterNewRssItems）でページ単位の早期終了
              watchId Map で item 単位の重複除外
              新 RSS item ゼロ → meta.json + rss.json 書き戻し → 即終了
                                  （list-index 照合・nvapi・デプロイは一切走らない）
              新 RSS item あり → storeUpsertRss
                                  description = RSS <description> HTML CDATA as-is
                                  thumbnailUrl = <media:thumbnail url="..."> から抽出
                                  rss.json → 最大 200 件に trim（resolved 優先削除・pending 最後）

Phase D2 : pending 解決
              list-index.json（前回日次 B5 出力）をロード
              pending item ごとに:
                タイトル照合成功 → resolved 昇格（resolvedSeriesIds に正整数追加）
                タイトル照合失敗 → 仮シリーズ登録:
                  thumbnailUrl → contentIdFromThumbnail → contentId(so…)
                  extractSeriesTitle(title) → seriesTitle
                  provisionalSeriesId(seriesTitle) → 負数 seriesId
                  storeUpsertSeries + storeUpsertEps
                  storeUpdateRssResolution(watchId, contentId, 'resolved')
                  → resolvedSeriesIds に負数追加

Phase D3 : nvapi 更新（正整数 seriesId のみ）
              負数（仮 seriesId）は D3 をスキップ（nvapi に負数 ID は存在しない）
              実 seriesId あり → nvapi v2/series × seriesId 数
                              全話 × viewCounter/commentCounter/likeCounter/mylistCounter
                                   / registeredAt / duration / thumbnailUrl を取得
                              storeUpsertEps（実変化チェック → _dirtySeries 更新）
                              insertedEpisodes カウント（series-index 未登録の ep）

Phase D3b: 仮シリーズ昇格（B6・速報レーン）
              store 内の各仮シリーズ(負ID)を listIndexByTitle で候補実ID 探索
                （exact → 仮 ep タイトルで resolveByTitle）
              候補ありのみ nvapi 検証
                items 非空 → 仮 ep の contentId が含まれることを確認
                items 空   → 支店・detail.title・全仮話の厳格タイトル照合を確認
                → OK: moveEpisodeToSeries で全 ep 移動 + store.series.delete(負ID)
                       + data/series/<neg>.json 削除
              nvapi 呼数は NICO_HOURLY_RECONCILE_LIMIT（既定20）で上限
              候補ゼロの単発作品は nvapi を呼ばない（大半はこれ）

書き出し: _dirtySeries 非空 → series/{id}.json + series-index 更新（負数 seriesId ファイルも書き出す）
deploy  : insertedEpisodes > 0 || hasProvisional → .deploy-needed → Pages deploy
state   : meta.json + rss.json 書き戻し（常時）
export  : new.json 更新（常時）
```

**設計のポイント**:

- タイトル照合は毎時 `list.json` 直取り（D2）＋ `list-index.json`（前回日次 B5 出力）に依存。初回実行や日次未走行時は空 Map → 照合スキップ（仮シリーズ登録のみ）
- 仮シリーズは D3（nvapi 更新）をスキップするが、**同じ毎時 run の D3b（B6 昇格）**で候補があれば〜1時間で本物に統合される。候補が無い（カタログ未掲載）場合のみ日次 B6/B3 まで持ち越す
- watch ページ不使用のため bot 検知リスクなし
- **deploy は `insertedEpisodes > 0 || hasProvisional`**。新着 ep 追加 OR 仮シリーズが存在する場合にのみ Pages deploy。再生数更新はファイルに反映されるが Pages deploy は伴わない

---

### ジョブ②: full-js（日次）— `runFullJS()`

**役割**: snapshot で全話の viewCounter / tags / description を最新化し、static JSON と title hint からシリーズ候補を更新する。B6/B7/A2/B7b で所属を整合化した後、ETL 派生と配信 JSON の生成を行う。version gate が変化しない run は早期終了する。

```
version gate チェック（最初に実行・早期 exit 判定）:
              storedVersion === newVersion → **即終了**（何も書き出さない・deploy なし）
                                            B/B7/A2/B7b/E/detectShrink/deploy は一切走らない
              新版なら: 以下を実行

Phase A  : snapshot 全件取得
              storeUpsertEps: viewCounter / tags / description 等を更新
              missedContentIds 収集（channelId=2632720 かつ seriesId=null の ep）
              meta.snapshotFetchedAt = now / snapshotVersionLastModified 更新

Phase B  : 全 static JSON union（8 本並列取得）
              B2: 各 JSON から seriesId 抽出 → Set union
              B3: store 未保有の新 seriesId → nvapi 取得
                  支店所有・payload を検証し、利用可能な各話とシリーズ情報を反映
              B4: list.json 掲載シリーズ → col_key パッチ + isAvailable=true 強制
              B5: list-index.json 保存（タイトル→seriesId Map）
              B6: 仮シリーズ（seriesId < 0）→ 実シリーズ候補を検証して統合
                  items 非空は contentId、空は制限付きタイトル補完で確認
              B7: 既知不一致優先 + ローテーション整合化
                  targets = 既知タイトル不一致 ∪ 空の正シリーズ ∪ 正 ID 1/7 巡回
                  items 非空は所属と話順を反映、空は安全条件成立時だけ補完
                  meta.sweepCursor = (cursor + batch) % total

Phase A2 : 取得漏れ救出（Phase B 後・allTitles が充実した状態で実行）
              ① store の contentId→seriesId Map で直接解決
              ② タグ/タイトル照合（最終手段）→ seriesId → nvapi → ep 付け替え
              ③ 全失敗 → 仮シリーズ登録

Phase B7b: A2 後の既知タイトル不一致だけを再抽出
              B7 と同じ検証規則で export 前に整合化

lastSeenAt: snapshot 出現シリーズ（seriesId > 0）に lastSeenAt = now を記録

Phase E  : ETL 派生
              E1: series.descriptionFirst（最古話 description・long-wins: 複数源の description は長い方を保持）
              E2: series.tags（タグ正規化・dアニメ接頭/接尾除去・全話タグの欠落なし union）
                  作品名タグも検索対象として保持し、候補辞書の整理は Phase G で分離
                  各話タグ ⊆ series.tags を assert（違反時は writeback/deploy 前に停止）
              E3: cours（タグ主源 → 213クール・約3900作品を網羅）
              E4: franchiseKey（タイトル語幹 + シリーズタグ union-find）+ relatedSeries
              E5: timestamps 同期
              E6: thumbnails 同期
              E7: isAvailable grace
                  snapshotFetchedAt が 3 日以上前 → 評価しない（連続スキップ保護）
                  lastSeenAt < (snapshotFetchedAt - 2日) → isAvailable = false
                  再出現（lastSeenAt 更新済み） → isAvailable = true
                  ※ seriesId < 0（仮シリーズ）は grace スキップ（isAvailable 固定 true）
              E8: prevViewCounter delta（hot スコア）

回帰ガード: detectShrink: countSeriesWithEpisodes(store) < Math.floor(baseline × 0.9)
              → export スキップ。meta.json のみ保存して終了

Phase F  : writeBackStore（_dirtySeries の series/*.json + state/*.json 全量）← atomic
Phase G  : projectAll（works / ranking / tags / kana / new 等）← 非 atomic（async writeFile）
           tags.json は NFKC key で集約し、単独作品だけの作品名タグを候補から除外
           2作品以上で共有する作品名/前方一致タグはフランチャイズ探索用に候補へ残す
           → .deploy-needed → Pages deploy（毎回・shrink 除く）
```

**毎時 vs 日次の更新フィールド分担**:

| フィールド                   | 更新ジョブ                          | 源                                        |
| ---------------------------- | ----------------------------------- | ----------------------------------------- |
| viewCounter / commentCounter | 毎時 (D3)                           | nvapi v2/series                           |
| likeCounter / mylistCounter  | 毎時 (D3)                           | nvapi v2/series                           |
| registeredAt（投稿時間）     | 毎時 (D3)                           | nvapi v2/series                           |
| duration                     | 毎時 (D3)                           | nvapi v2/series                           |
| tags                         | 日次 (A + E2)                       | snapshot                                  |
| lengthSeconds                | 日次 (A)                            | snapshot                                  |
| description（canonical）     | 日次 (A + E1)                       | snapshot                                  |
| description（暫定）          | 毎時 (D)                            | RSS HTML CDATA as-is                      |
| seriesTitle / 話順           | 毎時 D3b / 日次 B3・B6・B7・A2・B7b | nvapi `detail/items` + 安全なタイトル補完 |
| cours / franchiseKey         | 日次 (E3/E4)                        | タグ派生                                  |
| col_key（五十音）            | 日次 (B4)                           | list.json                                 |
| isAvailable                  | 日次 (E7)                           | snapshot 由来（lastSeenAt grace）         |
| lastSeenAt                   | 日次 (A)                            | snapshot 出現確認                         |

---

## 6. ストレージ・JSON の実装詳細

| 項目                 | 詳細                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| **ファイル I/O**     | Node.js `fs`（同期）+ JSON.parse / JSON.stringify                                                 |
| **永続ストア**       | `data/state/meta.json` / `rss.json` / `prev-views.json` / `series-index.json` / `list-index.json` |
| **シリーズ別**       | `data/series/{id}.json`（正整数=本物・負整数=仮シリーズ）                                         |
| **atomic write**     | `.tmp` に書いて `renameSync` で置換（state/\*.json・series/\*.json）                              |
| **projection write** | async `writeFile`（非 atomic）。projectAll 毎回フル再生成                                         |
| **rss.json trim**    | 200件 cap。resolved 優先削除 → pending は最後まで保持                                             |
| **並列制御**         | nvapi 連続 req は `fetchWithToS` の ToS 待機で自動制御                                            |
| **律速**             | I/O は全体の 0.3% 以下。律速はネットワーク（snapshot ≈17分）                                      |
| **Store 汚染追跡**   | `store._dirtySeries: Set<number>`（実変化のあったシリーズのみ追跡）                               |
| **回帰ガード閾値**   | `baseline`（works.json の episodeCount > 0 件数）× 0.9 を下回ったら export スキップ               |

**Series フィールド（isAvailable 関連）**:

| フィールド   | 型               | 説明                                    |
| ------------ | ---------------- | --------------------------------------- |
| `lastSeenAt` | `string \| null` | snapshot に最後に登場した ISO 8601 日時 |

**meta フィールド**:

| フィールド          | 型               | 説明                                                                            |
| ------------------- | ---------------- | ------------------------------------------------------------------------------- |
| `snapshotFetchedAt` | `string \| null` | Phase A 完全実行が完了した ISO 8601 日時（version gate スキップ時は更新しない） |

---

## 7. 運用上の件数

シリーズ数・各話数・RSS 件数・snapshot version は上流データと実行時刻により変動するため、仕様値として固定しない。現在値は `pnpm ops:health -- --json` と state/配信 JSON の構造監査で確認する。

不変条件は次のとおり。

- `seriesId > 0` は実シリーズ、`seriesId < 0` は仮シリーズ、`0` は使用しない
- すべての episode は既存 series を参照し、orphan を作らない
- 仮シリーズも `works.json` と `data/series/<neg>.json` に出力し、公式シリーズリンクだけを無効化する
- 配信前に detectShrink を通し、基準値の90%未満へ急減した projection を公開しない

---

## 8. 判定ポイント詳細

---

### 8-1. RSS 新着判定

| 項目           | 内容                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------ |
| **条件**       | 毎時 hourly-js が起動するたびに判定                                                              |
| **何を取るか** | RSS を最大 5 ページ（100件）取得。guid HWM でページ単位早期終了・watchId Map で item 単位 dedup  |
| **何をするか** | 新 item ゼロ → 即終了（list-index 照合/nvapi/deploy なし）。あり → storeUpsertRss → 以降の処理へ |
| **注意**       | rss.json は 200件 cap で trim（resolved 優先削除・pending 最後）                                 |

---

### 8-2. version gate（snapshot `last_modified` 前回比）

| 項目                       | 内容                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| **条件**                   | 日次 full-js Phase A で毎回チェック                                                           |
| **何を取るか**             | `GET /api/v2/snapshot/version` の `last_modified` 文字列（ISO 8601）                          |
| **どう判定**               | `store.meta.snapshotVersionLastModified` と文字列一致比較。一致 → Phase A skip、不一致 → 実走 |
| **スキップ時（変化なし）** | **即終了**。B/B7/A2/B7b/E/deploy は走らない。`snapshotFetchedAt` は更新せず、何も書き出さない |
| **実走時**                 | 全年ウィンドウ（2012〜現在）× 100件ページング → `storeUpsertEps` → `snapshotFetchedAt` 更新   |
| **タイミング**             | 索引更新（UTC 22:06 頃）後に日次（UTC 22:30）が走るのが通常。遅延時は翌日自動回収             |
| **強制実行**               | `NICO_FORCE_SNAPSHOT=1` で version gate をバイパスして常に全件取得                            |

---

### 8-3. 変更あり判定（`_dirtySeries` / `insertedEpisodes`）

| 項目                        | 毎時                                                                   | 日次                                                            |
| --------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| **dirty 追跡の型**          | `_dirtySeries: Set<number>`                                            | 同左                                                            |
| **dirty トリガー**          | viewCounter / tags / 新 ep 挿入・仮シリーズ登録                        | 同左（＋ upsertSeries は常に dirty）                            |
| **series/\*.json 書き出し** | `_dirtySeries 非空` → 対象のみ（`writeSeriesFiles`）                   | `_dirtySeries 非空` → 対象のみ（`writeBackStore`）              |
| **state/\*.json 書き出し**  | meta.json + rss.json を個別書き出し                                    | prev-views / meta / rss / series-index 全量（`writeBackStore`） |
| **Pages deploy の条件**     | **`insertedEpisodes > 0 \|\| hasProvisional`** → `.deploy-needed` 生成 | full pipeline 完了時（detectShrink 除く）                       |
| **count 変化のみの場合**    | state のファイル更新のみ。次の full pipeline deploy で Pages に反映    | full pipeline 内で再生成・deploy                                |

---

### 8-4. detectShrink（ep>0件数 < baseline × 90%）

| 項目           | 内容                                                                       |
| -------------- | -------------------------------------------------------------------------- |
| **条件**       | 日次 full-js Phase E 完了直後・export 前に実行                             |
| **何を取るか** | Store の `countSeriesWithEpisodes(store)` と `data/works.json`（baseline） |
| **どう判定**   | `baseline > 0 && count < Math.floor(baseline * 0.9)` → shrink=true         |
| **動作**       | shrink=true → `meta.json` のみ atomic write → export/deploy スキップ       |
| **目的**       | 部分ロード等で Store が痩せた状態で上書きするのを防ぐ（保守的設計）        |

---

### 8-5. pending 判定と解決フロー

| 項目                             | 内容                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **pending とは**                 | RSS で取得したが seriesId への対応付けが未解決。`resolutionStatus === 'pending'`                                                                                               |
| **いつ発生するか**               | RSS の watchId に対応する ep が store に未登録（新シリーズ or snapshot 未反映）                                                                                                |
| **毎時の解決方法① タイトル照合** | list-index.json（前回日次 B5 出力）の タイトル→seriesId Map で前方一致照合 → 成功で `resolved` 昇格                                                                            |
| **毎時の解決方法② 仮シリーズ**   | 照合失敗 → thumbnailUrl → contentId 復元・タイトル抽出・provisionalSeriesId → 負数 seriesId で仮登録・`resolved`（仮 ID）昇格                                                  |
| **B6/D3b reconciliation**        | 実 ID 候補を nvapi で検証する。`items` 非空は contentId 所属、空配列は支店・detail.title・全仮話の厳格タイトル照合で確認し、成立時だけ本物 seriesId に統合して仮ファイルを削除 |
| **候補なし・未確認時**           | 仮シリーズのまま保持し、毎時または次の日次で再試行する。表示からは除外しない                                                                                                   |
| **タイトル照合の位置付け**       | list-index を seriesId 候補の主経路とし、タグ/各話タイトル照合は候補形成と制限付き補完にのみ使用する                                                                           |

---

### 8-6. 支店判定（channelId === 2632720）

| 場所                | 判定方法                                                                     | タイミング                   |
| ------------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| **snapshot 取得後** | `ep.channelId === 2632720`（数値比較）                                       | Phase A の storeUpsertEps 前 |
| **nvapi v2/series** | `detail.owner.channel.id === "ch2632720"` で確認（nvapi 自体はフィルタ不可） | D3/D3b/B3/B6/B7/A2/B7b       |
| **注意**            | snapshot は数値 `2632720`（数値）/ nvapi は文字列 `"ch2632720"` の場合あり   |

---

### 8-7. isAvailable grace（snapshot 不在 + 猶予期間）

| 項目                        | 内容                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| **評価タイミング**          | 日次 Phase E7（Phase A 完了後）                                                               |
| **必要フィールド**          | `series.lastSeenAt` / `meta.snapshotFetchedAt`                                                |
| **非評価条件①**             | `snapshotFetchedAt` が 3 日以上前 → 評価しない（version gate 連続スキップ保護）               |
| **非評価条件②**             | `seriesId < 0`（仮シリーズ）→ grace スキップ。isAvailable は仮登録時の `true` を維持          |
| **false 判定式**            | `lastSeenAt < (snapshotFetchedAt - 2日)` → `isAvailable = false`                              |
| **復活条件**                | snapshot に再登場 → `lastSeenAt` が更新 → 次の Phase E7 で `isAvailable = true`               |
| **version gate スキップ時** | `snapshotFetchedAt` は更新しない → 連続スキップが続くと非評価状態に入り false positive を防ぐ |
| **list.json との関係**      | list.json 掲載 → isAvailable=true 強制（B4）。これは snapshot 不在でも掲載中を意味するため    |

---

### 8-8. 読み取り専用シリーズ診断 Action

`fetch-daily.yml` の手動実行で `diagnostic_series_ids` または `diagnostic_content_ids` を指定すると、通常の fetch/deploy をスキップし、診断ジョブだけを実行する。

- series ID ごとに nvapi `detail` / `items` の形状と件数、シリーズ公開 HTML の応答を記録する
- content ID ごとに watch ページから series ID・シリーズタイトル・先頭話・所有チャンネルを抽出する
- nvapi 統計（`ok` / `failed` / `usable` / `empty` / `invalid`）を記録する
- state ブランチ、配信 JSON、Pages を変更しない

---

## 9. データライフサイクル 4 分類表

| 分類                            | ファイル                                                                                          | 挙動                                                                                                  | atomic?             |
| ------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------- |
| **1. 永続・増分更新**           | `state/meta.json` / `state/series-index.json` / `state/list-index.json` / `data/series/{id}.json` | 更新ごとに書き出し。削除しない（仮 series/{neg}.json は B6 で明示削除）。Store が全データの正規コピー | ✓ (.tmp→rename)     |
| **2. 派生・毎回全件生成**       | `works.json` / `ranking.json` / `tags.json` / `kana.json` / `new.json` 等                         | `projectAll` 毎回フル再生成。Store から完全導出可能。破損しても再実行で復元                           | ✗ (async writeFile) |
| **3. 保持上限あり（循環削除）** | `state/rss.json`                                                                                  | 200件 cap。resolved 優先削除。pending は最後まで保持                                                  | ✓ (.tmp→rename)     |
| **4. 1 日サイクル上書き**       | `state/prev-views.json`                                                                           | 日次開始前に `{contentId: viewCounter}` を保存。Phase E8 が delta 計算後、翌日上書き                  | ✓ (.tmp→rename)     |

**特殊挙動**:

- `data/series/{id}.json`: 正整数=本物・負整数=仮シリーズ。hourly は `_dirtySeries` 対象のみ書き出し（全量ではない）
- `state/*.json`: hourly は meta + rss のみ個別書き出し。daily は全量 writeBackStore
- `new.json`: hourly も daily も毎回上書き（rss.json 先頭スライス）
- isAvailable=false のシリーズもすべて保持（ソフトトゥームストーン）
- **仮 series/{neg}.json**: B6 reconciliation で統合後に `unlinkSync` で明示削除（次回 loadStore での再インジェスト防止）

---

## 10. フロント表示契約

### isAvailable=false のシリーズの扱い

| 項目                | 契約                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| **データ**          | Store・`data/series/{id}.json`・`works.json` すべてに保持（削除しない）    |
| **works.json 出力** | `isAvailable: false` のシリーズも含める（`thumbnailUrl` フィールドも出力） |
| **デフォルト表示**  | 一覧から非表示（フロントがフィルタ）                                       |
| **設定トグル**      | ユーザーが「配信終了作品を表示」をオンにすると表示                         |

### 仮シリーズ（seriesId < 0）の表示

| 項目               | 契約                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| **判定**           | `series.seriesId < 0`                                                                             |
| **カード**         | 公式シリーズページの外部リンクボタンを `disabled` + `data-tooltip="公式シリーズ情報を取得中です"` |
| **詳細画面**       | 公式シリーズページボタンを `disabled` + ツールチップ                                              |
| **ソート順**       | 実シリーズと**同一キーで混合ソート**（末尾分離なし）。固有の挙動は公式リンク無効のみ              |
| **解消タイミング** | 毎時 D3b または日次 B6 で実 seriesId を確認できた時点で統合し、通常表示に戻る                     |

### カード表示仕様

| 状態                  | サムネあり                                                  | サムネなし                      |
| --------------------- | ----------------------------------------------------------- | ------------------------------- |
| **isAvailable=false** | サムネ画像 ＋ 半透明グレーオーバーレイ ＋「取得不可」ラベル | グレー背景 ＋「取得不可」ラベル |
| **isAvailable=true**  | 通常表示                                                    | グレー背景（ラベルなし）        |

**ラベル**: `"取得不可"` 1種類のみ（「配信終了」との区別はしない。snapshot 不在理由はコードから判断不能）

### kana.json（五十音ナビ）の変更

- `isAvailable=true` 条件を除外。`colKey` が null でないシリーズのみ出力（isAvailable 問わず）

---

## 11. 難所・注意点

### 11-1. version gate と cron のタイミング依存

**状況**: 日次 cron（UTC 22:30）と snapshot 索引更新（UTC 22:06 頃）の間に 24 分の余裕がある。索引更新が遅延すると version gate がスキップ → **その日の Phase A が実質空振り**。連続しても翌日以降で自動回収（保守的設計）。

**検知**: `snapshotVersionLastModified` が複数日同じ値のまま → ログで確認。

**強制手段**: `NICO_FORCE_SNAPSHOT=1` で手動トリガー可能。

**isAvailable への影響**: version gate スキップ（即終了）が 3 日以上続くと `snapshotFetchedAt` が古くなり Phase E7 の評価が停止（false positive 防止）。長期スキップ時は `NICO_FORCE_SNAPSHOT=1` での強制実行を推奨。

---

### 11-2. nvapi の環境依存応答と HTTP バックオフ

**状況**: nvapi は HTTP エラーや timeout に加え、HTTP 200・正しい `detail` を返しながら有料各話の `items` だけが空配列になることがある。`fetchWithToS` は 429/503 の `Retry-After` を尊重し、対象エラーをバックオフ付きで再試行する。

**影響**: `items` が空の run では、各話の排他的 membership と配列順を直接確認できない。

**設計**: `ok` と `usable` を分離して記録し、`usable > 0` の場合だけ `nvapiLastOkAt` を更新する。空配列時の所属変更は §4-2 の制限付きタイトル補完に限定し、安全条件を満たさない対象は次の日次へ持ち越す。

---

### 11-3. list.json の col_key は唯一の代替なし

**状況**: 五十音ナビ（kana.json）の読み情報は list.json の `col_key` フィールドが唯一の源。snapshot / nvapi / RSS のいずれも読み情報を提供しない。

**影響**: list.json が取得できないと col_key が更新されず、kana.json の五十音分類が陳腐化する。

**設計**: list.json は col_key パッチと seriesId union に役割を絞る（isAvailable の主判定には使わない）。

---

### 11-4. 仮シリーズのハッシュ衝突

**状況**: `provisionalSeriesId` は 32-bit ハッシュで負数を生成するため、異なるタイトルが同じ負数になる確率が ≈ 2^-32 存在する。

**影響**: 衝突時も B6/D3b は支店所有に加え、`items` の contentId 所属または全仮話の制限付きタイトル補完を要求する。残余リスクは確率 ≈ 2^-32 のため実用上許容する。

**本物との区別**: 本物 seriesId は必ず正整数。仮は必ず負整数。重複しない。

---

### 11-5. B4 isAvailable=true 強制の副作用

**状況**: Phase B4 では list.json 掲載シリーズに `isAvailable=true` を強制する。list.json は掲載中作品のみを含むという前提に基づく。

**リスク**: list.json から削除済みの作品が B4 で誤って `true` に戻される可能性。ただし list.json は現在掲載中のリストなので通常このケースは発生しない。

**緩和**: Phase E7 の isAvailable grace が翌日以降に snapshot 不在を検出して `false` に戻す。
