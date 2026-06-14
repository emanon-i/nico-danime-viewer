# CLAUDE.md

dアニメストア **ニコニコ支店**専用の非公式ビューア（発見 UI）。本ファイルは Claude Code 向けの作業ガイド。

> 現状は**土台のみ**。コマンドは雛形（多くが未実装）。実装は `docs/`（Tri-SSD）の仕様に従って進める。

## コマンド

| コマンド | 用途 | 状態 |
|---------|------|------|
| `npm install` | 依存導入 | - |
| `npm run fetch` | snapshot API → `data/*.json` を生成 | 雛形（未実装） |
| `npm run dev` | `web/` のローカル開発サーバ | 雛形（未実装） |
| `npm run build` | 静的サイトをビルド → `dist/` | 雛形（未実装） |
| `npm run serve` | ビルド済み `dist/` を配信 | 雛形（未実装） |

実装が進んだら、本表の「状態」を更新し、テスト／型チェックのコマンドもここに追記する。

## コーディング規約

- **言語/構成**: データ取得は Node.js（ESM, `.mjs`）。フロントは静的サイト（軽量志向。Vite + TypeScript を想定、フレームワークは未確定）。
- **取得と表示の分離を崩さない**: ブラウザから外部 API を直接叩かない（CORS）。データは必ず `scripts/` → `data/*.json` 経由で渡す。
- **支店の絞り込みはコードで固定**: `channelId === 2632720`（ニコニコ支店）のみ採用。`channelId` は API の filter 不可なので**取得後にクライアント側で絞る**。本店（docomo）データは混ぜない。
- **生成物はコミットしない**: `data/*.json` は `npm run fetch` の出力。git 管理外（`.gitignore` 済）。
- **deep-link のみ**: 視聴導線は公式プレイヤーへのリンク。動画本体・字幕等は扱わない／再配布しない。
- **命名・整形・import 順などは linter/formatter に委譲**（本ファイルには書かない）。

## 技術スタック / プロジェクト目的

**目的**: dアニメストア ニコニコ支店（docomo 本店とは**別サービス**＝ラインナップ・プレイヤーが別、本店は対象外）の、
行動心理にもとづく“見やすい”発見ページ。視聴は公式プレイヤーへ deep-link。

**データ源（公開・非営利・User-Agent 必須）**

- 主軸: ニコニコ snapshot 検索 API
  `https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search`
  - `q=dアニメストア` / `targets=tagsExact` で支店コンテンツ取得
  - 取得フィールド: `contentId` / `title` / `viewCounter` / `tags` / `genre` / `startTime` / `thumbnailUrl` など
  - 支店絞り込み: `channelId == 2632720`（取得のみ可・filter 不可 → クライアント側）
- 補助:
  - `site.nicovideo.jp/danime/static/data/list.json`（全作品）
  - `site.nicovideo.jp/danime/static/data/programlist.json`（今季）
  - `anime.nicovideo.jp/period/<年>-<季>-danime.html`（クール・過去季）

**構成方針**: ローカル/CI の fetch スクリプトで静的 JSON 化 → 静的サイトが読む。
急上昇は `viewCounter` の日次スナップショット差分（phase2）。

**v1 スコープ**: 全作品ブラウズ ＋ 再生数ランキング ＋ ジャンル ＋ クール ＋ deep-link。
**phase2**: 個人化（視聴履歴）、急上昇。

**レイヤー構成**

| パス | 役割 |
|------|------|
| `scripts/` | データ取得（API → `data/*.json`） |
| `data/` | 静的 JSON 出力（生成物・git 管理外） |
| `web/` | 静的フロント（`data/*.json` を読む） |
| `docs/` | 仕様（Tri-SSD: L0 要求 / L1 要件 / L2 構成 / L3 フェーズ） |
| `.claude/skills/` | プロジェクト用 Agent Skill（nico snapshot API リファレンス＆ヘルパ） |

## 完了前チェック

変更を「完了」とする前に確認する:

1. **取得/表示の分離**を破っていないか（ブラウザから直 API なし）。
2. **支店フィルタ**（`channelId === 2632720`）が効いているか。本店データの混入なし。
3. **API マナー**: User-Agent を付与しているか／過剰アクセス・並列過多になっていないか。
4. **生成物**（`data/*.json`）を誤ってコミットしていないか。
5. 関連する `npm run` コマンドが通るか（実装済みのもの）。
6. スコープ（v1 / phase2）を逸脱した実装を混ぜていないか。
7. `docs/` の対応する仕様（受け入れ条件）を満たしているか。

## ワークフロー

仕様駆動（Tri-SSD プラグイン）で進める。**L0 → L1 → L2 → L3 → gen-code** の順。docs 構造は初期化済み。

0. **L0 要求**（`docs/l0_ideas/requirement.md`）— 背景・欲求・判断基準の大元。すべての設計判断はここに照らす。**北極星: 「最小驚きの原則 ＋ ユーザー主権」**（アテンション経済の逆を行く道具）。
1. `/gen-l1` — L1 要件（`docs/l1_requirements/vision.md`）。L0 を踏まえて作成。
2. `/gen-l2` — L2 システム構成（`docs/l2_foundation/foundation.md`）。技術スタックはここで確定。
3. `/gen-l3` — L3 フェーズ（機能 + 受け入れ条件、`docs/l3_phases/PH-xxxx.md`）。
4. `/gen-code <PH-xxxx>` — フェーズ単位でコード／テストを生成。**実装フェーズは opusplan で進める**（plan=Opus で設計 → execute=Sonnet で実装の自動切替。`.claude/settings.json` で既定化済み）。
5. 完了したら `/archive-l3 <PH-xxxx>` でアーカイブ。

**着手前**: `docs/l0_ideas/` の要求と関連する L1〜L3 を読み、判断に迷ったら L0 の北極星に照らす。
**データ取得時**: `.claude/skills/` の nico snapshot API スキルを参照（支店の取り方・補助源・ToS・CORS）。
