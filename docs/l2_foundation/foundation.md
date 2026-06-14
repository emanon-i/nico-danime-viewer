# dアニメストア ニコニコ支店ビューア システム構成（L2）

> L1（`docs/l1_requirements/vision.md`）を踏まえた**アーキテクチャ／技術スタック／全体概要／基本設計**。
> 詳細設計・コードは書かない（L3 / gen-code で扱う）。
> **§6 にニコニコ API の実証結果（データ可用性の裏付け）を記載**。L2 は「絵に描いた餅」にしないため、
> 想定データが実際に取れることを確認したうえで確定している。

## 1. 技術スタック

非サーバ・静的サイト前提。北極星（予測どおり・軽量・ユーザー主権）に沿い、**最小構成**を選ぶ。

### 1.1 フロントエンド

- **Vite + TypeScript（バニラ、UI フレームワークなし）**
- 選定理由: 静的サイトとして GitHub Pages にそのまま載る。React 等の重い実行時を持たず軽量・高速。
  作品一覧／ランキング／タグ・ジャンル・クールのフィルタ程度に大型フレームワークは過剰（over-engineering 回避）。
  TypeScript で `data/*.json` のスキーマを型として固定し、予測どおりの挙動を担保する。
- **却下案**: React/Next.js → 個人・静的・低複雑度には過剰。Astro → 候補だが当面 Vite で十分（将来再検討可）。

### 1.2 バックエンド

- **専用バックエンドを持たない。** データ取得は Node.js（ESM, `.mjs`）の **fetch スクリプト**（`scripts/`）に集約。
- 選定理由: CORS と ToS（低頻度）の両面から、ブラウザ直 API は不可。取得を「ビルド/CI 時の前処理」に寄せ、
  実行時はただ静的 JSON を読むだけにする。Node 20+ のネイティブ `fetch` を使い依存を最小化。

### 1.3 データストア

- **静的 JSON ファイル（`data/*.json`）がデータ層。** RDB/KVS は持たない。
- 急上昇（phase2）用の日次スナップショットのみ `data/snapshots/`（git 管理外）に蓄積。
- 選定理由: 読み取り専用・小規模・再配布しない方針に、DB は不要。生成物はコミットせず再生成可能にする。

### 1.4 インフラ / デプロイ

- **GitHub Pages（配信）＋ GitHub Actions（定期 fetch & ビルド）**
- 選定理由: 無料・静的・個人運用に最適。Actions で `npm run fetch`（UA 付き・低頻度）→ ビルド → Pages 公開を定期化。
- **却下案**: 自前サーバ/VPS → 常時稼働コストと運用負荷が見合わない。

## 2. アーキテクチャ

### 2.1 設計方針

- 採用パターン: **2 ステージ・パイプライン（Fetch/ETL → 静的 JSON）＋ データ駆動の静的フロント**。
  ドメイン（ranking / genre / tag / cours / series）単位で機能を分け、データアクセスは型付き JSON ローダ 1 箇所に集約。
- 選定理由: 「取得」と「表示」を物理的に分離（CORS・ToS・テスト容易性）。フロントは副作用が JSON 読み込みに限定され、
  予測可能・単体検証可能。外部依存（ニコニコ API）はスクリプト層に閉じ込め、フロントから隠蔽する（境界の明確化）。
- ファイル粒度: ドメイン単位でまとめる。インターフェース化は「外部依存の差し替えが要る箇所（= API クライアント）」のみ。
  単純な一覧・整形に UseCase 層やマッパーを増やさない（過剰分割の回避）。

### 2.2 コンポーネント構成図

```
        [ニコニコ snapshot 検索API]   [補助: list.json / programlist.json / period HTML]
                     │  (UA必須・低頻度)        │
                     ▼                          ▼
        ┌───────────────────────────────────────────────┐
        │  scripts/  (Node ESM, ビルド/CI 時に実行)        │
        │   fetch → 支店フィルタ(channelId==2632720)       │
        │        → 正規化/結合(series, cours, tag, genre)  │
        │        → 静的JSON書き出し                         │
        └───────────────────────────────────────────────┘
                     │ 生成（git管理外）
                     ▼
        data/*.json  (works / ranking / genres / tags / cours / series)
                     │ 静的読み込み（実行時の唯一の入力）
                     ▼
        ┌───────────────────────────────────────────────┐
        │  web/  (Vite + TS 静的サイト)                    │
        │   JSONローダ → ranking / genre / tag / cours /   │
        │               series ビュー → 公式へ deep-link   │
        └───────────────────────────────────────────────┘
                     │
                     ▼  視聴は公式プレイヤー (nicovideo.jp/watch|series/<id>)
```

### 2.3 ディレクトリ構成（基本）

```
scripts/                 # データ取得・ETL（Node ESM）
  fetch.mjs              #   エントリ（snapshot + 補助源 → data/*.json）
  nico/                  #   API クライアント / 支店フィルタ / 正規化（差し替え可能な外部依存）
data/                    # 静的JSON出力（生成物・git管理外）
  snapshots/            #   日次viewCounter（phase2・git管理外）
web/                     # 静的フロント（Vite + TS）
  src/
    data/               #   型付きJSONローダ（data/*.json を読む唯一の窓口）
    features/           #   ranking / genre / tag / cours / series（ドメイン単位）
    shared/             #   横断（整形・deep-link生成など最小限）
docs/                    # Tri-SSD: L0/L1/L2/L3
```

## 3. 非機能要求

- **北極星の担保**: ランキング・並び順・フィルタは決定的（同入力→同出力）。隠れた重み付け・自動再生を実装しない。
- **API マナー**: UA 必須・リクエスト間隔を空ける・全件取得はページング/期間ウィンドウで分割（§6）。取得はスクリプト層のみ。
- **パフォーマンス**: 実行時は静的 JSON 読み込みのみ。約8.7万件（各話）規模のため、フロントは
  **用途別に分割・軽量化した JSON**（例: ランキング上位、シリーズ集約）を読む。<!-- TODO: 分割粒度はL3で確定 -->
- **データ鮮度**: 索引は毎日 AM5:00 更新 → fetch は日次で十分（高頻度化しない）。

## 4. 用語集

| 用語 | 定義 |
|------|------|
| 支店 | dアニメストア ニコニコ支店（`channelId == 2632720`）。本店(docomo)とは別サービス |
| 各話 | snapshot API が返す単位。1 動画 = 1 エピソード（`contentId` は `so…`） |
| シリーズ | 作品単位。補助源の `series` id（`nicovideo.jp/series/<id>`）で束ねる |
| クール | 放送季（winter/spring/summer/autumn）。period ページ／`startTime` で区切る |

## 5. テスト・検証戦略

### 5.1 テストフレームワーク

| 種別 | ツール | コマンド |
|------|--------|---------|
| ユニット | Vitest | `npm test` |
| Lint | ESLint | `npm run lint` |
| 型チェック | tsc (`--noEmit`) | `npm run typecheck` |
| ビルド | Vite | `npm run build` |
| データ取得 | Node スクリプト | `npm run fetch` |

### 5.2 実装後の自己検証手段

| 検証対象 | コマンド/手順 | 期待結果 |
|---------|-------------|---------|
| 取得スクリプト | `npm run fetch` | `data/*.json` 生成。`channelId!=2632720` が 0 件 |
| データ整形ロジック | `npm test` | 全テストパス（支店フィルタ・整形の単体） |
| 型/Lint | `npm run typecheck && npm run lint` | エラー 0 |
| ビルド | `npm run build` | 正常終了（`dist/` 生成） |
| 表示確認 | `npm run dev` で目視 | ランキング/タグ/ジャンル/クールが予測どおり並ぶ |

### 5.3 検証で使えるツール

- `curl` / `Invoke-RestMethod`（API 実疎通）、Vitest（ロジック）、Playwright（E2E。導入は phase2 で検討）。

## 6. データ可用性の裏付け（結論サマリ）

> 2026-06-15 に snapshot 検索 API・補助源へ **UA 付き・低頻度**で実アクセスし、設計が依存するデータが実際に取れることを確認済み。
> **実クエリ・レスポンス例・件数・フィールド確認の詳細根拠は `validation/api-availability.md` を参照**（本体を膨らませないため分離）。

### 6.1 結論（想定どおり作れそうか）

- **v1 スコープ（全作品ブラウズ・再生数ランキング・タグ/ジャンル・クール・deep-link）は実データで取得可能＝実現可能。**
  支店規模 `totalCount=87,327`、`channelId==2632720` のクライアント側絞り込み、`viewCounter`/`startTime`/`tags` 等の取得、
  `_sort` と `filters[startTime]` の動作、補助源（list.json 6,698 件 / programlist.json 75 件）をいずれも実証。
- **設計に織り込む前提（実証で判明）**:
  1. **`channelId` は filter 不可** → 取得後クライアント側で `==2632720` 絞り込み。
  2. **`startTime` filter は TZ 必須**（`+09:00` 無しは HTTP 400）。全件取得の期間ウィンドウ分割もこれで行う。
  3. **`genre` が粗い（実測は一律「アニメ」）** → ジャンル/近ジャンル(REQ-0003)・リコメンド(REQ-0009)は **`tags`/`categoryTags` 主軸**。
  4. `programlist.json` の画像キーは **`imgpagh`**（綴り注意）。
- **phase2（急上昇・個人化）は API 単独では不可** → `viewCounter` 日次差分の自前蓄積／ローカルファースト連携が前提。L1 の優先度と整合。

詳細根拠: [`validation/api-availability.md`](validation/api-availability.md)
