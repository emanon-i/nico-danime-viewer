# Phase 3: 中長期の改善（スケールと開発体験）

前提: Phase 1〜2 完了。ここは「実測してから」「必要になってから」の項目を含む。着手前に各項目の前提（実害の有無）を再確認すること。

> 例外: 項目 1（credits ゴールデンコーパス）は「残N件根治」修正が現に反復しているため、Phase 3 の中で最優先。credits を次に触る前に着手する価値がある。

## 1. credits ゴールデンコーパスと段階分解（C26）★Phase 3 の先頭

**問題**: `etl/credits.mjs`（857 行）の「残N件根治」修正が構造的に再発する。根本原因（第2回レビューで特定）:

- `entryToTags`（`credits.mjs:564-646`）は**順序非可換な 17 段の文字列変換パイプライン**。コード自身が「順序が重要」（`:641`）「分割の前に」（`:567,616`）と明記しており、新しいエッジケースは段の挿入/並べ替えでしか直せず、過去に直したケースを壊すリスクが常にある
- `JOINED_NAME_DENYLIST`（`:208`、`fripSide`/`ClariS` 等の実在文字列）や「漢字 4 文字以上」（`:422`）などの**フィットされた魔法定数**が原則ではなく個別対処として蓄積
- **ゴールデンコーパスが皆無**: `tests/` に fixture JSON が 1 つもなく、`credits.test.mjs`（447 行）は手書きインライン断言のみ。修正が過去ケースを回帰させていないことを証明する held-out セットが存在しない

**対象ファイル**: `scripts/etl/credits.mjs`（分割）、`tests/etl/fixtures/credits-corpus.json`（新規）、`tests/etl/credits-golden.test.mjs`（新規）。

**変更方針**（順序が重要 — コーパスが先、分解が後）:

1. **先にゴールデンコーパスを固定**: state ブランチの実データから first-episode description を数百件サンプリングし、「入力 description → 現行 extractCredits の出力」を fixture JSON にスナップショット。以後のすべての credits 変更はこの diff をレビューする運用に（決定性は既に担保されているためスナップショットは安定）
2. その後 `entryToTags`/`cleanDisplay` を名前付き純関数の段（tokenize → strip-annotations → split-people → normalize → classify）に分解し、段ごとの単体テストを付ける。挙動はコーパス diff ゼロを保って移行
3. `credit-index.mjs` の未テスト export 3 つ（`buildCreditIndex`/`seriesCredits`/`worksCreditKeys`）にもテスト追加

**受け入れ条件**: コーパス fixture がコミットされ、credits 変更 PR で golden diff が自動表示される（テスト失敗=意図しない回帰）。段分解後もコーパス出力が不変。

## 2. データ契約の機械化（C9）

**問題**: `web/src/data/types.ts` が「データ契約の正本」を名乗るが、生成側（`scripts/store/project.mjs` ほか）は型なし `.mjs` で、契約は手動同期。loader のガードはトップレベルのみ（`loader.ts:17-20`、Work 要素は未検証）。スキーマ変更のドリフトは実行時の undefined 伝播で発覚する。

**変更方針**（段階的・依存追加は最小限に）:

1. まず**生成側の書き出し直前バリデーション**: `scripts/lib/validate.mjs` に works/ranking/tags/... の軽量チェッカー（必須キー・型・値域）を実装し、`writeJson` 前に通す。壊れた JSON を「配信する前に」落とす — フロントに zod 等を入れるより費用対効果が高い
2. 次に types.ts との同期を機械化: types.ts から JSON Schema を生成（`typescript-json-schema` 等・devDependency のみ）して 1 のチェッカーがそれを読む、または ops-health の structure ティアに深い検証を追加
3. フロント側 loader の要素検証は「先頭 N 件のサンプル検証」程度に留める（18MB 全件検証はコスト過大）

**受け入れ条件**: 生成側で必須キー欠落を注入すると fetch が書き出し前に FAIL。types.ts と実 JSON の乖離が CI で検出される。

## 3. web 状態モデルの統一 → render 分割（C10 + C19）

**問題**: 同種の UI 状態が 3 方式に分散 — fav フィルタ=URL（`main.ts:388`）、want/watched/showEmpty=モジュールグローバル `let`（`main.ts:69-73`、リロードで消える）、テーマ等=localStorage。さらに `renderList`（`list.ts:313-899`、約 590 行）と `main.ts render()`（`:359-685`、約 330 行）が god 関数化。加えて**スクロール管理が存在しない**（C19）: `history.scrollRestoration` 未設定・`navigate()`（`main.ts:306-310`）で scrollTo なし=前画面のスクロール位置のまま次画面が出る・popstate のブラウザ復元は async render 完了前に発火して不発。

**変更方針**（順序が重要 — 状態統一が先、分割が後）:

1. want/watched/showEmpty フィルタを URL パラメータ化して fav と同じ扱いに（`router.ts` の `ListState` に追加、`LIST_PARAMS` 更新）。リロード/共有で同じ結果=L0 の「予測どおりに動く」に合致
2. スクロール管理（C19）: `history.scrollRestoration = 'manual'` + 前進遷移で `scrollTo(0,0)` + history state にオフセットを保存し popstate 時は render 完了後に復元
3. その後 `renderList` を「検索バー」「フィルタパネル」「グリッド+ページネーション」の 3 関数程度に分割、`main.ts` から `buildTopData`/`cardMetric` 等の view-model 計算を `features/` へ移動。**フレームワーク導入はしない**（vanilla 方針を尊重）
4. URL パラメータ追加は既存 URL と後方互換に（未指定=現行既定値）

**受け入れ条件**: フィルタ適用→リロードで全フィルタが復元される。カード遷移で先頭表示・戻るで元位置に復帰。既存の router/filter/e2e テスト緑 + ListState 追加分のテスト。tests/web/coverage.test.ts の REQ マップに影響がないこと。

## 4. franchise 導出の抑制（C25）

**問題**: `computeFranchiseKeys`（`series.mjs:179`）は「titleStem 一致」と「`〜シリーズ` タグ共有」の 2 種エッジによる union-find で、**誤結合が推移的に伝染する**:

- `titleStem`（`series.mjs:113-126`）は固定順の貪欲カットで、`~サブタイトル~` 付きタイトルは最初の `~` で切られる（`:124`）— 4 文字以上の共通前置きを持つ無関係作品が結合し得る
- `/シリーズ$/` タグエッジ（`:218`）は純粋に構文的で、「ロボットアニメシリーズ」等のジャンルタグでも 2 作品が結合する
- franchise キー = `f:${min(id)}`（`:238`）に**負の provisional ID** が混ざると、構成員の増減で min が揺れてキーが不安定

**変更方針**: ① `〜シリーズ` エッジに条件を付ける（curated タグに限定 or 共有作品数の上限=多数作品が持つタグはジャンルとみなし除外）② titleStem の `~` カットは「カット後 ≥6 文字」等の下限で保守化 ③ franchise キーの min 計算から負 ID を除外。関連シリーズは「ベストエフォート」スコープ（AGENTS.md）なので**偽陽性を減らす方向のみ**の変更とし、再現率の低下は許容。

**受け入れ条件**: 変更前後の franchise グルーピング diff を PR に添付し、解消された誤結合の実例と新たに失われた正結合の有無をレビュー。

## 5. 性能改善（C11）— 実測してから

**問題（候補）**:

- ETL: `_getEpisodesForSeriesSorted`（`store.mjs:1075-1081`）がシリーズ毎に全エピソード走査。`deriveSeriesOverviewsFromStore`・`deriveCoursFromTagsFromStore` も同型 → O(series×episodes)、約 6,700 シリーズで二次コスト
- フロント: 毎 render で全配列 clone-sort（`filter.ts:175-248` の 9 箇所）+ 全 DOM 再構築（`main.ts:364`）。現状はページサイズ 50〜200 が守っている
- **フォント**: `@fontsource/ibm-plex-sans-jp` のフル 3 ウェイト（400/500/700）を `@import`（`style.css:2-4`）— サイト最重量アセット。hourly の `resolveByTitle`（`list.mjs:136`）も pending 件数 × list.json 全タイトルの線形走査

**変更方針**:

1. ETL: run 冒頭で `seriesId → episodes[]` インデックスを 1 回構築し、各 derive 関数に渡す（daily の wall-clock を実測してから。ネットワーク律速なら優先度を下げる。Phase 2 項目 7-5 の先頭話探索一本化と同じインデックスを共用）
2. フロント: filter/sort 結果を `(state, データ世代)` キーでメモ化。キーストローク毎の全 sort を解消
3. フォント: 実転送量を計測し、ウェイト削減 or variable font or サブセット化を検討（CSP の `assetsInlineLimit:0` 前提を維持）
4. 仮想化・diff レンダリングは**やらない**（ページネーションで足りている間は複雑さに見合わない）

**受け入れ条件**: 変更前後で出力 JSON/表示が不変。daily の Node 実行時間 or 一覧操作の体感 or 初回転送量が計測可能に改善（`console.time` レベルの簡易計測で可）。

## 6. works.json 18MB の git/配信戦略 + LICENSE/再配布方針（C12 + C28）

**問題**: works.json（約 18MB）+ tags.json（約 2.8MB）が main にコミットされ、`data:` 再生成コミットのたびに履歴が肥大。フロントは初回に 18MB を全量 fetch。さらに **LICENSE ファイルが存在せず**、L1 `vision.md:43`「取得結果を再配布しない（生成 JSON は git 管理外）」・L2 `foundation.md:65,121` と、public repo にカタログ JSON がコミットされている実態が**矛盾**している（法的衛生 + 仕様の宙吊り）。

**変更方針**（運用変更を含むため慎重に・順に検討。**方針決定はユーザー判断事項**）:

0. **先に再配布方針を決める（C28）**: 選択肢 a = docs（L1/L2/AGENTS.md）を実態に合わせ「公開 JSON の main コミット=再配布」を明示的に許容し、コードの LICENSE とデータの出所・ToS 注記を追加。選択肢 b = 公開 JSON も state ブランチへ移して main から除去（下記 1 と統合され、L1 の記述が正になる）。どちらでも LICENSE ファイル追加は実施
1. main への `data:` 再生成コミットを停止: 公開 JSON も state ブランチへ移し（series/ と同方式）、deploy-pages は state から復元する。main には最小シード（開発用の小さな fixture）だけ残す — `vite.config.ts` の data ミドルウェアと `tests` のフィクスチャパスへの影響を確認
2. 配信サイズは分割で対応: works.json を「一覧に必要な軽量フィールド」と「詳細系（descriptionFirst/credits 等）」に分割し、後者は遅延ロード。`loader.ts`/`types.ts` の契約変更を伴うため項目 2（契約の機械化）の後に
3. Git LFS は Pages/Actions との相性とコストを確認してから（第一候補ではない）

**受け入れ条件**: 再配布方針が docs に明文化され L1/L2/実態が一致。（b 案なら）main の新規 `data:` コミットが止まる。初回表示に必要な転送量が減る（計測値を PR に記載）。既存 URL・deep-link は不変。

## 7. カバレッジ計測とテスト衛生（C14）

**問題**: 実カバレッジ計測なし（`docs/coverage.json` は REQ traceability map で別物=名前が紛らわしい）。テスト空白: `web/src/features/shared/version-check.ts`（更新バナー）、`scripts/ops-health.mjs`（Phase 1-2 で一部解消）、`scripts/store/credit-index.mjs`（項目 1 で解消）、`scripts/fetch.mjs` オーケストレーション。加えて**テスト衛生**（第2回レビュー）: `smoke.test.ts` は `1+1=2`、`structure.test.ts` は beforeAll で `mkdir` してから存在を検査する自己修復テスト=無信号。`e2e.test.ts` は実態「コンポーネント・レンダースモーク」で名前が過大（fetch→Store→projection の統合テストは存在しない）。`playwright` はスクショ専用なのに devDependency として全 install にブラウザ DL を強いる。

**変更方針**:

1. `@vitest/coverage-v8` を devDependency 追加、`test:coverage` script 新設（CI では任意 job・閾値ゲートはまだ設けない）。計測結果を見て空白上位から `version-check` → fetch オーケストレーション（Phase 2 の分割後はユニットで可能）の順にテスト追加
2. `docs/coverage.json` → `docs/req-coverage.json` へのリネームを検討（`tests/web/coverage.test.ts` の参照も同時更新）
3. テスト衛生: `smoke.test.ts` 削除・`structure.test.ts` の自己修復（mkdir）をやめて「無ければ FAIL」に・`e2e.test.ts` を `render-smoke.test.ts` 等へリネーム
4. playwright は `devDependencies` から optional 化（スクショ実行者のみ install）or `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` を README に明記。あわせて screenshot 系 3 スクリプトを 1 本に統合し、docs から参照されていない `shoot-top.mjs`・`analyze-ep-patterns.mjs` を削除（Phase 1 の C13 と分担調整可）

**受け入れ条件**: `pnpm test:coverage` がレポートを出す。空白モジュールにテストが付く。無信号テストが排除され、テスト名が実態と一致。

## 8. タグ品質（C16）

**問題**: `isTitleTag`（`etl/tags.mjs:70-78`）の前方一致ルール（タグ 4 文字以上でタイトルが前方一致→除外）により、フランチャイズ名タグが「タイトルがそれで始まるシリーズからだけ」抜ける非対称（README §6 調査結果②）。フランチャイズ横断のタグ検索で取り逃しが起き得る。

**変更方針**: 「複数シリーズ（例: 2 作品以上）に付いているタグは作品名タグとみなさない」等の頻度条件を追加して、フランチャイズ名を除外対象から救う。タグ増減が起きるため、変更前後の tags.json diff を PR に添付して判断。

**受け入れ条件**: フランチャイズ名タグの非対称が解消したことをフィクスチャで確認（例: タイトル前方一致でも複数作品共有タグは残る）。

## 9. docs ドリフトの解消（C27）

**問題**（第2回レビューで特定した 3 点）:

- `docs/l2_foundation/dataflow.md` の Phase E/G（`:303-322`）に **credits 抽出パイプラインが未記載**。実装は `project.mjs:101,349` で `buildCreditIndex` を呼び、works.json に `credits`/`creditNames` を出力している（専用仕様 `description-extraction.md` は存在するが、「正」とされる dataflow 側に反映されていない）
- コード中の**フラット `§NN` 参照（§20〜§94）がどのドキュメントにも解決しない**（`§N.N` 形式は `design-system.md` の §0〜§19 に解決する。二重体系の片方が宙に浮いており、`tags.mjs:6`（§27）・`tag-filter.ts:47`（§82）・`nvapi.mjs:52`（§85）等が未解決参照）
- `dataflow.md:374-384` に「2026-06-21 時点」の実測件数がハードコードされ、静かに腐る

**変更方針**: ① dataflow.md の Phase E/G に credits ステップと works.json 出力フィールドを追記 ② フラット §NN の**決定記録インデックス**（`docs/decisions.md` 等・番号→1 行要約）を作るか、作らないなら未解決参照をコードコメントから削除する方針を決めて一括適用 ③ dataflow §7 の実測値に「例示・最新値は ops-health 出力を参照」と注記。

**受け入れ条件**: コード中の §参照がすべて解決可能（または削除済み）。dataflow.md だけ読んで works.json の全フィールドの由来が追える。
