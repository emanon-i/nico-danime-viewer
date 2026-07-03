# Phase 1: 低リスクで効果が高い改善（退行防止と正本の回復）

原則: 挙動を変えない or 明確に「正しくなる」方向の変更のみ。各項目は独立した PR サイズ。上から順に着手する。

## 1. CI ワークフロー `ci.yml` の追加（C1）★最初の PR

**問題**: `pnpm test`（39 ファイル）・`lint`・`typecheck`・`build` がどのワークフローでも実行されていない。壊れたコードが main 直行→本番 deploy される。

**対象ファイル**: `.github/workflows/ci.yml`（新規）のみ。

**変更方針**:

- トリガ: `pull_request` + `push: branches: [main]`
- ジョブ 1 本: checkout → pnpm セットアップ（既存ワークフローの `pnpm/action-setup` + `actions/setup-node` の **SHA ピンをそのまま流用**、`pnpm install --frozen-lockfile`）→ `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build`
- `permissions: contents: read` のみ。`concurrency` で同一 ref の重複実行をキャンセル
- build はコミット済みシード `data/*.json` で通る想定（deploy はしないので dist 内 JSON の assert は不要）

**注意**: `tests/web/coverage.test.ts:80-87` が全ワークフローの Action SHA ピンを検査するため、ピン漏れがあると既存テストが落ちる（=ピンを強制してくれる）。

**受け入れ条件**:

- [ ] PR 上で 4 ステップ（lint/typecheck/test/build）が全て緑
- [ ] わざと型エラーを入れた draft PR で CI が赤になることを一度確認

**検証方法**: PR を出して checks を確認。ローカルでは `pnpm lint && pnpm typecheck && pnpm test && pnpm build`。

## 2. ops-health 判定基準の修正（C15）

**問題**: 直近 15 run 中 7 失敗の原因が判定基準の設計問題（README §6 調査結果①）。(a) U1 が snapshot startTime と RSS pubDate という別ソースの時刻を比較し、上流 RSS の停滞を ci=true（データ正しさ FAIL）として通知。(b) provisional（負 seriesId）の過渡状態に猶予がなく、U3/サムネ値域が日次リコンサイル前に誤発火。

**対象ファイル**: `scripts/ops-health.mjs`（`:414-472` の user-visible ティア、`:352-361` のサムネ値域）、テスト新規 `tests/ops-health.test.mjs`（チェック関数を export して単体テスト可能に）。

**変更方針**:

1. **U1 を分割**:
   - ci=true（射影の正しさ）: 「new.json の先頭 100 件が state の rss と一致するか」等、**自パイプライン内で閉じる整合性**に限定
   - ci=false（上流鮮度 WARN）: 「rss 最新 pubDate の経過時間」を鮮度シグナルとして別 record 化（`FRESH` と同じ扱い）
   - 診断情報を detail に含める: works.latestAt 最大の contentId/タイトル、new 最新の watchId — 将来のトリアージを一目化
2. **provisional 猶予**: `seriesId < 0` を U3・値域サムネ・値域 episodeCount の FAIL 対象から除外し、「provisional N 件が過渡状態」という WARN（ci=false）で可視化。fetch 側のグレース（`fetch.mjs:103-104` の 2〜3 日）と整合させる
3. あわせて **RSS HWM 固着の検証**（仮説）: state ブランチの `state/rss.json` の最新 pubDate と、実際のフィード `ch.nicovideo.jp/ch2632720/video?rss=2.0` の先頭 pubDate を突き合わせる。フィード側が進んでいるのに state が止まっていれば `nico/rss.mjs:13-24` の条件付き GET/HWM を修正（別 PR）

**受け入れ条件**:

- [ ] 上流 RSS が静止しているだけの状態（07-03 の再現ケース）で `--ci` が exit 0（WARN は出る）
- [ ] provisional が works に未反映の状態（07-02 の再現ケース）で `--ci` が exit 0
- [ ] new.json と rss state の不一致（本物の射影バグ）を注入したフィクスチャで exit 1
- [ ] チェック関数の単体テスト追加（fixtures ベース・ネットワーク不要）

**検証方法**: `pnpm ops:health -- --ci` をローカル実行 + 新規テスト。マージ後、次の失敗パターン到来時に誤報が止まっていることを workflow 履歴で確認。

## 3. AGENTS.md / README の現行化（C3）

**問題**: AGENTS.md:6,14-15 が dev/build を「雛形（未実装）」と記載（実際は `vite.config.ts` 93 行実装済み・本番稼働中）。AGENTS.md:25「生成物はコミットしない」が実態（公開 JSON 6 本はシードとしてコミット、series/state のみ git 外）と矛盾。README の開発者向けセクションに test/lint/typecheck の記載なし。

**対象ファイル**: `AGENTS.md`（コマンド表・生成物ポリシー）、`README.md`（開発者向けコマンド）。

**変更方針**: コマンド表の「状態」を実装済みに更新。生成物ポリシーを「`data/series/`・`data/state/` は git 外（state ブランチが正準）。公開 JSON 6 本（works/ranking/tags/cours/kana/new）は**初回シードとして main にコミット**され、CI が再生成コミットする」と実態どおりに書き直す。

**受け入れ条件**: AGENTS.md の全記述が `package.json`・`.gitignore`・workflows の実態と一致。

**検証方法**: レビューで突き合わせ（機械検証なし）。

## 4. prevViewCounter クロバー修正（C2）

**問題**: `scripts/store/store.mjs:520-521` が upsert のたびに無条件で `existing.prevViewCounter = existing.viewCounter` を実行。1 run 内で同一エピソードが 2 回 upsert されると（daily の B3 seed → A2 rescue → B6 verify は再 upsert し得る）、2 回目で prev が「更新後の値」に潰れ、その日の delta（Hot ランキングの核）が静かに 0 になる。

**対象ファイル**: `scripts/store/store.mjs`（`upsertEpisodes`）、`tests/store/store.test.mjs`（回帰テスト追加）。

**変更方針**: 「prev の退避は 1 run につき 1 回まで」にする。実装候補（いずれか）:

- Store に run 単位の `_prevSavedThisRun: Set<contentId>` を持ち、初回 upsert のみ退避（loadStore 時に初期化）
- または viewCounter が実際に変化する場合のみ退避（`raw.viewCounter != null && raw.viewCounter !== existing.viewCounter` のとき `prev := existing.viewCounter`）— nvapi 再 upsert は viewCounter を持たないため実質同等でより単純。**こちらを推奨**（フラグ管理不要）

**受け入れ条件**:

- [ ] 回帰テスト:「view 100 → upsert(view 150) → 再 upsert(view なし/同値)」で `prevViewCounter === 100` を維持し delta が 50 のまま
- [ ] 既存の store/metrics テストが全て緑

**検証方法**: `pnpm test`。マージ後、翌日次の ranking.json で hotScore 非ゼロ率が維持されることを ops-health で確認。

## 5. 死んだ drop-rate assert の整理（C13 の一部）

**問題**: `scripts/fetch.mjs:367` が `assertSnapshotOk` に合成 meta（`previousTotalCount=null`）を渡すため、`nico/assert.mjs:64-73` の 20% 減少ゲートは永久に発火しない。実際の縮小保護は `detectShrinkFromStore`（`fetch.mjs:69-78`）が担っている。

**対象ファイル**: `scripts/fetch.mjs`、`scripts/nico/assert.mjs`、`tests/nico/assert.test.mjs`。

**変更方針**: 二者択一を明示的に。(a) state の `meta.json` に前回件数を保存して配線し両ゲート活かす、または (b) drop-rate 引数を削除し「縮小検知は detectShrinkFromStore に一本化」とコメントで明記。**推奨は (b)**（同目的のガードが 2 系統あるほうが混乱）。

**受け入れ条件**: 死んだ分岐が消えるか、実際に発火し得る配線になる。テストが実態と一致。

## 6. 小物の頑健性（C13 残り）

一括 or 個別の小 PR。いずれも挙動追加なしの防御:

1. **localStorage quota**: `web/src/features/shared/user-state.ts:22-24`（`saveIds`）・`main.ts:341`・`theme.ts:50` の `setItem` を try/catch（Safari プライベートモード/quota で click ハンドラが未捕捉例外にならないように）。失敗時は静かに無視 or 一度だけ通知
2. **未使用 sanitize 層の扱い決定**: `web/src/shared/sanitize.ts` はどの描画経路からも import されていない（textContent 徹底が実防御）。「将来 innerHTML 化する時のための保険」とファイル冒頭に明記するか、削除してテストも整理。**推奨: 明記して保持**（PH-0006 の設計意図を尊重）
3. **重複 util の共有化**: `ms()`/`soNum()` が `web/src/main.ts:165-172` と `features/list/filter.ts:198-223` に重複 → `web/src/shared/` へ抽出。`normalizeTitleForMatch` の同名別実装（`nico/rss.mjs:133` vs `etl/cours.mjs:53`）はどちらかをリネームして混同を防ぐ

**受け入れ条件**: `pnpm lint && pnpm typecheck && pnpm test` 緑。grep で重複定義が消えている。
