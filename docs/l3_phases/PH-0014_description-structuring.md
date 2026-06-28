# PH-0014: description 構造化（synopsis / cast / staff / studios / copyright / links 抽出）

> 本書は **この phase で何を実装したか**の記録（L3）。**抽出仕様の正本は L2 [`../l2_foundation/description-extraction.md`](../l2_foundation/description-extraction.md)**（分析・抽出・誤検知防止・検証・カバレッジを実コードと 1:1 で明文化）。本書は仕様を再掲せずリンクするだけにし、二重管理を避ける。
> **状態: 実装済み（2026-06-28）**。F-0058 → commit `bc2455623`、F-0057/F-0059 → commit `c294cd803`。準拠 L2: [`data-inventory.md`](../l2_foundation/data-inventory.md)（フィールド定義）/ [`dataflow.md`](../l2_foundation/dataflow.md)（源→Store→projection）。

## 目的

各話 description は源（snapshot/nvapi/RSS）でフォーマットが異なり、素朴な long-wins では新着各話が「1 行詰まり」で潰れ、クレジットも構造化されていなかった。本フェーズで **(A) 源優先で構造版を採用**し、**(B) 構造版を synopsis/cast/staff/studios/copyright に分解**して、ユーザー可視の説明文品質と人物メタを底上げする。背景の実測・問題分析は L2 [`description-extraction.md` §1](../l2_foundation/description-extraction.md#1-背景問題)。

## 抽出仕様（正本は L2）

分析（構造判定→段落分割→分類 links/info→copyright→staff→cast→synopsis）・抽出（全角 `／`/最初の `:` 区切り、1話目スコープ、源優先 snapshot>nvapi>RSS）・**誤検知防止（precision ガード①〜⑥）**・検証・カバレッジ実測は、すべて L2 [`description-extraction.md`](../l2_foundation/description-extraction.md) に集約（実値・関数名・file:line 付き）。本書では再掲しない。

## データモデル（実装上の確定）

- cast/staff/studios/copyright は **SeriesEntry**（series 単位）に置く。抽出は **1話目（最古話＝`descriptionFirst` と同一ソース）1 件のみ**（あらすじと cast のソース不整合を解消＋全話パースのコスト回避。cast はシリーズ内ほぼ一定）。フィールド定義は [`data-inventory.md`](../l2_foundation/data-inventory.md) §2.6、機構の正本は L2 [`description-extraction.md` §2/§4](../l2_foundation/description-extraction.md#2-データモデル)。
- `descriptionRaw` は既存 `description` フィールド（HTML strip 済み）が担う（リネームせず後方互換）。各話単位の構造化フィールド（synopsis/episodeLinks/descriptionStructured）は**廃止**（per-episode パースをやめ 1話目スコープへ）。
- 詳細画面は**声優名/人名/制作会社名だけをタグ表示**（役名/役割ラベルは捨てる・共通 (i) で自動抽出注意）。タグへの facet 化（声優/制作のグローバル index）は未実装（要判断）。

## 機能一覧

### F-0057: description パーサ（構造分解）

**対応REQ**: 作品/各話詳細の可読性（`screens.md` 作品詳細 / `data-inventory.md` EpisodeEntry）

構造版 description を段落分類し synopsis/cast/staff/studios/copyright/episodeLinks に分解する純関数を `scripts/etl/description.mjs` に新設。フラットは synopsis フォールバック。**規則の正本は L2 §3〜§5**。

**受け入れ条件**:

- [x] 構造版（`\n\n` 区切り）から synopsis/cast/staff/copyright を正しく抽出（代表 fixture）
- [x] フラット（`\n`無し）は cast/staff を生成せず `descriptionStructured=false`・`synopsis=raw`
- [x] 例外網羅: 括弧付き役名 / 複合役 `監督・絵コンテ` / 全角 `：` / 半角 `/` / 複数声優 / 社名・英字 / © の `原作／`・`/`・`・` / `【各話概要】…／…` synopsis / `収録曲:` の role 誤判定回避
- [x] 無損失: 抽出結果が原文の文字を取りこぼさない/捏造しない（property test）
- [x] 検証: `test_parse_description_*` パス

### F-0058: 源優先マージ（snapshot > nvapi > RSS）

**対応REQ**: `data-inventory.md` long-wins の改訂

description マージを源優先に変更（`chooseDescription`）。構造版があれば長さに関わらず採用、RSS は synopsis フォールバック。**規則の正本は L2 §4「源優先」**。

**受け入れ条件**:

- [x] nvapi/snapshot 構造版 vs より長い RSS フラット → 構造版を採用（Dr.STONE so46471524 相当 fixture）
- [x] 構造版不在時は RSS を synopsis として採用
- [x] 同一構造クラス内は従来 long-wins 維持（回帰なし）
- [x] 検証: `test_description_source_priority` パス

### F-0059: 構造化フィールドの projection 出力＋メトリクス

**対応REQ**: `dataflow.md` projection

series JSON / works.json に cast/staff/studios/copyright を出力（`descriptionRaw` 継続）。パースメトリクスをログ（`summarizeDescriptionParse`）。

**受け入れ条件**:

- [x] series JSON に cast/staff/studios/copyright を出力（1話目スコープ）
- [x] `descriptionRaw` 後方互換維持・既存 `descriptionFirst` 不変
- [x] 実行ログにパースメトリクス（成功率・未分類数・fallback数）出力
- [x] 検証: projection スナップショットテスト／既存 `data/series` schema 後方互換

## 後方互換・移行

- 既存 `description`（→ `descriptionRaw` 相当）と `descriptionFirst` は**残す**。新フィールドは加算。
- **遡及**: description は series JSON 再生成時に毎回 Store から上書き（増分保持なし）。**daily full 1 回**で全話が源優先＋構造化で再生成され、過去データも遡及修正される（構造源は 99.5% 既存）。専用バックフィル不要。
- hourly 新着は構造版 seed 済みなら構造化、未 seed なら synopsis フォールバック（次 daily で構造化）。劣化しても raw は保持。毎時 partial は daily full が入れた cast/staff を carry-forward して落とさない（`project.mjs exportWorksPartial`・commit `727feebb3`）。

## Exit Criteria

- [x] F-0057〜F-0059 の受け入れ条件をすべて満たす
- [x] **誤抽出ゼロを全数で実証**: ローカル 88k 各話・cast 785,550＋staff 742,669 エントリを強条件監査（role 非数値・プロ―ズ無し・時刻値無し・長さ妥当）し**違反 0 件**。種別横断で実写舞台/実ライブから誤抽出なし。詳細・ライブサンプル監査は L2 [`description-extraction.md` §8](../l2_foundation/description-extraction.md#8-検証)。
- [x] 分類率 ≥ 99%（構造化 99.5%）・未分類段落はログ計上＋synopsis に保持（取りこぼしゼロ・lossless）
- [x] `pnpm test` / `typecheck` / `lint` / `build` 通過

## スコープ外（本フェーズで実装しない）

- フロントの構造化表示（cast/staff の UI 描画）＝後続 web フェーズで実装済み（人物フィルタ・タグ表示）。
- nvapi クライアント/取得経路の変更。
- `relatedSeries`/`franchiseKey` アルゴリズム変更（`episodeLinks` とは別）。
- ops-health へのフォーマットドリフト検知統合＝将来。
