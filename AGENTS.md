# AGENTS.md

dアニメストア **ニコニコ支店**専用の非公式ビューア（発見 UI）。本ファイルはコーディングエージェント共通の作業ガイド（**正本**。Claude Code・Codex 等から参照される。Claude Code は `CLAUDE.md` の `@AGENTS.md` import 経由で読む）。

> 現状は**土台のみ**。コマンドは雛形（多くが未実装）。実装は `docs/`（Tri-SSD）の仕様に従って進める。

## コマンド

| コマンド                                     | 用途                                                                                                                                                            | 状態           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `pnpm install`                               | 依存導入（パッケージマネージャ＝**pnpm**）                                                                                                                      | -              |
| `pnpm fetch`                                 | 各源(snapshot/RSS/list.json…) → メモリ ETL → `data/*.json` を生成                                                                                               | 実装済み       |
| `pnpm ops:health`                            | 運用ヘルスチェック（Pages/state/Actions＋構造健全性＋U1〜U4 ユーザー可視整合性）。`-- --ci` でデータ正しさ FAIL のみ exit1（通知用）／`-- --json`／`-- --quiet` | 実装済み       |
| `pnpm dev`                                   | `web/` のローカル開発サーバ                                                                                                                                     | 雛形（未実装） |
| `pnpm build`                                 | 静的サイトをビルド → `dist/`                                                                                                                                    | 雛形（未実装） |
| `pnpm test` / `pnpm lint` / `pnpm typecheck` | テスト / Lint / 型チェック                                                                                                                                      | 実装済み       |

実装が進んだら、本表の「状態」を更新し、テスト／型チェックのコマンドもここに追記する。

## コーディング規約

- **言語/構成**: データ取得は Node.js（ESM, `.mjs`）。フロントは静的サイト（**Vite + TypeScript**・**pnpm**）。加工はメモリ上の純 JS ETL（Store Map → 静的 JSON）。
- **取得と表示の分離を崩さない**: ブラウザから外部 API を直接叩かない（CORS）。データは必ず `scripts/` → `data/*.json` 経由で渡す。
- **支店の絞り込みはコードで固定**: `channelId === 2632720`（ニコニコ支店）のみ採用。`channelId` は API の filter 不可なので**取得後にクライアント側で絞る**。本店（docomo）データは混ぜない。
- **生成物はコミットしない**: `data/series/`・`data/state/` は `pnpm fetch` の出力。git 管理外（`.gitignore` 済）。
- **deep-link のみ**: 視聴導線は公式プレイヤーへのリンク。動画本体・字幕等は扱わない／再配布しない。
- **命名・整形・import 順などは linter/formatter に委譲**（本ファイルには書かない）。

## 技術スタック / プロジェクト目的

**目的**: dアニメストア ニコニコ支店（docomo 本店とは**別サービス**＝ラインナップ・プレイヤーが別、本店は対象外）の
“見やすい”発見ページ。視聴は公式プレイヤーへ deep-link。
**設計の指針**: 予測どおりに動く（同じ操作で同じ結果・隠れた並び替えをしない）／時間を奪わない（自動再生・罠の導線をしない）。

**データ源（公開・非営利・User-Agent 必須）**

- 主軸: ニコニコ snapshot 検索 API
  `https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search`
  - `q=dアニメストア` / `targets=tagsExact` で支店コンテンツ取得
  - 取得フィールド: `contentId`(so…) / `title` / `viewCounter` / `tags` / `startTime` / `thumbnailUrl` など（`genre` は 99.95%「アニメ」一色で使わない）
  - 支店絞り込み: `channelId == 2632720`（取得のみ可・filter 不可 → クライアント側）
- 新着（毎時）: チャンネル RSS `ch.nicovideo.jp/ch2632720/video?rss=2.0`（id は数値 watch id ＝ `contentId` so… と形式違い・要解決）
- 補助: `list.json`（全作品/五十音 col_key）／`programlist.json`（今季）／nvapi `v2/series/<id>`（各話・話順・支店判定）／`anime.nicovideo.jp/period/<年>-<季>-danime.html`（クール・過去季）

**構成方針**: fetch スクリプトで各源を**メモリ上の Store（JS Map）で増分 upsert・ETL → 用途別静的 JSON 化 → 静的サイトが読む**。
**新着＝チャンネル RSS で毎時／発見系＝snapshot 日次**。詳細は L2 `dataflow.md`。

**v1 スコープ**: 全作品ブラウズ ＋ 人気/勢いランキング ＋ **タグ（フラット 1 系統・dアニメキュレーション正規化含む）** ＋ 五十音 ＋ クール ＋ 新着 ＋ 関連シリーズ(ベストエフォート) ＋ deep-link ＋ お気に入り/見た(localStorage)。
**勢い（Hot）**: 前日比 delta（`prev_view_counter` の 1 スロット bounded）＋ velocity（合算 ÷ 経過日数）＋ recency のブレンド（無制限履歴なし）。人気TOP＝累計再生数順。
**将来（v1スコープ外）**: 正確な週/月の急上昇（期間デルタ）・近い作品リコメンド・視聴履歴を使う個人化（**別プロジェクト＝視聴履歴ブラウザ拡張等に依存**）。

**レイヤー構成**

| パス                                 | 役割                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `scripts/`                           | データ取得（API → `data/*.json`）                                                                                         |
| `data/`                              | 静的 JSON 出力（生成物・git 管理外）                                                                                      |
| `web/`                               | 静的フロント（`data/*.json` を読む）                                                                                      |
| `docs/`                              | 仕様（Tri-SSD: L0/L1/L2/L3。L2＝foundation/screens/dataflow/db-design/security/validation）                               |
| `.claude/skills/`・`.agents/skills/` | プロジェクト用 Agent Skill（nico API リファレンス＆ヘルパ）。前者＝Claude Code／後者＝AGENTS 準拠ツール用の同一内容の複製 |

## 完了前チェック

変更を「完了」とする前に確認する:

1. **取得/表示の分離**を破っていないか（ブラウザから直 API なし）。
2. **支店フィルタ**（`channelId === 2632720`）が効いているか。本店データの混入なし。
3. **API マナー**: User-Agent を付与しているか／過剰アクセス・並列過多になっていないか。
4. **生成物**（`data/*.json`）を誤ってコミットしていないか。
5. `pnpm` のコマンド（test/lint/typecheck/build/fetch）が通るか（実装済みのもの）。
6. スコープ（v1 / 将来）を逸脱した実装を混ぜていないか。`genre` を facet 化していないか（タグに統合）。
7. `docs/` の対応する仕様（受け入れ条件）を満たしているか。

## ワークフロー

仕様駆動（Tri-SSD プラグイン）で進める。**L0 → L1 → L2 → L3 → gen-code** の順。docs 構造は初期化済み。

0. **L0 要求**（`docs/l0_ideas/requirement.md`）— 背景・欲求・判断基準の大元。すべての設計判断はここに照らす（指針: 予測どおりに動く／時間を奪わない）。
1. `/gen-l1` — L1 要件（`docs/l1_requirements/vision.md`）。L0 を踏まえて作成。
2. `/gen-l2` — L2 システム構成（`docs/l2_foundation/foundation.md`）。技術スタックはここで確定。
3. `/gen-l3` — L3 フェーズ（機能 + 受け入れ条件、`docs/l3_phases/PH-xxxx.md`）。
4. `/gen-code <PH-xxxx>` — フェーズ単位でコード／テストを生成。**実装フェーズは設計→実装でモデルを切り替える**（Claude Code は opusplan＝plan=Opus で設計 → execute=Sonnet で実装、の自動切替。`.claude/settings.json` で既定化済み）。
5. 完了したら `/archive-l3 <PH-xxxx>` でアーカイブ。

**着手前**: `docs/l0_ideas/` の要求と関連する L1〜L3 を読み、判断に迷ったら L0 の指針に照らす。
**データ取得時**: プロジェクトの `nico-snapshot-api` スキル（`.claude/skills/` ／ `.agents/skills/`）を参照（支店の取り方・ランキング/各話(nvapi)・RSS新着・タグ正規化・補助源・ToS・CORS）。
