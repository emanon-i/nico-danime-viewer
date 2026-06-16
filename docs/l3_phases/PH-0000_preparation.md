# PH-0000: 準備・プロジェクト雛形

## 目的

pnpm + Vite + TypeScript の静的サイト雛形と、データ取得（Node ESM）の土台・テスト/検証基盤を整え、`pnpm` の各コマンドが空状態でも通る状態にする。L2 §1（技術スタック）/§5（テスト・検証戦略）に準拠。

## 機能一覧

### F-0001: プロジェクト雛形（pnpm + Vite + TS）

**対応REQ**: 基盤（L2 §1.1 / §2.3）

`web/`（Vite + TypeScript バニラ）と `scripts/`（Node ESM `.mjs`）の二層を持つ単一リポジトリを構成し、`package.json` に `dev/build/fetch/test/lint/typecheck` スクリプトを定義する。Node バージョンは `.nvmrc` ＋ `engines` で固定。

**受け入れ条件**:

- [x] `pnpm install --frozen-lockfile` がクリーンに完了する
  - 検証: `pnpm install --frozen-lockfile` が exit 0 ✓ (2026-06-16)
- [x] `pnpm dev` で Vite 開発サーバが起動し `web/index.html` を配信する
  - 検証: `pnpm dev` 起動後 `curl -s localhost:5173` が 200（CI ではヘッドレス起動確認）✓ (2026-06-16)
- [x] `pnpm build` が `dist/` を生成して正常終了する
  - 検証: `pnpm build` が exit 0 かつ `dist/index.html` が存在 ✓ (2026-06-16)
- [x] ディレクトリ構成が L2 §2.3 と一致（`scripts/`・`scripts/nico/`・`data/`・`data/state/`・`web/src/{data,features,shared}`）
  - 検証: テスト（構成パスの存在アサート）✓ tests/structure.test.ts 9件パス (2026-06-16)
- [x] `.nvmrc` と `package.json#engines` で Node 20+ を固定
  - 検証: テスト `tests/structure.test.ts` で確認 ✓ (2026-06-16)

---

### F-0002: テスト基盤（Vitest）

**対応REQ**: 基盤（L2 §5.1）

Vitest を導入し、`pnpm test` がゼロテスト状態でも正常終了する。CI でも同一コマンドで実行でき、機械可読（JUnit XML 等）出力を選べるようにする。

**受け入れ条件**:

- [x] `pnpm test` がテスト0件でも exit 0
  - 検証: `pnpm test` が exit 0 ✓ (2026-06-16)
- [x] `pnpm test` が CI 環境（非対話）でも同一コマンドで実行できる
  - 検証: `CI=1 pnpm test` が exit 0 ✓ `vitest run`（非インタラクティブ）(2026-06-16)
- [x] サンプルのスモークテスト1件がパスする
  - 検証: テスト `smoke` がパス ✓ tests/smoke.test.ts (2026-06-16)

---

### F-0003: セルフ検証（ESLint + Prettier + tsc）

**対応REQ**: 基盤（L2 §5.1）

ESLint・Prettier・`tsc --noEmit` を設定し、`pnpm lint` / `pnpm typecheck` がエラー0で通る。コミット前に lint-staged で差分のみ整形/検査する。

**受け入れ条件**:

- [x] `pnpm lint` がエラー0で通る
  - 検証: `pnpm lint` が exit 0 ✓ (2026-06-16)
- [x] `pnpm typecheck`（`tsc --noEmit`）がエラー0で通る
  - 検証: `pnpm typecheck` が exit 0 ✓ (2026-06-16)
- [x] lint-staged（または pre-commit）で差分ファイルのみ整形/検査される設定がある
  - 検証: `package.json#lint-staged` + `simple-git-hooks` 設定あり ✓ (2026-06-16)

---

### F-0004: スクリプト用 構造化ログ

**対応REQ**: 基盤（L2 §3 変更検知 / §5.4）

`scripts/` の fetch/ETL が、解析可能な構造化ログ（JSON もしくは key=value）を出力する。変更検知の失敗時には源名・件数・期待しきい値・実測値を含め、Actions ログで原因が特定できるようにする。

**受け入れ条件**:

- [x] fetch ログが構造化形式（JSON か key=value）で出力される
  - 検証: テスト（ログ1行をパースして必須キーを確認）✓ tests/logger.test.mjs (2026-06-16)
- [x] 変更検知の失敗ログに 源名・期待しきい値・実測値・コンテキストが含まれる
  - 検証: テスト `test_change_detection_log_fields` ✓ (2026-06-16)
- [x] ログレベル（debug/info/warn/error）で出力をフィルタできる
  - 検証: テスト（`LOG_LEVEL=warn` で info が抑制される）✓ (2026-06-16)

---

### F-0005: ログ／出力ハンドリング方針

**対応REQ**: 基盤（L2 §1.4 / §3）

本プロジェクトは常時稼働サーバを持たず、ログは Actions の stdout/stderr に集約する。ファイルログのローテーションは持たず、「stdout → プラットフォーム（GitHub Actions）のログ管理に委任」する方針をドキュメント化する。

**受け入れ条件**:

- [x] スクリプトのログは stdout/stderr に出し、ファイルへ書かない（または明示的に一時のみ）
  - 検証: テスト（実行後に新規ログファイルが生成されない）✓ tests/logger.test.mjs `no log files created` (2026-06-16)
- [x] ログ管理方針（stdout 委任・保持期間は Actions 既定）が README もしくは docs に記載される
  - 検証: README.md「ログ管理方針」節の存在確認 ✓ (2026-06-16)

---

## Exit Criteria

- [x] `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build` が一括で exit 0 ✓ (2026-06-16)
- [x] ディレクトリ構成が L2 §2.3 に一致 ✓ (2026-06-16)
- [x] 構造化ログとログ方針が用意され、以降のフェーズが乗せられる土台になっている ✓ (2026-06-16)
