# Phase 2: 設計上の整理（変更コストの構造的削減）

前提: Phase 1 の CI ゲート（ci.yml）がマージ済みであること。ここからはリファクタが含まれるため、テストが常時ゲートすることが安全条件。

## 1. `scripts/config.mjs` 新設 — 設定/定数の一元化（C5）

**問題**: 支店チャンネル ID が 3 形態で分散 — 数値 `2632720`（`nico/filter.mjs:4`、`nico/assert.mjs:54`）/ 文字列 `'ch2632720'`（`nico/nvapi.mjs:14`）/ RSS URL 直書き（`nico/rss.mjs:7`）。さらに URL（`snapshot.mjs:8-9`、`list.mjs:6-11`）、閾値（shrink 0.9 `fetch.mjs:69`、グレース 2〜3 日 `fetch.mjs:103-104`、RSS trim 200 `fetch.mjs:320`、snapshot FIRST_YEAR/LIMIT/MAX_OFFSET `snapshot.mjs:14-18`、metrics 重み `metrics.mjs:6`、ranking slice/tier `project.mjs:171-183`）、ops-health の実測フロア（`ops-health.mjs:34-56`）が 10 ファイル超に散在。

**変更方針**: `scripts/config.mjs` を新設し、`BRANCH_CHANNEL_ID = 2632720` から `BRANCH_CHANNEL = `ch${BRANCH_CHANNEL_ID}`` を導出して単一ソース化。エンドポイント URL・閾値・フロアを名前付き export で集約（フロアには「実測ベース・データ増で要見直し」と注記）。各モジュールは config を import するだけの機械的置換。**値は一切変えない**。

**受け入れ条件**:

- [ ] `git grep -n '2632720'` のヒットが `config.mjs`（とテスト・docs）のみ
- [ ] 既存テスト全緑・`pnpm fetch --check-version` 等の smoke が通る

**検証方法**: `pnpm test` + `node scripts/fetch.mjs --check-version`（ネットワーク可の環境で）。

## 2. 集計 reducer の一本化（C6）

**問題**: エピソード→シリーズ集計（totalViews/commentTotal/mylistTotal/durationTotal/latestAt/firstAt/so 番号タイブレーク）が `buildEpAggMap`（`project.mjs:44-93`）と `exportWorksPartial` 内（`project.mjs:352-392`）に二重実装。`project.mjs:79-80` に「毎時の exportWorksPartial と同一定義（日次/毎時パリティ）」と手動同期を要求するコメントがある=次に集計仕様を触った時にドリフトする構造。

**変更方針**: 集計本体を「1 エピソードを集計オブジェクトに畳み込む純関数」（例 `foldEpisodeIntoAgg(agg, ep)`）として抽出し、`buildEpAggMap`（全件）と `exportWorksPartial`（対象 seriesIds 限定 + count 付き）の両方がそれを呼ぶ。出力 JSON は不変。

**対象ファイル**: `scripts/store/project.mjs`、`tests/store/project.test.mjs`（「full と partial が同一入力で同一集計を返す」パリティテストを追加）。

**受け入れ条件**:

- [ ] 同一フィクスチャに対する exportWorks / exportWorksPartial の該当フィールドが完全一致するテスト
- [ ] 実データで再生成した works.json が変更前後で diff なし（`scripts/reproject.mjs` を利用）

## 3. 永続化のトランザクション化（C4）

**問題**: 個々のファイル書き込みは tmp+rename で原子的（`store.mjs:409-413`）だが、書き込み全体は多段 — `writeBackStore`（series → prev-views → meta → rss → series-index、`store.mjs:360-398`）→ `projectAll`（`fetch.mjs:704-705`）。途中クラッシュで prev-views だけ進み、翌 run は新しい基準で delta を計算=**その日の delta が恒久喪失**。provisional の `unlinkSync`（`fetch.mjs:311,553`）も Store 永続化前にディスクを変更する。`store.mjs:329-333` に一括コミットの意図がコメントされているが未実装。

**変更方針**: ステージング方式。`data/.staging/` に series/state/公開 JSON をすべて書き切ってから、最後にディレクトリ単位 or ファイル一括の rename で本番パスへ swap（同一 FS 内 rename は原子的）。provisional の削除も swap 時に反映。CI（Actions）ではクラッシュ→ジョブ失敗→state ブランチ push なし、が既にセーフティネットなので、この変更の主眼は**ローカル実行と「push はされたが途中状態」の排除**。

**対象ファイル**: `scripts/store/store.mjs`（writeBackStore）、`scripts/store/project.mjs`（writeJson の出力先）、`scripts/fetch.mjs`（呼び出し順・unlink の移動）。

**受け入れ条件**:

- [ ] writeBackStore と projectAll の間に人為的に throw を入れても、data/ 配下が「全部旧」か「全部新」のどちらかである（テスト or 手動確認手順を docs 化）
- [ ] 既存テスト全緑・生成 JSON の内容は不変

**破壊リスク**: 低（出力内容は同じ・書き込み手順のみ変更）。ただし workflows の rsync 対象パスに `.staging/` が混ざらないよう `.gitignore`/rsync exclude を確認。

## 4. 神モジュールの分割 — テスト圏外ロジックの救出（C8）

**問題**: 重要アルゴリズムが I/O スクリプトに埋め込まれ未 export=単体テスト不能。

- `store.mjs:944-1055`: 漢字/全角数字対応の話数パーサ（約 110 行）が store に同居
- `fetch.mjs:175-318` `rescueMissingEps` / `fetch.mjs:480-562` B6 provisional 再照合 / `fetch.mjs:938-989` `backfillNullEpisodeNos`

**変更方針**（移動のみ・挙動不変）:

1. 話数パーサ → `scripts/etl/episode-order.mjs` へ移動・export（store.mjs は import）。`tests/etl/episode-order.test.mjs` 追加
2. rescue/reconciliation → `scripts/etl/reconcile.mjs` へ移動。ネットワーク呼び出し（`fetchSeriesData`）は引数注入（既存の `_http` シームと同じ流儀）にして単体テスト可能に
3. あわせて `stripHtml` を `etl/series.mjs` から `scripts/lib/text.mjs` へ移し、store→etl の逆依存を解消

**受け入れ条件**: 既存テスト全緑 + 新規テスト（話数パーサの既知ケース・rescue の分岐）。`fetch.mjs` が 700 行程度まで縮む。

## 5. HTTP リトライ一般化 + snapshot 窓単位の失敗許容（C7）

**問題**: リトライは 503 のみ（`lib/http.mjs:42-51`）。429/5xx/ネットワークリセットは即 throw。snapshot は年窓ループ（`nico/snapshot.mjs:109-118`）内の 1 窓失敗で日次全体が中断（150 分 run が無駄になる）。

**変更方針**:

1. `politeFetch` に汎用リトライ: 429/500/502/504 とネットワークエラーを指数バックオフで最大 2〜3 回（503 の既存 5 分バックオフは維持）。`AbortController` タイムアウトも付与（ops-health の 25s を参考に長め）
2. `fetchAllBranchEpisodes` に窓単位の許容: 1 窓失敗は警告ログ+スキップで継続し、失敗窓数を返す。呼び出し側（`fetch.mjs`）で「失敗窓 ≥2 なら run を FAIL、1 なら継続（shrink guard が下流で守る）」
3. API マナー維持: リトライ間隔は適応ディレイ以上・並列化はしない

**受け入れ条件**: `tests/nico/http.test.mjs` にリトライ系テスト追加（fake fetch・fake timer）。窓失敗注入テストで「1 窓失敗でも他窓の結果が保存される」こと。

**検証方法**: `pnpm test`。マージ後、daily の workflow 履歴で一過性エラー起因の失敗が消えることを観察。
