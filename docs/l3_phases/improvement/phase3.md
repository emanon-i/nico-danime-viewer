# Phase 3: 中長期の改善（スケールと開発体験）

前提: Phase 1〜2 完了。ここは「実測してから」「必要になってから」の項目を含む。着手前に各項目の前提（実害の有無）を再確認すること。

## 1. データ契約の機械化（C9）

**問題**: `web/src/data/types.ts` が「データ契約の正本」を名乗るが、生成側（`scripts/store/project.mjs` ほか）は型なし `.mjs` で、契約は手動同期。loader のガードはトップレベルのみ（`loader.ts:17-20`、Work 要素は未検証）。スキーマ変更のドリフトは実行時の undefined 伝播で発覚する。

**変更方針**（段階的・依存追加は最小限に）:

1. まず**生成側の書き出し直前バリデーション**: `scripts/lib/validate.mjs` に works/ranking/tags/... の軽量チェッカー（必須キー・型・値域）を実装し、`writeJson` 前に通す。壊れた JSON を「配信する前に」落とす — フロントに zod 等を入れるより費用対効果が高い
2. 次に types.ts との同期を機械化: types.ts から JSON Schema を生成（`typescript-json-schema` 等・devDependency のみ）して 1 のチェッカーがそれを読む、または ops-health の structure ティアに深い検証を追加
3. フロント側 loader の要素検証は「先頭 N 件のサンプル検証」程度に留める（18MB 全件検証はコスト過大）

**受け入れ条件**: 生成側で必須キー欠落を注入すると fetch が書き出し前に FAIL。types.ts と実 JSON の乖離が CI で検出される。

## 2. web 状態モデルの統一 → render 分割（C10）

**問題**: 同種の UI 状態が 3 方式に分散 — fav フィルタ=URL（`main.ts:388`）、want/watched/showEmpty=モジュールグローバル `let`（`main.ts:69-73`、リロードで消える）、テーマ等=localStorage。さらに `renderList`（`list.ts:313-899`、約 590 行）と `main.ts render()`（`:359-685`、約 330 行）が god 関数化。

**変更方針**（順序が重要 — 状態統一が先、分割が後）:

1. want/watched/showEmpty フィルタを URL パラメータ化して fav と同じ扱いに（`router.ts` の `ListState` に追加、`LIST_PARAMS` 更新）。リロード/共有で同じ結果=L0 の「予測どおりに動く」に合致
2. その後 `renderList` を「検索バー」「フィルタパネル」「グリッド+ページネーション」の 3 関数程度に分割、`main.ts` から `buildTopData`/`cardMetric` 等の view-model 計算を `features/` へ移動。**フレームワーク導入はしない**（vanilla 方針を尊重）
3. URL パラメータ追加は既存 URL と後方互換に（未指定=現行既定値）

**受け入れ条件**: フィルタ適用→リロードで全フィルタが復元される。既存の router/filter/e2e テスト緑 + ListState 追加分のテスト。tests/web/coverage.test.ts の REQ マップに影響がないこと。

## 3. 性能改善（C11）— 実測してから

**問題（候補）**:

- ETL: `_getEpisodesForSeriesSorted`（`store.mjs:1075-1081`）がシリーズ毎に全エピソード走査。`deriveSeriesOverviewsFromStore`・`deriveCoursFromTagsFromStore` も同型 → O(series×episodes)、約 6,700 シリーズで二次コスト
- フロント: 毎 render で全配列 clone-sort（`filter.ts:175-248` の 9 箇所）+ 全 DOM 再構築（`main.ts:364`）。現状はページサイズ 50〜200 が守っている

**変更方針**:

1. ETL: run 冒頭で `seriesId → episodes[]` インデックスを 1 回構築し、各 derive 関数に渡す（daily の wall-clock を実測してから。ネットワーク律速なら優先度を下げる）
2. フロント: filter/sort 結果を `(state, データ世代)` キーでメモ化。キーストローク毎の全 sort を解消
3. 仮想化・diff レンダリングは**やらない**（ページネーションで足りている間は複雑さに見合わない）

**受け入れ条件**: 変更前後で出力 JSON/表示が不変。daily の Node 実行時間 or 一覧操作の体感が計測可能に改善（`console.time` レベルの簡易計測で可）。

## 4. works.json 18MB の git/配信戦略（C12）

**問題**: works.json（約 18MB）+ tags.json（約 2.8MB）が main にコミットされ、`data:` 再生成コミットのたびに履歴が肥大。フロントは初回に 18MB を全量 fetch。

**変更方針**（運用変更を含むため慎重に・順に検討）:

1. まず main への `data:` 再生成コミットを停止できるか検討: 公開 JSON も state ブランチへ移し（series/ と同方式）、deploy-pages は state から復元する。main には最小シード（開発用の小さな fixture）だけ残す — `vite.config.ts` の data ミドルウェアと `tests` のフィクスチャパスへの影響を確認
2. 配信サイズは分割で対応: works.json を「一覧に必要な軽量フィールド」と「詳細系（descriptionFirst/credits 等）」に分割し、後者は遅延ロード。`loader.ts`/`types.ts` の契約変更を伴うため Phase 3 の 1（契約の機械化）の後に
3. Git LFS は Pages/Actions との相性とコストを確認してから（第一候補ではない）

**受け入れ条件**: main の新規 `data:` コミットが止まる。初回表示に必要な転送量が減る（計測値を PR に記載）。既存 URL・deep-link は不変。

## 5. カバレッジ計測とテスト空白の解消（C14）

**問題**: 実カバレッジ計測なし（`docs/coverage.json` は REQ traceability map で別物=名前が紛らわしい）。テスト空白: `web/src/features/shared/version-check.ts`（更新バナー）、`scripts/ops-health.mjs`（CI のアラーム本体・Phase 1-2 で一部解消）、`scripts/store/credit-index.mjs`、`scripts/fetch.mjs` オーケストレーション。

**変更方針**: `@vitest/coverage-v8` を devDependency 追加、`test:coverage` script 新設（CI では任意 job・閾値ゲートはまだ設けない）。計測結果を見て空白上位から `version-check` → `credit-index` の順にテスト追加。`docs/coverage.json` は `docs/req-coverage.json` 等へのリネームを検討（`tests/web/coverage.test.ts` の参照も同時更新）。

**受け入れ条件**: `pnpm test:coverage` がレポートを出す。空白 2 モジュールにテストが付く。

## 6. タグ品質と credits の持続可能化（C16 + credits）

**問題**:

- `isTitleTag`（`etl/tags.mjs:70-78`）の前方一致ルール（タグ 4 文字以上でタイトルが前方一致→除外）により、フランチャイズ名タグが「タイトルがそれで始まるシリーズからだけ」抜ける非対称（README §6 調査結果②）。フランチャイズ横断のタグ検索で取り逃しが起き得る
- `etl/credits.mjs`（857 行の正規表現パイプライン）はコミット履歴上、最も修正が反復している領域。export が 2 関数のみで内部 800 行が E2E 経由でしかテストできない

**変更方針**:

1. isTitleTag: 「複数シリーズ（例: 2 作品以上）に付いているタグは作品名タグとみなさない」等の頻度条件を追加して、フランチャイズ名を除外対象から救う。タグ増減が起きるため、変更前後の tags.json diff を PR に添付して判断
2. credits: 内部関数（`parseBlock`/`entryToTags`/`splitPeople`/`mineCopyright`）を export（または `credits/` ディレクトリに分割）し、実データから採ったゴールデンフィクスチャで回帰テスト化。以後の「残 N 件根治」系修正が回帰なしで行えるようにする

**受け入れ条件**: フランチャイズ名タグの非対称が解消したことをフィクスチャで確認（例: タイトル前方一致でも複数作品共有タグは残る）。credits の内部関数に単体テストが付き、既存のゴールデン出力が不変。
