# description-extraction.md — description 構造化・抽出仕様

> Tri-SSD L2 基盤ドキュメント。**本書が「各話 description（あらすじ/キャスト/スタッフ/制作会社/©）の分析・抽出・誤検知防止」の正本**。
> 実コードと 1:1（関数名・実値・file:line 付き・盛らず実装どおり）。フィールド定義の正本は [`data-inventory.md`](data-inventory.md)（SeriesEntry §2.6 / EpisodeEntry）、
> 源→Store→projection の流れは [`dataflow.md`](dataflow.md)。本仕様を「この phase でどう実装したか」の記録は L3 [`../l3_phases/PH-0014_description-structuring.md`](../l3_phases/PH-0014_description-structuring.md)。
> 抽出仕様はフェーズ固有でなく**長期 foundational 仕様**のため L2 に置く（二重管理を避ける＝本書が唯一の正本）。
>
> 実体ファイル: `scripts/etl/description.mjs`（パーサ本体）/ `scripts/etl/series.mjs`（HTML 正規化・構造判定・源優先）/ `scripts/store/store.mjs`・`scripts/store/project.mjs`（1話目スコープの呼び出し元）。

---

## 目次

1. [背景・問題](#1-背景問題)
2. [データモデル](#2-データモデル)
3. [どう分析するか（構造判定 → 正規化 → 段落分割 → 分類）](#3-どう分析するか)
4. [どう抽出するか（エントリ分解・1話目スコープ・源優先）](#4-どう抽出するか)
5. [どう誤検知を防ぐか（precision ガード）](#5-どう誤検知を防ぐか)
6. [未分類の扱い（lossless）](#6-未分類の扱い)
7. [既知の取りこぼし（recall を犠牲にしている所）](#7-既知の取りこぼし)
8. [検証（誤抽出ゼロの実証）](#8-検証)
9. [カバレッジ実測（シリーズ単位）](#9-カバレッジ実測)
10. [実装インデックス（関数 / file:line）](#10-実装インデックス)

---

## 1. 背景・問題

各話の説明文（description）は単一文字列で保持する（[`data-inventory.md`](data-inventory.md) EpisodeEntry `description`）。源によりフォーマットが異なり、素朴な long-wins では破綻していた。

1. **塊問題（1行詰まり）**: ニコニコ RSS の description は本文を `<p class="nico-description">…</p>` 1 個に、**あらすじ＋キャスト＋スタッフ＋©＋話リンクを区切り無しで連結**して配信する（`<br>` 0 個）。構造化された改行版（あらすじ↔キャスト↔スタッフが空行分割）は **snapshot / nvapi 由来**にのみ存在する。
2. **long-wins の取り違え**: RSS フラット版（全クレジット連結で長文）が、構造版より長いため long-wins で勝ち、新着各話が潰れて見える（実例: Dr.STONE 第4期 so46471524）。

**混在データの正体（実測・ローカル 88k 各話コーパス）**:

| 観測                                          | 値                          |
| --------------------------------------------- | --------------------------- |
| `\n` を持つ構造化 description（nvapi 由来）   | **87,479 / 87,961 = 99.5%** |
| フラット長文（`\n`無し・len≥200・RSS 塊疑い） | 1（＝回転窓の新着のみ）     |
| 役:値を `／` で並べた cast 様の行             | 84,611                      |
| スタッフマーカー（`原作:`/`監督:`）を含む     | 82,374                      |
| © 含む / 話リンク含む                         | 68,219 / 85,575             |

→ 構造化の源はほぼ全話で取得可能。塊で見えるのは「daily full の構造版再取得前」の新着各話という時間的回転窓に限られる。よって **(A) 源優先で構造版を採る** ＋ **(B) 構造版をフィールド分解する** で説明文品質を底上げする。

## 2. データモデル

cast/staff/studios/copyright は **SeriesEntry（series 単位）** に置く（フィールド定義の正本は [`data-inventory.md`](data-inventory.md) §2.6）。抽出は **1話目（最古話）1 件のみ**（→ §4）。

| フィールド  | 型                                      | 説明                                                                         |
| ----------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| `cast`      | `Array<{role:string, actors:string[]}>` | 役名→声優。`role` は括弧注記・複合役を含みうる。詳細画面は声優名のみタグ表示 |
| `staff`     | `Array<{role:string, names:string[]}>`  | 役割→人名/社名                                                               |
| `studios`   | `string[]`                              | 制作会社（`staff` の制作系 role から投影・重複排除）                         |
| `copyright` | `string\|null`                          | © 行（原文保持）                                                             |

各話の `description`（HTML strip 済み）は後方互換で残す（無損失原文）。works.json（WorkEntry）には人物フィルタ用に cast/staff の**名前配列のみ**を付与（[`data-inventory.md`](data-inventory.md) §4.1）。per-episode の構造化フィールド（synopsis/episodeLinks/descriptionStructured）は廃止（1話目スコープへ移行済み）。

## 3. どう分析するか

1. **構造判定（安全弁）** — `isStructuredDescription(raw)`（`series.mjs:52`・判定式 `/<br\s*\/?>|&lt;\s*br/i`）。生 description に `<br>`（または実体参照 `&lt;br`）があるものだけ「構造版」とみなす。**無ければ一切分解しない**（→ §5 ガード①）。
2. **HTML 正規化** — `stripHtml(raw)`（`series.mjs:7`）。`<br>` と `</p></div></li>`・各開始タグを `\n` 化 → 残タグ除去 → 実体参照デコード → `\n{3,}`→`\n\n`・行頭行末空白除去。
3. **段落分割** — `parseDescription`（`description.mjs:147`）が正規化テキストを **`\n{2,}`（空行）で段落配列**化（`description.mjs:162`）。
4. **段落分類（コード順＝`description.mjs:181-223`。最初に一致で確定）**:
   1. **links/info**: `LINKS_RE`(`←前話`/`次話→`/`第一話→`) または `INFO_RE`(`動画投稿`/`コミュ投稿`・160字未満)。→ `extractEpisodeLinks`(`description.mjs:118`) で prev/next/first を拾い、本文は synopsis に出さない。
   2. **copyright**: `COPYRIGHT_RE`(`/[©Ⓒ]|\(C\)|\(c\)|製作委員会/`) または `^原作／`。
   3. **staff**: `hasStaffKeyword`(`description.mjs:61`)＝`STAFF_KEYS`（`原作`〜`編曲`・全 38 語・`description.mjs:16-55`）のいずれか＋`:`/`：`。
   4. **cast**: `looksLikeCast`(`description.mjs:82`)＝staff キーワードを含まず、`／` で 2 件以上、各セグメントに `:`/`：`。
   5. **それ以外**: synopsis（プロ―ズ）。複数段落は `\n\n` 連結で保持。
   - フラット（構造版でない）は 3〜4 を行わず、info 段落だけ落として全文を synopsis に温存（`description.mjs:168-171`）。

## 4. どう抽出するか

- **エントリ分解** `parseEntries`（`description.mjs:66`）: 段落を **全角 `／`** で分割し、各セグメントを **最初の `:`/`：`** で `role`/`value` に割る（`/^([^：:]+)[：:]\s*(.+)$/`・半角 `:` 主/全角 `：` も 2.3% 実在・両対応）。**1 セグメントでも割れなければ `null`＝ブロックごと不採用**（→ §5 ガード⑤）。`／` 分割は **ブロック内に限定**（synopsis/© に `／` が出るため全体分割は禁止＝実例 `【各話概要】…とっとりアニメ編／…探訪！」編`）。
- **value 内の複数人**は `・`/`、`/`,` で**慎重に**配列化（既定は単一保持。明確に複数人名のときのみ split）。社名・括弧注記（`(KADOKAWA)`/`（みなとそふと）`）・英字（`studioぴえろ`/`Lay-duce`/`MONACA`）は**値の一部として保持**。`role` 側の括弧（`蔵馬(南野秀一)`）・複合役（`監督・絵コンテ`）はそのまま `role` に保持。
- **cast**: 採用エントリを `{role, actors:[value]}`。役名(role)は保持するが UI では捨て、**声優名(value)だけタグ表示**。
- **staff / studios**: `{role, names:[value]}`。`isStudioRole`(`description.mjs:129`＝role に `アニメーション制作` を含む/`制作`/`製作`)なら `studios` にも投影・重複排除。
- **copyright**: © 段落を原文保持。
- **1話目スコープ**: cast/staff/studios/copyright は各シリーズの **最古話 `chronoSort[0]`（あらすじ `descriptionFirst` と同一ソース）1 件だけ**をパース。あらすじと cast のソース不整合を解消＋全話パースのコスト回避（cast はシリーズ内ほぼ一定）。series JSON は `_buildSeriesJson`（`store.mjs:419` `parseDescription(episodes[0].description)`）、works.json は `buildCreditsMap`（`project.mjs:44`）。
- **源優先（パース入力 1 本の選定）**: `chooseDescription`（`series.mjs`）が以下の順で 1 本を選ぶ（F-0058 案X）。パーサはその 1 本を入力にする（源非依存）。
  1. **構造を持つか（`<br>`）＝安全弁**。万一 snapshot がフラット/空でも構造版を潰さない。
  2. **源ランク**: `snapshot(3) > nvapi(2) > rss(1) > 不明(0)`。snapshot/nvapi は内容では区別不能なので出自（`descriptionSource`）を upsert に付与して順位付け。
  3. **長さ**（同源・同構造の tie-break）。
  - 帰結: snapshot は実測で常に構造化＝通常最優先。新着各話（snapshot 未取得）は RSS 暫定 → 次 daily で snapshot 構造版に置換。`descriptionSource` は series JSON に永続化し再ロードで復元（hourly で下位源が snapshot 由来を上書きしない）。

## 5. どう誤検知を防ぐか

**方針: precision 100%・recall 犠牲可。** 確実に解釈できないものは抽出せず synopsis に温存（lossless）。出した抽出は 1 件残らず正しい、を保証する。

| #   | ガード                                                                                                                                  | 実装（file:line）                                                                                                                                    | 防ぐ誤検知（例）                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | **構造(`<br>`)が無ければ一切分解せず synopsis 扱い**                                                                                    | `isStructuredDescription`(`series.mjs:52`) → `description.mjs:161,168-171`                                                                           | フラット RSS の連結文字列。あらすじ→cast が `／` 無しで直結する例（`シュプール:逢坂良太原作:佐賀崎しげる…`）は境界が一意化できず分解＝誤検知 |
| ②   | **cast 候補は `／` で 2 件以上＋各セグに `:`/`：`**                                                                                     | `looksLikeCast`(`description.mjs:82`)                                                                                                                | コロン 1 個だけの台詞・文を cast 化しない                                                                                                    |
| ③   | **値長/役長/プロ―ズ上限**: 値平均 ≤22(cast)/≤30(staff)・値最大 ≤100(cast)/≤120(staff)・役 ≤50・`hasProsePeriod`（句点を含む）なら不採用 | `isPlausibleCreditBlock(entries,22,100)`(cast `description.mjs:213`)・`(entries,30,120)`(staff `:197`)、`hasProsePeriod`(`:91` `/。(?![）」』）])/`) | 各話要約「#3：突如現れたメフィスト。…／#4：…」や台詞コロン文を cast/staff と誤認しない。『バクマン。』等の句点は閉じ括弧前で除外             |
| ④   | **数値/記号のみの role を除外**（setlist「01:曲名」/タイムテーブル）                                                                    | `NUMERIC_ROLE_RE`(`description.mjs:102` `/^[\d\s.:#＃[\]()（）-]+$/`) → `:111`                                                                       | ライブの曲順番号をクレジットと誤認しない。value 側の数値風名（イラスト「029」/作曲「1869」）は正規なので許容                                 |
| ⑤   | **割れない行はブロックごと捨てて synopsis に温存（lossless）**                                                                          | `parseEntries` が `null`(`description.mjs:75`) → `unclassified`＋`synopsisParas`(`:205-206,217-218`)                                                 | 半端な抽出を作らない。捨てた段落は synopsis に必ず残り、文字の取りこぼし/捏造ゼロ                                                            |
| ⑥   | **種別専用パースを持たず、曖昧は落とす**                                                                                                | 能動的 stage/live パースなし（①〜⑤の消極的不採用のみ）                                                                                               | アニメ前提パターンを舞台/ライブへ誤適用しない（②③で自然に不採用）                                                                            |

**確実 / 曖昧の切り分け（補足）**:

| 確実にパース可（採用）                        | 曖昧・誤検知リスク（非採用＝保持にとどめる）                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 構造版の**段落境界**（`\n\n`）＝ 99.5% で安定 | フラット RSS の連結文字列（境界が `／` 無しで直結する例あり）                                                 |
| staff キーワード＋`:` を持つ段落＝staff       | `／` のグローバル分割（synopsis/© に `／` が出る）                                                            |
| `名:名／名:名…` を 2 件以上持つ段落＝cast     | `,`/`、` での value 内強制分割（`演出:林祐一郎、朴性厚`/`Wake Up,Girls！` を割る誤り）                        |
| © マーカー段落                                | role 側に `:` を含む稀例（`収録曲:「…」作詞・作曲：…`）→ first-colon で role を取り違える可能性 → cast 不採用 |

## 6. 未分類の扱い

- 分類できなかった段落は**破棄せず** `synopsis` 末尾に連結＋`unclassified` に記録（原文は常に無損失）。
- パース時にメトリクスをログ出力（`summarizeDescriptionParse`・`description.mjs:244`）: `{total, structured, flatFallback, withCast/Staff/Studios/Copyright, unclassifiedParagraphs, parsedRatePct}`。
- **無損失検証**: 抽出した synopsis/cast/staff を再連結した文字集合が原文を逸脱しないこと（取りこぼし/捏造ゼロ）。
- 分類率が前回比で急落したら**フォーマットドリフト**として検知（ops-health 連携は将来）。

## 7. 既知の取りこぼし

precision のために recall を意図的に捨てている箇所:

- **フラット RSS**: 構造判定①で丸ごと synopsis（新着各話の暫定。次 daily で snapshot 構造版へ置換）。
- **2.5 次元ミュージカルの「キャラ 役：俳優」形式**（全角 space 区切り・例 薄桜鬼 `出演:相馬主計 役：梅津瑞樹…`）: value が長く③で不採用＝**演者を取れない**（誤抽出はしない）。
- **役割ラベル**: UI では cast/staff の role を捨て、名前だけ表示（曖昧な役名の露出を避ける）。

## 8. 検証

- **全 88k 各話の強条件全数監査**: cast 785,550＋staff 742,669 エントリを「role 非数値・プロ―ズ無し・時刻値無し・長さ妥当」で監査し **違反 0 件**。種別横断で実写舞台/実ライブから誤抽出なし。
- **ライブサンプル監査**（2026-06-29 実測）: ローカル全 6,601 シリーズの **1話目 contentId を live snapshot（`filters[contentId]`・生 `<br>` 付き）で引き直し** 922 件をパース。代表 598 シリーズで cast≥1=79.8%・全空 7.5%、種別別でも **誤抽出 0**（§9）。
- **無損失（lossless）**: 抽出 synopsis/cast/staff を再連結した文字集合が原文を逸脱しない。
- **Exit Criteria（PH-0014）**: 分類率 ≥ 99%（構造化 99.5%）・誤抽出ゼロを全数で実証・`pnpm test`/`typecheck`/`lint`/`build` 通過。

## 9. カバレッジ実測

**測定方法**: ローカル全 6,601 シリーズ（1話目=so）から `chronoSort[0]`（最古話＝あらすじと同一ソース）の contentId を求め、その**生 description を live snapshot（`filters[contentId]`・`<br>` 付き）で取得 → `parseDescription`**。取得 922 件すべて `<br>` 構造あり。代表＝seriesId 全域の系統サンプル 598 件、希少種別は targeted 補強。**シリーズ単位カバレッジ**（各話サンプルではない）。

**シリーズ単位（代表 n=598）**:

| 指標                                               | 実数 | 率        |
| -------------------------------------------------- | ---- | --------- |
| cast≥1 が入る                                      | 477  | **79.8%** |
| staff≥1                                            | 434  | **72.6%** |
| studios≥1                                          | 293  | **49.0%** |
| copyright                                          | 494  | **82.6%** |
| cast/staff/studios 全部空（1話目から何も取れない） | 45   | **7.5%**  |

分布: cast 件数 中央値 7 / 平均 7.87、staff 件数 中央値 7 / 平均 7.70。

**種別別**（title/tags ヒューリスティック分類のため率は方向性）:

| 種別         | n   | cast≥1    | staff≥1 | studios≥1 | 全空  | cast 中央値 |
| ------------ | --- | --------- | ------- | --------- | ----- | ----------- |
| アニメ       | 421 | **85.0%** | 74.8%   | 55.3%     | 5.7%  | 7           |
| 劇場版・映画 | 188 | **80.3%** | 76.6%   | 39.4%     | 5.3%  | 7           |
| ライブ       | 176 | **59.7%** | 55.1%   | 33.5%     | 17.6% | 4.5         |
| 舞台         | 137 | **31.4%** | 61.3%   | 10.2%     | 22.6% | **0**       |

- 映画はよく取れる（cast 80%）。舞台は staff 寄り・cast 薄い（ミュージカルの「役：」形式が③で不採用）。ライブは cast 60%（アーティスト名が `役割：名前` 形で書かれる作品が一定数）。
- 1話目=so シリーズの種別内訳（同 heuristic・偽陽性あり）: アニメ 4,596 / 映画 947 / ライブ 717 / 舞台 341。
- **「各話 88.4%」と「1話目シリーズ 79.8%」の差**（≈8.6pt）は**集計単位の違い**が主因。各話サンプルは各話にクレジットが並ぶ長尺アニメへ重みが偏る。シリーズ単位は短編（映画・舞台・ライブ・特番・OVA）も 1 シリーズ=1 票で効くため低カバレッジ種別が平均を下げる。加えて 1話目が予告/PV でクレジット薄い例も一部寄与。→ 「人物フィルタで使える作品の割合」としては 79.8%（cast≥1）が実態に近い。

## 10. 実装インデックス

| 関数 / 定数                 | file:line               | 役割                                             |
| --------------------------- | ----------------------- | ------------------------------------------------ |
| `parseDescription`          | `description.mjs:147`   | パーサ本体（段落分割→分類→抽出）                 |
| `stripHtml`                 | `series.mjs:7`          | HTML 正規化（`<br>`/`<p>`→`\n`）                 |
| `isStructuredDescription`   | `series.mjs:52`         | 構造判定（`<br>` 有無）＝安全弁①                 |
| `chooseDescription`         | `series.mjs`            | 源優先マージ（構造→源ランク→長さ）               |
| `STAFF_KEYS`                | `description.mjs:16-55` | スタッフ役割マーカー（全 38 語）                 |
| `hasStaffKeyword`           | `description.mjs:61`    | staff 段落判定                                   |
| `parseEntries`              | `description.mjs:66`    | `／` 分割＋最初の `:` 分解（割れなければ null）⑤ |
| `looksLikeCast`             | `description.mjs:82`    | cast 段落判定②                                   |
| `hasProsePeriod`            | `description.mjs:91`    | 文の句点検出③                                    |
| `NUMERIC_ROLE_RE`           | `description.mjs:102`   | 数値 role 除外④                                  |
| `isPlausibleCreditBlock`    | `description.mjs:103`   | 値長/役長/プロ―ズ上限③                           |
| `extractEpisodeLinks`       | `description.mjs:118`   | 前話/次話/第一話リンク                           |
| `isStudioRole`              | `description.mjs:129`   | studios 投影判定                                 |
| `summarizeDescriptionParse` | `description.mjs:244`   | メトリクス集計（ログ/回帰検出）                  |
| `_buildSeriesJson`（1話目） | `store.mjs:419`         | series JSON へ cast/staff（1話目パース）         |
| `buildCreditsMap`（1話目）  | `project.mjs:44`        | works.json へ cast/staff 名前配列                |
