# PH-0007: デプロイ＆CI＆総合テスト

## 目的
GitHub Pages ビルドと GitHub Actions の定期 fetch ワークフロー（毎時 RSS／日次フル）を**記述として**整備し（このフェーズでは起動しない）、状態の真実源運用・最小権限・依存固定を定義する。総合/E2E テストと v1 受け入れ最終チェックで「全機能が使える状態」を確認する。foundation §1.4・dataflow.md §7・db-design.md §6/§7 準拠。

> 注: ワークフローは YAML として記述・コミットするのみ。**初回の全件取得や cron の起動はこのフェーズでは行わない**（ユーザーの GO 後）。

## 機能一覧

### F-0044: GitHub Pages ビルド／公開設定
**対応REQ**: 非機能（foundation §1.4）

`pnpm build` の `dist/` を GitHub Pages で配信する設定を用意する。public site の base path・アセットパスが Pages 上で壊れないことを確認する。生成物（`data/*.json`）はビルド時に取得/配置され、ソースにはコミットしない。

**受け入れ条件**:
- [ ] `pnpm build` の `dist/` が Pages の base path で正しくアセット解決される
  - 検証: テスト/ビルド検証（base path 設定の確認・相対パス解決）
- [ ] `data/*.json` が `.gitignore` 済みで、ビルド経路でのみ配置される
  - 検証: テスト/Grep（リポジトリに生成 JSON が混入していない）

---

### F-0045: 毎時ジョブ ワークフロー（新着 RSS・記述のみ）
**対応REQ**: REQ-0010 / 非機能（dataflow.md §7, db-design.md §6.1）

毎時 cron の Actions ワークフロー（YAML）を記述する: 状態復元 → RSS page1 条件付き GET → `rss_items` 更新・id 解決 → 新着系 JSON export → 状態保存。`pnpm/action-setup`＋`actions/setup-node`（`cache: pnpm`）、サードパーティ action は SHA 固定、`GITHUB_TOKEN` は最小権限。**このフェーズでは起動しない**。

**受け入れ条件**:
- [ ] 毎時ワークフロー YAML が存在し、cron・最小権限・SHA 固定 action・pnpm キャッシュを含む
  - 検証: テスト/Lint（YAML スキーマ検証・`permissions` と SHA 固定の静的チェック）
- [ ] ジョブ手順が dataflow.md §7 / db-design.md §6.1（条件付き GET・HWM・id 解決・rss_only）と整合する
  - 検証: 目視不要、ステップ定義の項目対応チェック

---

### F-0046: 日次ジョブ ワークフロー＋状態の真実源（記述のみ）
**対応REQ**: REQ-0002 / 非機能（dataflow.md §7, db-design.md §6.2/§7）

日次 cron の Actions ワークフロー（YAML）を記述する: 状態復元 → version ゲート → snapshot フル（期間分割・逐次・レート遵守・503 バックオフ）→ 一括 UPSERT → series/タグ/クール/フランチャイズ結合 → set-based metrics → export。**状態（DB・prev・HWM）の真実源は専用 artifact もしくは state ブランチ**、`actions/cache` は高速化フォールバック、**状態書き込みは単一 state-writer の concurrency group**。AM5:00(JST) 後の閑散帯に1回。**起動しない**。

**受け入れ条件**:
- [ ] 日次ワークフロー YAML が version ゲート・期間分割・レート遵守・バックオフのステップを含む
  - 検証: テスト/Lint（ステップ定義の項目対応チェック）
- [ ] 状態の真実源（artifact/state ブランチ）と単一 state-writer concurrency group が定義される
  - 検証: 目視不要、`concurrency` 設定と状態保存ステップの存在確認
- [ ] 変更検知アサート失敗時に fail し、前回正常な公開物を保持する経路が記述される
  - 検証: 目視不要、fail 時の非公開フローの確認

---

### F-0047: 総合／E2E テスト
**対応REQ**: 非機能（foundation §5）

データ→JSON→フロントの結合を検証する。固定のサンプル JSON（フィクスチャ）でトップ→一覧→詳細の主要動線・URL 状態再現・empty 表示・お気に入り/見たを通しでテストする（Playwright 等の E2E は導入可、最小はフィクスチャ＋DOM アサート）。

**受け入れ条件**:
- [ ] フィクスチャ JSON でトップ→一覧→詳細の主要動線が通る
  - 検証: テスト `test_e2e_top_list_detail_flow`
- [ ] URL 状態の共有→再現が end-to-end で確認できる
  - 検証: テスト `test_e2e_url_state_reproduce`
- [ ] empty 表示・お気に入り/見た・テーマが結合状態で動く
  - 検証: テスト `test_e2e_user_state_and_empty`

---

### F-0048: v1 受け入れ最終チェック
**対応REQ**: 全 v1 REQ（CLAUDE.md 完了前チェック / L1 §3 v1）

CLAUDE.md「完了前チェック」と L1 v1 スコープを照合する受け入れチェックを通す: 取得/表示の分離・支店フィルタ・API マナー・生成物非コミット・スコープ逸脱なし（`genre` を facet 化しない）・docs 受け入れ条件の充足。

**受け入れ条件**:
- [ ] CLAUDE.md 完了前チェック 7 項目がすべて満たされる
  - 検証: チェックリスト（各項目に対応テスト/Grep）
- [ ] L1 v1 スコープの全 REQ（0001/0002/0003/0004/0005/0008/0010/0011/0012/0013/0014/0015/0016）が画面/データで充足する
  - 検証: **機械可読の REQ↔F カバレッジファイル**（例 `docs/coverage.json`）を CI で検証＝各 v1 REQ に1つ以上の実装済み F が紐付き、未カバー0件をアサート
- [ ] 将来スコープ（0006/0007/0009）を実装に混ぜていない
  - 検証: テスト/Grep（期間デルタ/個人化/リコメンドの実装が無い）

---

## Exit Criteria
- [ ] `pnpm build` の `dist/` が Pages 設定で配信可能（base path 解決済み）
- [ ] 毎時/日次ワークフロー YAML が記述・コミットされ、静的検証を通る（**未起動**）
- [ ] 総合/E2E テストがパスし、v1 受け入れ最終チェックが全項目満たされる
- [ ] `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm build` が通る
- [ ] 初回全件取得・cron 起動は**ユーザーの GO 後**に行う（このフェーズでは行わない）
