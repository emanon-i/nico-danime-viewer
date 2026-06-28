# PH-0014: description 構造化（synopsis / cast / staff / studios / copyright / links 抽出）

> 本書は機能契約（spec）。**実装済み（2026-06-28、§機能一覧の状態参照）**。前提は**実データ検証**（ローカル `data/series/*.json` 88,154 各話・state/Pages live・RSS 生フィード）に基づく。準拠 L2: `data-inventory.md`（description フィールド定義）/ `dataflow.md`（源→Store→projection）。

## 目的 / 背景

各話の説明文（description）は現状**単一文字列**で保持している（`data-inventory.md` L200 ＝ あらすじ生 HTML、HTML strip は projection 時、複数源競合は **long-wins**）。これが2つの問題を生んでいる。

1. **塊問題（1行詰まり）**: ニコニコ RSS の description は本文を `<p class="nico-description">…</p>` 1個に、**あらすじ＋キャスト＋スタッフ＋©＋話リンクを区切り無しで連結**して配信する（`<br>` 0個）。PH直前の `stripHtml` 改修（commit `889106014`）で `<p>` 境界は改行化したが、**1個の `<p>` 内に詰まった本文は割れない**。構造化された改行版（あらすじ↔キャスト↔スタッフが空行分割）は **nvapi v2/series 由来**にのみ存在する。
2. **long-wins の取り違え**: RSS フラット版（あらすじ＋全クレジット連結で長文）が、nvapi 構造版より**長い**ために long-wins で勝ち、新着各話が潰れて見える（実例: Dr.STONE 第4期 so46471524）。

**混在データの正体（実測）**:

| 観測                                          | 値（ローカル 88k 各話コーパス） |
| --------------------------------------------- | ------------------------------- |
| `\n` を持つ構造化 description（nvapi 由来）   | **87,479 / 87,961 = 99.5%**     |
| フラット長文（`\n`無し・len≥200・RSS 塊疑い） | 1（＝回転窓の新着のみ）         |
| 役:値を `／` で並べた cast 様の行             | 84,611                          |
| スタッフマーカー（`原作:`/`監督:`）を含む     | 82,374                          |
| © 含む / 話リンク含む                         | 68,219 / 85,575                 |

→ **構造化の源（nvapi）はほぼ全話で取得可能**。塊で見えるのは「daily full の nvapi 再 seed 前」の新着各話という時間的回転窓に限られる。よって **(A) 源優先を nvapi 構造版 > RSS フラットにする**ことと **(B) 構造版をフィールド分解する**ことで、ユーザー可視の説明文品質を底上げできる。

## データモデル

各話（series JSON `episodes[]` ＝ L2 EpisodeEntry）に**加算的に**追加する。既存 `description` は後方互換で残す。

| フィールド              | 型                                                  | 説明                                                                                                              |
| ----------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `descriptionRaw`        | `string\|null`                                      | 改行保持の原文（現 `description` 相当をリネーム継承）。**常に無損失で保持**。構造化の有無に関わらず存在           |
| `synopsis`              | `string\|null`                                      | あらすじ本文（プロ―ズ・改行保持）。クレジット類を除いた本体                                                       |
| `cast`                  | `Array<{role:string, actors:string[]}>\|null`       | 役名→声優。`role` は括弧注記・複合役を含みうる。`actors` は通常1、複数あり                                        |
| `staff`                 | `Array<{role:string, names:string[]}>\|null`        | 役割→人名/社名                                                                                                    |
| `studios`               | `string[]\|null`                                    | アニメーション制作会社（`staff` のうち role∈{アニメーション制作, 制作} を投影）                                   |
| `copyright`             | `string\|null`                                      | © 行（原文保持）                                                                                                  |
| `episodeLinks`          | `{prev?:string, next?:string, first?:string}\|null` | 説明文末尾の `so…←前話 / 次話→so… / 第一話→so…` 由来。**relatedSeries（作品間の関連）とは別物**（cross-ref のみ） |
| `descriptionStructured` | `boolean`                                           | 構造化に成功したか（false ＝ raw のみ）                                                                           |

works.json（WorkEntry）は現状維持（`descriptionFirst` 継続）。シリーズ代表 synopsis が要れば後続フェーズで `synopsisFirst` を追加（本フェーズ範囲外）。

> `related`（作品間の関連シリーズ）は既存 `franchiseKey`/`relatedSeries`（`data-inventory.md` L168-171）が担当。本フェーズでは**新設しない**（説明文内の prev/next は `episodeLinks` として別管理）。

## パース規則（実データ由来・誤検知ゼロ志向）

### 前提: 構造化（nvapi）descriptionのみを分解する

- `descriptionRaw` に `\n` を含む（＝nvapi 構造版）場合のみ cast/staff 分解を試みる。
- **フラット（`\n` 無し）は分解しない**。`synopsis = descriptionRaw` とし `descriptionStructured=false`。理由: フラットでは cast→staff が `／` 無しで直結する実例があり（`シュプール:逢坂良太原作:佐賀崎しげる…` ＝ -35310697）、境界が一意に定まらず**誤検知不可避**。

### ブロック分割と分類（段落単位）

1. `descriptionRaw` を `\n{2,}`（空行）で段落に分割。
2. 各段落を**この優先順**で分類:
   1. **copyright**: `©`/`Ⓒ`/`(C)`/`(c)` を含む、または `製作委員会` を含む、または `原作／`（全角スラッシュ）で始まる。
   2. **links/info**: `←前話`/`次話→`/`第一話→`/`第1話→` を含む、または `動画投稿`/`コミュ投稿` を含む。→ `episodeLinks` 抽出、info（投稿日時）は破棄。
   3. **staff**: スタッフキーワード（`原作|総監督|監督|シリーズ構成|脚本|キャラクターデザイン|総作画監督|アニメーション制作|制作|音楽|音響監督|美術監督|美術設定|色彩設計|撮影監督|編集|企画|監修|デザインワークス|演出` のいずれか）＋ `:`/`：` を含む。
   4. **cast**: `名[:：]名` を `／` で2件以上並べた行で、staff キーワードを含まない。
   5. **それ以外**: synopsis（プロ―ズ）。複数段落が synopsis に該当する場合は `\n\n` 連結で保持。

### エントリ分解（cast / staff ブロック内のみ）

- ブロック内を `／` で分割（**`／` 分割はブロック内に限定**。synopsis や © には `／` が出るため全体分割は禁止 ＝ 実例 `【各話概要】…とっとりアニメ編／…探訪！」編`）。
- 各エントリを**最初の** `:`/`：` で `role` と `value` に分ける（半角 `:` 主・全角 `：` も2.3%実在、両対応）。
- `value` 内の複数人は `・`/`、`/`,` で**慎重に**配列化（既定は単一保持。明確に複数人名のときのみ split）。社名・括弧注記（`(KADOKAWA)`/`（みなとそふと）`/`役（『NARUTO』…）`）・英字（`studioぴえろ`/`Lay-duce`/`MONACA`）は**値の一部として保持**。
- `role` 側の括弧（`蔵馬(南野秀一)`）・複合役（`監督・絵コンテ`）はそのまま `role` に保持。

### 確実 / 曖昧の切り分け（誤検知ゼロの判定条件）

| 確実にパース可（採用）                              | 曖昧・誤検知リスク（非採用＝保持にとどめる）                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| nvapi 構造版の**段落境界**（`\n\n`）＝ 99.5% で安定 | フラット RSS の連結文字列（境界が `／` 無しで直結する例あり）                                                                             |
| staff キーワード＋`:` を持つ段落＝staff             | `／` のグローバル分割（synopsis/© に `／` が出る）                                                                                        |
| `名:名／名:名…` を2件以上持つ段落＝cast             | `,`/`、` での value 内強制分割（`演出:林祐一郎、朴性厚`/`Wake Up,Girls！` を割る誤り）                                                    |
| © マーカー段落                                      | role 側に `:` を含む稀例（`収録曲:「…」作詞・作曲：…`）→ first-colon 規則で role を取り違える可能性 → **confidence 低として cast 不採用** |

## 源優先規則（snapshot > nvapi > RSS ＝ 3 段・案X）

実測: **snapshot description は各話単位で 100% `<br>` 構造化**（平均561字・あらすじ+cast+staff+©+links 完備）、
nvapi も同一の `<br>` 構造、**RSS のみ `<p>` ラッパでフラット**。snapshot と nvapi は内容では区別不能なので、
源の出自（`descriptionSource`）を各 upsert に付与して順位付けする。

`chooseDescription(existing, existingSrc, incoming, incomingSrc)` の判定キー（案X）:

1. **構造を持つか（`<br>`）＝安全弁**。万一 snapshot がフラット/空でも構造化 nvapi を潰さない。
2. **源ランク**: `snapshot(3) > nvapi(2) > rss(1) > 不明(0)`。
3. **長さ**（同源・同構造の tie-break）。

帰結:

- snapshot は実測で常に構造化＝**通常は最優先で採用**。
- 新着各話（snapshot 未取得）は RSS が暫定採用 → 次 daily で snapshot 構造版に置換。
- フラット RSS が構造版を潰す事故（旧 long-wins の「新着 1 行詰まり」）を解消。
- `descriptionSource` は series JSON に永続化し再ロードで復元（hourly で snapshot 由来を下位源が上書きしない）。
- パーサ（F-0057）は**この優先で選ばれた 1 本の description** を入力に分解する（源非依存）。

## 未分類の扱い（捨てない・誤検知に気づける）

- 分類できなかった段落は**破棄せず** `synopsis` 末尾に連結 or `descriptionRaw` に必ず残す（`descriptionRaw` は常に無損失）。
- パース時にメトリクスをログ出力: `{各話数, 構造化成功数, 未分類段落数, cast/staff抽出数, フラットfallback数}`。
- **無損失検証**: 抽出した synopsis/cast/staff を再連結した文字種集合が `descriptionRaw` を逸脱しないこと（文字の取りこぼし/捏造ゼロ）。
- 分類率が前回比で急落したら**フォーマットドリフト**として検知（ops-health 連携は将来 §）。

## 後方互換・移行

- 既存 `description`（→ `descriptionRaw`）と `descriptionFirst` は**残す**。新フィールドは加算。フロントは段階的に採用（構造化表示は後続 web フェーズ）。
- **遡及**: description は series JSON 再生成時に毎回 Store から上書き（増分保持なし）。**daily full 1回**で全話が源優先＋構造化で再生成され、過去データも遡及修正される（構造源は 99.5% 既存）。専用バックフィル不要。
- hourly 新着は nvapi seed 済みなら構造化、未 seed なら synopsis フォールバック（次 daily で構造化）。劣化しても raw は保持。

## 機能一覧

> **状態: 実装済み（2026-06-28）**。F-0058 → commit `bc2455623`、F-0057/F-0059 → commit `c294cd803`。
> 実装上の確定事項: ① `descriptionRaw` は既存 `description` フィールド（HTML strip 済み）が担う（リネームせず後方互換）。
> ② cast/staff/studios/copyright は **SeriesEntry** に置き、抽出は **1話目（最古話＝descriptionFirst と同一ソース）1件のみ**を
> パースする（あらすじと cast のソース不整合を解消＋全話パースのコスト回避。cast はシリーズ内ほぼ一定）。各話単位の構造化
> フィールド（synopsis/episodeLinks/descriptionStructured）は廃止。③ 詳細画面は**声優名/人名/制作会社名だけをタグ表示**
> （役名/役割ラベルは捨てる・共通(i)で自動抽出注意）。④ タグへの facet 化（声優/制作のグローバル index）は未実装（要判断）。

## 舞台/ライブ等 非アニメ種別の扱い（分析・現状）

**能動的な専用パースは無い。種別非依存で、アニメ形式に合わないものを precision ガードで「消極的に不採用」しているだけ**（正直な現状）。実データ分析（snapshot 実取得）での所見:

- **実舞台/実ライブは支店カタログに極めて少ない**（title 検索の上位はほぼアニメ。「夢の舞台」等アニメ各話が大半）。
- 観測した実フォーマットと挙動:
  | 種別/形式 | description 形式（実例） | パーサ挙動 |
  | --- | --- | --- |
  | 舞台（ストレートプレイ） | 例 舞台『日本三國』: あらすじ＋`原作:…／脚本・演出:西田大輔／音楽:こおろぎ`（声優 cast 無し） | staff のみ正しく抽出・cast 0（誤抽出なし） |
  | 2.5次元ミュージカル | 例 薄桜鬼: `出演:相馬主計 役：梅津瑞樹　雪村千鶴 役：松崎莉沙／…`（「キャラ 役：俳優」形式・全角space区切り） | value が長く plausibility ガードで**不採用→未分類**（演者を取れない＝取りこぼし。誤抽出はしない） |
  | 実ライブ/コンサート | あらすじ単独（クレジットブロック無し） | cast 0 / staff 0（synopsis のみ） |

- **何を取れて何を捨てているか**: アニメ形式「役名:声優」「役割:人名／」は取れる。ミュージカルの「キャラ 役：俳優」形式は**捨てている（未分類）**＝recall 取りこぼしだが precision は守る。専用パース実装は本フェーズ範囲外（要判断）。

### F-0057: description パーサ（構造分解）

**対応REQ**: REQ-（作品/各話詳細の可読性。`screens.md` 作品詳細 / `data-inventory.md` EpisodeEntry）

nvapi 構造版 description を段落分類し synopsis/cast/staff/studios/copyright/episodeLinks に分解する純関数を `scripts/etl/` に新設。フラットは synopsis フォールバック。

**受け入れ条件**:

- [x] 構造版（`\n\n` 区切り）から synopsis/cast/staff/copyright を正しく抽出（代表 fixture）
- [x] フラット（`\n`無し）は cast/staff を生成せず `descriptionStructured=false`・`synopsis=raw`
- [x] 例外網羅: 括弧付き役名 / 複合役 `監督・絵コンテ` / 全角 `：` / 半角 `/` / 複数声優 / 社名・英字 / © の `原作／`・`/`・`・` / `【各話概要】…／…` synopsis / `収録曲:` の role誤判定回避
- [x] 無損失: 抽出結果が `descriptionRaw` の文字を取りこぼさない/捏造しない（property test）
- [x] 検証: `test_parse_description_*` パス

### F-0058: 源優先マージ（nvapi構造版 > RSS フラット）

**対応REQ**: REQ-（`data-inventory.md` L200 long-wins の改訂）

description マージを源優先に変更。nvapi 構造版があれば長さに関わらず採用、RSS は synopsis フォールバック。

**受け入れ条件**:

- [x] nvapi 構造版 vs より長い RSS フラット → 構造版を採用（Dr.STONE so46471524 相当 fixture）
- [x] nvapi 不在時は RSS を synopsis として採用
- [x] 同一構造クラス内は従来 long-wins 維持（回帰なし）
- [x] 検証: `test_description_source_priority` パス

### F-0059: 構造化フィールドの projection 出力＋メトリクス

**対応REQ**: REQ-（`dataflow.md` projection）

series JSON `episodes[]` に新フィールドを出力（`descriptionRaw` 継続）。パースメトリクスをログ。

**受け入れ条件**:

- [x] series JSON に `synopsis/cast/staff/studios/copyright/episodeLinks/descriptionStructured` を出力
- [x] `descriptionRaw` 後方互換維持・既存 `descriptionFirst` 不変
- [x] 実行ログにパースメトリクス（成功率・未分類数・fallback数）出力
- [x] 検証: projection スナップショットテスト／既存 `data/series` schema 後方互換

## 品質方針（最優先）: precision 100%・recall は犠牲可

**「間違った抽出を絶対にしない」を最優先**。確実に解釈できないものは抽出せず `未分類`（synopsis 温存）へ落とす。
曖昧・パターン外・少しでも誤抽出リスクがあるものは拾わない。出した抽出は1件残らず正しい、を保証する。

**種別横断（アニメだけで判断しない）**: 実データは種別で description フォーマットが異なる。全コーパス（6602 series）を
種別分類して検証した結果:

| 種別（手掛かり）      | series 数 | description 形式                       | 抽出挙動                        |
| --------------------- | --------- | -------------------------------------- | ------------------------------- |
| アニメ（劇場版含む）  | ~5700     | `<br>` 構造・役名:声優／役割:人名      | 正しく抽出                      |
| 実写舞台 / 2.5次元    | 343       | あらすじ単独（クレジット構造なし）が主 | 抽出ゼロ（synopsis のみ）＝安全 |
| 実ライブ / コンサート | 580       | あらすじ単独が主                       | 抽出ゼロ＝安全                  |
| 映画                  | 855       | 大半はアニメ映画＝アニメと同形式       | 正しく抽出                      |

アニメ前提パターンを別種別へ誤適用しないことを実データで確認済み（実写舞台/実ライブは構造を持たず抽出されない）。

precision 防御ガード（誤抽出ゼロの要）:

- nvapi/snapshot 構造版（`<br>` 段落）のみ分解。フラットは synopsis フォールバック。
- cast/staff ブロックは**全エントリが role:value で割れる時のみ**採用（1つでも壊れたらブロックごと synopsis 温存）。
- 値/役が**文の句点**を含む・長すぎる＝プロ―ズ → 不採用。
- **role が数値/記号のみ**（setlist「01:曲名」/タイムテーブル）＝クレジットでない → 不採用。
  value 側の数値風アーティスト名（`029`/`1869`）は正規名なので許容。

## Exit Criteria

- [x] F-0057〜F-0059 の受け入れ条件をすべて満たす
- [x] **誤抽出ゼロを全数で実証**: ローカル 88k 各話・cast 785,550＋staff 742,669 エントリを強条件監査
      （role 非数値・プロ―ズ無し・時刻値無し・長さ妥当）し**違反 0 件**。種別横断で実写舞台/実ライブから誤抽出なし。
- [x] 分類率 ≥ 99%（構造化 99.5%）・未分類段落はログ計上＋synopsis に保持（取りこぼしゼロ・lossless）
- [x] `pnpm test` / `typecheck` / `lint` / `build` 通過

## スコープ外（本フェーズで実装しない）

- フロントの構造化表示（cast/staff のUI描画）＝後続 web フェーズ。本フェーズはデータ生成のみ。
- nvapi クライアント/取得経路の変更。
- `relatedSeries`/`franchiseKey` アルゴリズム変更（`episodeLinks` とは別）。
- new.json の並び順バグ（pubDate RFC822 文字列ソート）＝別件。
- ops-health へのフォーマットドリフト検知統合＝将来。
