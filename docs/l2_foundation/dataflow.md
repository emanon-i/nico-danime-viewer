# データフロー仕様（L2）

> 2026-06-21 確定版。watch.mjs 廃止・全 static JSON union + nvapi authoritative + 仮シリーズ(SANDA型)を反映。

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
- **seriesId 解決**: watch ページ不使用。全 static JSON union → nvapi authoritative が主経路。失敗時は仮シリーズ（負数 seriesId）を登録し、**毎時 B6**（〜1時間）＋日次 B6/B3 で本物に統合。既存の正→正 誤登録は**日次 B7 ローテーション権威スイープ**（全正シリーズ 1/7 巡回・約7日一巡）が是正

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

**早期 exit ルール**: **version gate 変化なし → 即終了**（B/A2/E/deploy は一切走らない）

日次の処理順: Phase A（snapshot） → Phase B（全 static JSON union） → Phase A2（取得漏れ救出） → Phase E（ETL） → detectShrink → deploy

```mermaid
flowchart TD
    A(["📅 full-js 起動\nJST 07:30"]) --> B["snapshot/version 取得"]
    B --> C{"version gate\nlast_modified 変化?"}
    C -->|"**変化なし → 即終了**\nB/A2/E/deploy は走らない"| ENDEARLY([" 終了（早期）"])
    C -->|"変化あり"| D["Phase A: snapshot 全件取得\n年ウィンドウ分割 ≈17分\nupsertEps（viewCounter/tags/desc/…）\n→ missedContentIds 収集（seriesId=null の ep）\n→ meta.snapshotFetchedAt = now"]
    D --> P["Phase B: 全 static JSON union（8 本）\nlist.json / programlist.json /\nexclusiveAndFastest.json / archiveExclusive.json /\ntheme1〜6.json"]
    P --> B2["B2: 各 JSON から href=/series/<id> または series:<数値> 抽出\n全 seriesId を Set に union"]
    B2 --> B3["B3: store 未保有の新 seriesId → nvapi v2/series authoritative\n全話取得・シリーズタイトル取得\n→ storeUpsertEps + storeUpsertSeries"]
    B3 --> B4["B4: list.json 掲載シリーズに\ncol_key パッチ + isAvailable=true 強制"]
    B4 --> B5["B5: list-index.json 保存\n（タイトル→seriesId Map・毎時 D2 が参照）"]
    B5 --> B6["B6: 仮シリーズ(seriesId<0) × allTitles 完全一致 reconciliation\n→ nvapi 検証（支店判定 + 仮 ep の contentId が nvapi 話一覧に存在）\n→ 検証 OK: ep の seriesId を実 ID に付け替え\n→ store.series.delete(仮 id)\n→ data/series/<neg>.json 削除（再インジェスト防止）"]
    B6 --> B7R["B7: ローテーション権威スイープ\nselectSweepTargets（空シリーズ全件 + 正ID 1/7 巡回）\n各対象 nvapi → planAuthoritativeMoves で\n別正シリーズから各話奪還 + 未取得話は新規作成\nmeta.sweepCursor を進める（約7日で全件一巡）"]
    B7R --> A2["Phase A2: 取得漏れ救出\n① store の contentId→seriesId Map で直接解決\n② タグ/タイトル照合（最終手段）→ nvapi → ep 付け替え\n③ 全失敗 → 仮シリーズ登録（thumbnailUrl→contentId・負数 seriesId）"]
    A2 --> LS["lastSeenAt = now\n（snapshot 出現シリーズのうち seriesId > 0）"]
    LS --> E["Phase E: ETL 派生\nE1: descriptionFirst（最古話 description）\nE2: tags 正規化（dアニメ接頭/接尾除去）\nE3: cours（タグ主源）\nE4: franchiseKey + relatedSeries\nE5: timestamps 同期\nE6: thumbnails 同期\nE7: isAvailable grace\n    snapshotFetchedAt > 3日前 → 評価スキップ\n    lastSeenAt < (snapshotFetchedAt - 2日) → false\n    ※ seriesId < 0（仮）は grace スキップ（isAvailable 固定 true）"]
    E --> F{"detectShrink\nep>0件数 < baseline×90%?"}
    F -->|"縮小検出"| G["meta.json のみ保存\nexport/deploy スキップ"]
    F -->|"正常"| H2["Phase F: writeBackStore\n（_dirtySeries の series/*.json\n+ state/*.json 全量）\nPhase G: projectAll\nworks/ranking/tags/kana/new 生成\n.deploy-needed → Pages deploy"]
    G --> END([" 終了"])
    H2 --> END
```

---

## 3. データソース別取得情報（採用ソースのみ）

| データソース             | 利用ジョブ            | URL                                                                                                                                        | 取得できるもの                                                                                                   | 注意点                                                                                                                               | 実測値                |
| ------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| **snapshot 検索 v2**     | 日次 Phase A          | `snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search`                                                                       | contentId(so…) / title / viewCounter / tags / startTime / thumbnailUrl / channelId / description / lengthSeconds | seriesId フィールドなし。channelId フィルタ不可（取得後にコードで絞る）。`fields=`（アンダースコアなし）が正しい                     | ≈550ms/req・全体≈17分 |
| **チャンネル RSS**       | 毎時 Phase D          | `ch.nicovideo.jp/ch2632720/video?rss=2.0`                                                                                                  | watchId（数値）/ title / pubDate / guid / link / description（HTML CDATA）/ thumbnailUrl（media:thumbnail）      | contentId(so…)・seriesId は含まれない                                                                                                | ≈400ms                |
| **nvapi v2/series/{id}** | 毎時 D3 / 日次 B3・A2 | `nvapi.nicovideo.jp/v2/series/<seriesId>`                                                                                                  | 全話一覧（contentId/so…・話順）/ count.{view,comment,mylist,like} / registeredAt / duration / thumbnailUrl       | **tags・description フィールドなし**（snapshot が唯一）。正整数 seriesId が事前に判明している必要あり。負数（仮 ID）では呼び出さない | ≈550ms                |
| **全 static JSON × 8**   | 日次 Phase B          | `site.nicovideo.jp/danime/static/data/` + list.json / programlist.json / exclusiveAndFastest.json / archiveExclusive.json / theme1〜6.json | seriesId 一覧 / col_key（list.json のみ・五十音唯一の取得源）                                                    | Promise.allSettled で並列取得・失敗 JSON はスキップ。col_key は list.json 固有                                                       | ≈150〜300ms           |

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
3. store に未登録の新 seriesId → `nvapi v2/series/<id>` で authoritative 取得（全話・タイトル）
4. 取得結果を storeUpsertEps・storeUpsertSeries に反映

これで **dアニメストアニコニコ支店の全掲載シリーズ**を毎日全量カバーする。

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

---

### 4-1. 仮シリーズ（SANDA 型）の仕組み

| 項目                   | 内容                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **seriesId**           | `provisionalSeriesId(seriesTitle)` が返す**負整数**（決定的・再実行で同値）                                                                                                                                                                                                                                           |
| **ハッシュ式**         | djb2 変形: `h = Math.imul(h,31) + ch.codePointAt(0) \| 0`（全文字）。`h <= 0 ? h-1 : -h` で必ず負数                                                                                                                                                                                                                   |
| **contentId 復元**     | `thumbnailUrl` の `/thumbnails/<N>/` → `so<N>` （`contentIdFromThumbnail`）                                                                                                                                                                                                                                           |
| **seriesTitle 抽出**   | `extractSeriesTitle`（「第N話」「#N」「Episode N」前の語を抽出）                                                                                                                                                                                                                                                      |
| **フロント表示**       | `seriesId < 0` → 公式シリーズページボタンを disabled + ツールチップ「公式シリーズ情報を取得中です」                                                                                                                                                                                                                   |
| **isAvailable**        | 仮登録時は `true`（E7 grace 対象外・仮のまま）                                                                                                                                                                                                                                                                        |
| **解消タイミング**     | **毎時 B6**（`listIndexByTitle` 照合で候補ありなら〜1時間で昇格）を第一線に、日次 B6（store allTitles 照合）＋ B3（新規 nvapi 登録）で確実化。カタログ未掲載の真の新作のみ nico 側ラグ分待つ                                                                                                                          |
| **B6 reconciliation**  | 仮 seriesId × タイトル照合 → nvapi 検証（支店判定 + 仮 ep の contentId が nvapi 話一覧に存在）→ 検証 OK: ep の seriesId を実 ID に付け替え → `store.series.delete(負数ID)` → `data/series/<neg>.json` 削除（再インジェスト防止）。毎時は `NICO_HOURLY_RECONCILE_LIMIT`（既定20）で nvapi 呼数を上限・候補ありのみ検証 |
| **ハッシュ衝突リスク** | 32-bit ハッシュで異なるタイトルが同じ負数になる確率 ≈ 2^-32。実用上許容                                                                                                                                                                                                                                               |

---

### 4-2. 正シリーズ間のメンバーシップ是正（誤登録の自己修復）

**背景**: snapshot は seriesId を持たないため、各話の所属は補助経路の推測（タグ/タイトル前方一致）で仮割当する。§4 のシーズン標識ガードで**新規の隣接シーズン誤吸着は予防**するが、次の2つは推測では直せない: ①既に**正→正で誤登録済み**のデータ（`upsertEpisodes` の PRESERVE で non-null seriesId が保護される）②推測が別の正シリーズに吸着させた場合。これを **nvapi の排他的メンバーシップ（1 contentId = 1 シリーズ）を唯一の権威**として是正する。

**設計原則（2レーン）**: 「速さが要るもの」と「遅くてよいもの」を分ける。

- **速報＋新規レーン（許容遅延 〜1時間〜最大翌日）**: 新着・仮シリーズ・新規シリーズ。毎時＋日次で即解決する。**新規が偽シリーズのまま7日放置されることは構造的に起こさない**。
- **総ざらいレーン（許容遅延 最大7日）**: 既存の全正シリーズを **1/7 ずつ日次ローテーション**で nvapi 権威照合。古い作品の潜在誤登録を拾う安全網。ユーザーは既に正しく見えている作品を見ているので7日でも体験に影響しない。

| フェーズ                          | 契機・頻度                                          | 動作                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B3 高速パス**                   | 新規シリーズを nvapi 取得した瞬間（日次）           | その各話一覧に、現在**別の正シリーズ**に属する contentId があれば `moveEpisodeToSeries` で引き取る（`planAuthoritativeMoves`）。取得済み nvapi を再利用し**追加アクセス0**。                                                                                                                                                                                                                                  |
| **B6 仮→実 統合**                 | 仮シリーズ(負ID)が存在（**毎時＋日次**）            | 仮シリーズのタイトルを実シリーズ候補と照合（毎時は `listIndexByTitle` = list.json 全カタログ、日次は store 内 allTitles）→ 候補ありのみ nvapi 検証（支店＋仮 ep が nvapi 話一覧に存在）→ 移動＋仮削除。毎時は `NICO_HOURLY_RECONCILE_LIMIT`（既定20）で nvapi 呼数を上限。**新規の偽シリーズを最短〜1時間で本物に昇格**。                                                                                     |
| **B7 ローテーション権威スイープ** | 日次・全正シリーズを 1/7 巡回（＋空シリーズは毎回） | `selectSweepTargets(store,{batch,cursor})` が「各話0件の正シリーズ**全件**（優先・`findEmptyRealSeries`）」∪「sorted 正ID の cursor から batch 件（wrap）」を返す。各対象を nvapi 再取得 → `planAuthoritativeMoves`＋`moveEpisodeToSeries` で別正シリーズから各話を奪還し、未取得話は新規作成。`meta.sweepCursor` を進める。空/partial/既知非空すべての誤登録を「所属リストとの不一致」として自明に是正する。 |

- **移動の実体** `moveEpisodeToSeries(store, contentId, target, episodeNo)`: `ep.seriesId` を直接付け替え（PRESERVE を迂回）、`episodeNo` を nvapi 話順で是正、**旧・新の両シリーズを dirty 化**（旧ファイルから消え・新ファイルに載る）。旧シリーズは削除しない（正当な他の各話を保持しうる。負の仮シリーズ削除は §4-1 B6 が担当）。
- **なぜローテーションか（旧 B7 空シリーズ限定の限界）**: 旧実装は「各話0件の正シリーズ」だけを対象にしていた。だが誤登録は **partial**（例: `幼女戦記Ⅱ` が自前の話を1つ持ちつつ別の話を第1期に奪われる）でも起こり、被害シリーズが**空でない**と旧 B7 は永久に対象外だった。B3(新規)・B6(仮) も“入口”限定で、**一度正シリーズに座った各話を再点検する経路が存在しなかった**。ローテーションは「賢く対象を絞る」のをやめ、**全正シリーズを順に権威照合**することで、この構造的な穴（空・partial・既知非空を問わず）を塞ぐ。
- **収束の保証**: `batch = ceil(総正シリーズ数 / 7)`（既定・`NICO_SWEEP_BATCH` で上書き可）。ハード上限 `NICO_SWEEP_LIMIT`（既定1500・ToS 保護）。cursor は sorted 正ID を巡回し、**約7日で全シリーズを一巡**＝どの誤登録も最悪7日で必ず是正。空シリーズは cursor 位置に関係なく毎回含めるので**ユーザー可視の unavailable は翌日中に回復**。
- **projection 収束**: `series-index.json` は日次で全再構築／毎時は値上書きで自己修正。`works.json` 等 projection は `ep.seriesId` から再集計。`ep.seriesId` は run 間で**正→正に変わり得る**（従来は null/負→正のみ）。
- **nvapi の間欠失敗への対処**: GitHub Actions ランナーからの nvapi 呼び出しは間欠的〜慢性的に失敗しうる（403/429/5xx/timeout）。`fetchWithToS` が指数バックオフ＋jitter でリトライ（429/503 は `Retry-After` 尊重）。`scripts/nico/nvapi.mjs` が run 単位の成功/失敗を集計（`[JS] nvapi stats`）し、成功時は `state/meta.json` の `nvapiLastOkAt` を更新。`pnpm ops:health` は `nvapiLastOkAt` の鮮度＋**各話0件の正シリーズ数**の残存からスイープの劣化を検知する。

#### 実装契約（レビュー基準・正本）

このセクションの各項目は実装の受け入れ条件。実装は下記シグネチャ・既定値・不変条件に**一字一句**沿うこと。

1. **`selectSweepTargets(store, { batch, cursor })` → `{ targets: number[], nextCursor: number }`**（`scripts/store/store.mjs`）
   - `sorted` = 正の seriesId を昇順ソートした配列。`total = sorted.length`。
   - `empty` = `findEmptyRealSeries(store)`（優先・全件）。
   - `slice` = `sorted` の index `cursor` から `batch` 件（末尾で先頭へ wrap）。
   - `targets` = `empty ∪ slice` を**重複排除**（Set）。`nextCursor` = `total === 0 ? 0 : (cursor + batch) % total`。
   - `total === 0` のとき `targets = empty`（通常は空）・`nextCursor = 0`。負値/仮シリーズは対象外。
2. **`meta.sweepCursor: number`**（`state/meta.json`）: `createStore` で既定 `0`、`loadStore`/`_loadState` で復元、`writeBackStore` が `store.meta` を丸ごと書くため自動永続。`MetaRecord` typedef に追記。
3. **日次 B7 ローテーション**（`runFullJS`・旧 B7 空シリーズブロックを置換）: `cursor = store.meta.sweepCursor ?? 0`／`batch = Number(process.env.NICO_SWEEP_BATCH ?? Math.ceil(total/7))`（`total<7` でも最低1）／処理件数は `NICO_SWEEP_LIMIT`（既定1500）で上限。各 target: `fetchSeriesData` → `isBranchSeries` false はスキップ → `planAuthoritativeMoves`＋`moveEpisodeToSeries` → `storeUpsertEps`。完了後 `storeUpdateMeta(store,{ sweepCursor: nextCursor })`。ログ `[JS] B7 rotation sweep done { total, batch, processed, empty, moved, created, cursor, nextCursor }`。
4. **毎時 B6 昇格**（`runHourlyJS`・D3 後 writeback 前）: store 内の各仮シリーズ(負ID)について、`listIndexByTitle.get(仮title)` → 無ければ仮 ep タイトルで `resolveByTitle(epTitle, listIndexByTitle)` で候補実ID を探す。**候補ありのときだけ** `fetchSeriesData` で検証（`isBranchSeries` ＋ 仮 ep contentId が nvapi 話一覧に存在）→ OK なら `moveEpisodeToSeries` で全 ep 移動＋`store.series.delete(負ID)`＋`data/series/<neg>.json` 削除。nvapi 呼数は `NICO_HOURLY_RECONCILE_LIMIT`（既定20）で上限。候補ゼロの単発作品は nvapi を呼ばない。
5. **不変（変更禁止）**: §4 の予防ガード（`SEASON_MARKER_RE`）・B3・日次 B6・A2・E7・`findEmptyRealSeries`（PR #8 の isAvailable 非絞り込み）はそのまま。ローテーションは B7 ブロックの**置換のみ**。
6. **UX latency 保証**: 新着話=毎時／新規シリーズ（カタログ掲載済）=毎時 B6 で〜1時間／既存・非空の潜在誤登録=最大7日（1巡）。

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
              候補ありのみ nvapi 検証（支店 + 仮 ep が nvapi 話一覧に存在）
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

**役割**: snapshot で全話の viewCounter / tags / description を最新化 ＋ 全 static JSON union で新シリーズ取込 ＋ 仮シリーズ reconciliation ＋ ETL 派生（isAvailable grace 含む）。毎日無条件 deploy する。

```
version gate チェック（最初に実行・早期 exit 判定）:
              storedVersion === newVersion → **即終了**（何も書き出さない・deploy なし）
                                            B/A2/E/detectShrink/deploy は一切走らない
              新版なら: 以下を実行

Phase A  : snapshot 全件取得
              storeUpsertEps: viewCounter / tags / description 等を更新
              missedContentIds 収集（channelId=2632720 かつ seriesId=null の ep）
              meta.snapshotFetchedAt = now / snapshotVersionLastModified 更新

Phase B  : 全 static JSON union（8 本並列取得）
              B2: 各 JSON から seriesId 抽出 → Set union
              B3: store 未保有の新 seriesId → nvapi authoritative 取得
                  storeUpsertEps（全話）+ シリーズタイトル設定
              B4: list.json 掲載シリーズ → col_key パッチ + isAvailable=true 強制
              B5: list-index.json 保存（タイトル→seriesId Map）
              B6: 仮シリーズ（seriesId < 0）× allTitles 完全一致 reconciliation
                  → nvapi 検証（支店判定 + 仮 ep の contentId が nvapi 話一覧に存在）
                  → 検証 OK: ep の seriesId を実 ID に付け替え
                  → store.series.delete(仮 id)
                  → data/series/<neg>.json を existsSync + unlinkSync で削除
              B7: ローテーション権威スイープ（全正シリーズを 1/7 巡回）
                  selectSweepTargets(store,{batch,cursor}):
                    targets = 空の正シリーズ全件（findEmptyRealSeries・優先）
                              ∪ sorted 正 seriesId の cursor から batch 件（wrap）
                    batch = NICO_SWEEP_BATCH ?? ceil(total/7)・上限 NICO_SWEEP_LIMIT(1500)
                  各 target: nvapi → isBranchSeries → planAuthoritativeMoves
                             + moveEpisodeToSeries（別正シリーズから奪還）+ storeUpsertEps
                  meta.sweepCursor = (cursor + batch) % total（約7日で全件一巡）

Phase A2 : 取得漏れ救出（Phase B 後・allTitles が充実した状態で実行）
              ① store の contentId→seriesId Map で直接解決
              ② タグ/タイトル照合（最終手段）→ seriesId → nvapi → ep 付け替え
              ③ 全失敗 → 仮シリーズ登録

lastSeenAt: snapshot 出現シリーズ（seriesId > 0）に lastSeenAt = now を記録

Phase E  : ETL 派生
              E1: series.descriptionFirst（最古話 description・long-wins: 複数源の description は長い方を保持）
              E2: series.tags（タグ正規化・dアニメ接頭/接尾除去・作品名タグ除外）
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
           → .deploy-needed → Pages deploy（毎回・shrink 除く）
```

**毎時 vs 日次の更新フィールド分担**:

| フィールド                   | 更新ジョブ    | 源                                |
| ---------------------------- | ------------- | --------------------------------- |
| viewCounter / commentCounter | 毎時 (D3)     | nvapi v2/series                   |
| likeCounter / mylistCounter  | 毎時 (D3)     | nvapi v2/series                   |
| registeredAt（投稿時間）     | 毎時 (D3)     | nvapi v2/series                   |
| duration                     | 毎時 (D3)     | nvapi v2/series                   |
| tags                         | 日次 (A + E2) | snapshot                          |
| lengthSeconds                | 日次 (A)      | snapshot                          |
| description（canonical）     | 日次 (A + E1) | snapshot                          |
| description（暫定）          | 毎時 (D)      | RSS HTML CDATA as-is              |
| seriesTitle / 話順           | 日次 B3 / A2  | nvapi v2/series                   |
| cours / franchiseKey         | 日次 (E3/E4)  | タグ派生                          |
| col_key（五十音）            | 日次 (B4)     | list.json                         |
| isAvailable                  | 日次 (E7)     | snapshot 由来（lastSeenAt grace） |
| lastSeenAt                   | 日次 (A)      | snapshot 出現確認                 |

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

## 7. 現在の数値（2026-06-21 時点）

| 項目                        | 値                                                 |
| --------------------------- | -------------------------------------------------- |
| data/series/{id}.json 件数  | 6352 + 仮シリーズ（変動）                          |
| works.json: 総シリーズ数    | ≈6352                                              |
| works.json: episodes > 0    | ≈6299                                              |
| state/rss.json: RSS 件数    | ≈40                                                |
| state/rss.json: pending     | 変動（B6 reconciliation で解消・再発生を繰り返す） |
| state/rss.json: resolved    | 大部分                                             |
| snapshotVersionLastModified | 2026-06-16T07:08:11+09:00                          |

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
| **スキップ時（変化なし）** | **即終了**。B/A2/E/deploy は走らない。`snapshotFetchedAt` は更新しない。何も書き出さない      |
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
| **Pages deploy の条件**     | **`insertedEpisodes > 0 \|\| hasProvisional`** → `.deploy-needed` 生成 | **毎回**（detectShrink 除く）                                   |
| **count 変化のみの場合**    | ファイル更新のみ（deploy なし）→ 翌日の日次 deploy で反映              | 毎日デプロイで常に最新                                          |

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

| 項目                             | 内容                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pending とは**                 | RSS で取得したが seriesId への対応付けが未解決。`resolutionStatus === 'pending'`                                                                                      |
| **いつ発生するか**               | RSS の watchId に対応する ep が store に未登録（新シリーズ or snapshot 未反映）                                                                                       |
| **毎時の解決方法① タイトル照合** | list-index.json（前回日次 B5 出力）の タイトル→seriesId Map で前方一致照合 → 成功で `resolved` 昇格                                                                   |
| **毎時の解決方法② 仮シリーズ**   | 照合失敗 → thumbnailUrl → contentId 復元・タイトル抽出・provisionalSeriesId → 負数 seriesId で仮登録・`resolved`（仮 ID）昇格                                         |
| **翌日の B6 reconciliation**     | 仮シリーズタイトル × allTitles 完全一致 → nvapi 検証（支店判定 + 仮 ep の contentId が nvapi 話一覧に存在）→ 検証 OK: 本物 seriesId に統合・仮 series/{neg}.json 削除 |
| **B6 非一致時**                  | 仮シリーズのまま保持。B3 で本物が取り込まれた翌日に自動解消                                                                                                           |
| **タイトル照合（廃止扱い）**     | watch ページ依存の旧タイトル照合は廃止。list-index を「主経路」、タグ/タイトル照合は「最終手段」                                                                      |

---

### 8-6. 支店判定（channelId === 2632720）

| 場所                | 判定方法                                                                   | タイミング                   |
| ------------------- | -------------------------------------------------------------------------- | ---------------------------- |
| **snapshot 取得後** | `ep.channelId === 2632720`（数値比較）                                     | Phase A の storeUpsertEps 前 |
| **nvapi v2/series** | `ep.channelId` で確認（nvapi 自体はフィルタ不可）                          | B3/A2/D3 のコールバック内    |
| **注意**            | snapshot は数値 `2632720`（数値）/ nvapi は文字列 `"ch2632720"` の場合あり |

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
| **解消タイミング** | 翌日の B6 reconciliation 後に正整数 seriesId に統合 → 通常表示に戻る                              |

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

### 11-2. nvapi / snapshot の 503 バックオフで日次が伸びる

**状況**: `fetchWithToS` は 503 を受けると `backoff503Ms`（5分）待機してから1回リトライする。

**影響**: snapshot 全件取得（≈17分）の途中で 503 → 最大 +5分延長。

**設計**: 503 後のリトライが失敗したら例外を throw → Actions が fail → 前回の正常な公開物を保持。

---

### 11-3. list.json の col_key は唯一の代替なし

**状況**: 五十音ナビ（kana.json）の読み情報は list.json の `col_key` フィールドが唯一の源。snapshot / nvapi / RSS のいずれも読み情報を提供しない。

**影響**: list.json が取得できないと col_key が更新されず、kana.json の五十音分類が陳腐化する。

**設計**: list.json は col_key パッチと seriesId union に役割を絞る（isAvailable の主判定には使わない）。

---

### 11-4. 仮シリーズのハッシュ衝突

**状況**: `provisionalSeriesId` は 32-bit ハッシュで負数を生成するため、異なるタイトルが同じ負数になる確率が ≈ 2^-32 存在する。

**影響**: 衝突時は B6 reconciliation で誤った ep が付け替わる可能性があるが、nvapi 検証（支店判定 + 仮 ep の contentId が nvapi 話一覧に存在）で大幅に緩和。残余リスクは確率 ≈ 2^-32 のため実用上許容。

**本物との区別**: 本物 seriesId は必ず正整数。仮は必ず負整数。重複しない。

---

### 11-5. B4 isAvailable=true 強制の副作用

**状況**: Phase B4 では list.json 掲載シリーズに `isAvailable=true` を強制する。list.json は掲載中作品のみを含むという前提に基づく。

**リスク**: list.json から削除済みの作品が B4 で誤って `true` に戻される可能性。ただし list.json は現在掲載中のリストなので通常このケースは発生しない。

**緩和**: Phase E7 の isAvailable grace が翌日以降に snapshot 不在を検出して `false` に戻す。
