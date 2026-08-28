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

## 4. scripts の型検査導入（C20）

**問題**: `tsconfig.json` の include は `web/src/**/*.ts`・vite/vitest config・`tests/**/*.ts` のみで、**`scripts/`（約 5,600 行）は `pnpm typecheck` の完全な圏外**（`checkJs`/`allowJs` なし）。`store.mjs` の丁寧な JSDoc `@typedef` 群（`store.mjs:21-88`）は何にも検査されていない装飾。最も複雑で最もテストが薄い層に型検査もない。eslint も `tseslint.configs.recommended`（type-checked なし）。

**対象ファイル**: `tsconfig.json`（または scripts 用の `tsconfig.scripts.json` を新設して `typecheck` script に追加）、段階的に `scripts/**/*.mjs`、`eslint.config.js`。

**変更方針**（段階導入・一気にやらない）:

1. `tsconfig.scripts.json` を新設: `allowJs: true, checkJs: true, noEmit: true`、include を **小さく確実なモジュールから**（`scripts/lib/`, `scripts/etl/tags.mjs`, `scripts/etl/metrics.mjs` 等）開始。`pnpm typecheck` を `tsc -p . && tsc -p tsconfig.scripts.json` に
2. エラーを解消しながら include を `nico/` → `store/` → `fetch.mjs` へ拡大（各拡大が 1 PR）。既存 JSDoc が資産なので想定コストは中程度
3. 最後に eslint を `recommended-type-checked` へ引き上げ（`no-floating-promises` 等が有効化）

**受け入れ条件**: 各段階で `pnpm typecheck` 緑・CI（Phase 1 の ci.yml）でゲート。JSDoc の嘘（実装と型注釈の乖離）が検出・修正されること自体が成果。

**検証方法**: `pnpm typecheck`。段階拡大ごとに検出された型齟齬を PR 説明に列挙。

## 5. 射影ソートの決定性ローカル化（C23）

**問題**: 「決定的ビルド」は `store.mjs:134` のファイル名ソート（ロード順固定）という**大域不変量に暗黙依存**している。`tags.json`（`project.mjs:206` seriesCount のみ）・`hotTop20/popularTop20`（`:211-224` スコアのみ）・`topTagsFrom`（`:234` カウントのみ）・`new.json`（`:300` pubDate のみ）のソートに明示タイブレークがなく、同点は Store 挿入順で決まる。ロード方式（並列化・Map 再構成）を変えた瞬間に出力が揺れる。

**対象ファイル**: `scripts/store/project.mjs`、`tests/store/project.test.mjs`。

**変更方針**: 各ソートに第 2 キーを明示追加 — tags は `(seriesCount DESC, name ASC)`、hot/popular Top20 は `(score DESC, seriesId ASC)`、topTagsFrom は `(count DESC, name ASC)`、new は `(pubDate DESC, watchId DESC)`。**現在のロード順で生成される出力と diff ゼロになるキーを選ぶ**（挙動不変の保証）。

**受け入れ条件**:

- [ ] `scripts/reproject.mjs` で変更前後の全公開 JSON が diff ゼロ
- [ ] 同点データを逆順投入しても出力が一致するテスト（挿入順シャッフル）

## 6. provisional ID の衝突検知（C24）

**問題**: `provisionalSeriesId`（`list.mjs:284-288`）は 32bit djb2 変種で衝突検知なし。衝突すると**別作品のエピソードが同一負 ID に混線**（検出不能な静かな破損）。現状 ~2,000 タイトルで確率 ~0.05% だが件数の二乗で増加。

**対象ファイル**: `scripts/nico/list.mjs`（または provisional 登録箇所 `fetch.mjs:140-173`）、`tests/nico/list.test.mjs`。

**変更方針**: provisional 登録時に「その負 ID が既に**別タイトル**に割当済みか」を series-index/store で確認。衝突時は salt 付き再ハッシュ（`title + '\0' + n`）で空きを探し、`logger.warn` で記録。既存データは触らない（発生していない前提・発生済みなら daily の再照合で顕在化する）。

**受け入れ条件**: 人工的に衝突する 2 タイトルのフィクスチャで別 ID が割り当てられ warn が出るテスト。

## 7. 神モジュールの分割 — テスト圏外ロジックの救出（C8）

**問題**: 重要アルゴリズムが I/O スクリプトに埋め込まれ未 export=単体テスト不能。

- `store.mjs:944-1055`: 漢字/全角数字対応の話数パーサ（約 110 行）が store に同居
- `fetch.mjs:175-318` `rescueMissingEps` / `fetch.mjs:480-562` B6 provisional 再照合 / `fetch.mjs:938-989` `backfillNullEpisodeNos`

**変更方針**（移動のみ・挙動不変）:

1. 話数パーサ → `scripts/etl/episode-order.mjs` へ移動・export（store.mjs は import）。`tests/etl/episode-order.test.mjs` 追加
2. rescue/reconciliation → `scripts/etl/reconcile.mjs` へ移動。ネットワーク呼び出し（`fetchSeriesData`）は引数注入（既存の `_http` シームと同じ流儀）にして単体テスト可能に
3. あわせて `stripHtml` を `etl/series.mjs` から `scripts/lib/text.mjs` へ移し、store→etl の逆依存を解消
4. **hourly の partial 二重ロード＋ミューテーションマージの整理**（第2回レビュー）: `runHourlyJS` は `loadPartialStore` を 2 回呼び（`fetch.mjs:724,822`）、D2 の RSS 由来 description が D3 の再ロードで潰されるため `rssDescriptions` 退避のワークアラウンドが入っている（`fetch.mjs:788-789,869-877`）— run 内の順序ハザード。ロードを 1 回に統合するか「ロード完了後にのみ Store を書く」順序に整理
5. **「シリーズ先頭話探索」ロジックの一本化**: 同じ「シリーズの最古エピソードを探す」導出が `store.mjs`（`_getEpisodesForSeriesSorted`）・`etl/series.mjs`・`etl/cours.mjs`・`store/credit-index.mjs:19-32` の **4 箇所**に重複。共通ヘルパ（または C11 の seriesId→episodes インデックス）に集約

**受け入れ条件**: 既存テスト全緑 + 新規テスト（話数パーサの既知ケース・rescue の分岐）。`fetch.mjs` が 700 行程度まで縮む。

## 8. HTTP リトライ一般化 + snapshot 窓単位の失敗許容（C7）

**問題**: リトライは 503 のみ（`lib/http.mjs:42-51`）。429/5xx/ネットワークリセットは即 throw。snapshot は年窓ループ（`nico/snapshot.mjs:109-118`）内の 1 窓失敗で日次全体が中断（150 分 run が無駄になる）。

**変更方針**:

1. `politeFetch` に汎用リトライ: 429/500/502/504 とネットワークエラーを指数バックオフで最大 2〜3 回（503 の既存 5 分バックオフは維持）。`AbortController` タイムアウトも付与（ops-health の 25s を参考に長め）
2. `fetchAllBranchEpisodes` に窓単位の許容: 1 窓失敗は警告ログ+スキップで継続し、失敗窓数を返す。呼び出し側（`fetch.mjs`）で「失敗窓 ≥2 なら run を FAIL、1 なら継続（shrink guard が下流で守る）」
3. API マナー維持: リトライ間隔は適応ディレイ以上・並列化はしない

**受け入れ条件**: `tests/nico/http.test.mjs` にリトライ系テスト追加（fake fetch・fake timer）。窓失敗注入テストで「1 窓失敗でも他窓の結果が保存される」こと。

**検証方法**: `pnpm test`。マージ後、daily の workflow 履歴で一過性エラー起因の失敗が消えることを観察。
