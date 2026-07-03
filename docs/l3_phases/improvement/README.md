# 改善計画（リポジトリ全体分析）

作成日: 2026-07-03。リポジトリ全体（scripts / web / tests / CI / docs）を読み、今後の開発速度・保守性・品質を上げるための改善課題を優先順位つきで整理したもの。

- 段階別の実行計画: [phase1.md](phase1.md)（低リスク高効果）→ [phase2.md](phase2.md)（設計整理）→ [phase3.md](phase3.md)（中長期）
- 各 phase ファイルに項目ごとの「対象ファイル・変更方針・受け入れ条件・検証方法」を記載

---

## 1. リポジトリ全体の理解

**目的**: dアニメストア ニコニコ支店（`channelId 2632720`）専用の非公式発見 UI。ニコニコ公開 API（snapshot 検索 / nvapi series / チャンネル RSS / 静的 JSON）からデータを取得し、静的 JSON に射影して GitHub Pages で配信。視聴は公式プレイヤーへの deep-link のみ。

**技術スタック**: データ層 = Node.js ESM `.mjs`（JSDoc 型・runtime 検証なし）、フロント = Vanilla TypeScript + Vite（フレームワークなし）、テスト = Vitest（39 ファイル / 約 6,400 行）、CI = GitHub Actions（cron fetch + Pages deploy）、pnpm。

**構成**:

| パス                     | 実態                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `scripts/fetch.mjs`      | オーケストレータ（1029 行）。`--mode=seed/hourly/full`                                                   |
| `scripts/nico/`          | API クライアント（snapshot / nvapi / rss / list / assert / filter）                                      |
| `scripts/store/`         | 正準データ層 `store.mjs`（1081 行）+ 射影 `project.mjs`（460 行）                                        |
| `scripts/etl/`           | 派生ロジック（tags / cours / credits(857 行) / metrics / series）                                        |
| `scripts/ops-health.mjs` | 運用監視（523 行・読み取り専用）                                                                         |
| `web/src/`               | main.ts（698 行）+ features/{top,list,detail}（list.ts 899 行）+ data/{loader,types}                     |
| `data/`                  | 公開 JSON 6 本は main にコミット（works.json 約 18MB）。series/・state/ は `state` orphan ブランチが正準 |
| `docs/`                  | Tri-SSD L0〜L3。PH-0000/0003/0004/0005/0006/0014 が現存                                                  |

**重要な実行経路**:

1. **日次 full**（cron 22:30 UTC）: `state` ブランチ復元 → snapshot 全量（年窓×ページング・逐次）+ 静的 JSON + nvapi series → メモリ Store（Map）に upsert → 派生（tags/cours/credits/metrics）→ `writeBackStore`（series/state）→ `projectAll`（公開 JSON 6 本）→ Pages deploy → state ブランチへ rsync+commit
2. **毎時 hourly**: RSS HWM 増分 → partial store → `exportWorksPartial` → `.deploy-needed` センチネルがある時のみ deploy
3. **フロント**: `loader.ts` が `data/*.json` を fetch → `main.ts render()` がクエリ文字列ルーティング（`router.ts` の判別共用体 `Screen`）で 3 画面に分岐 → 全 DOM 再構築

> 注: AGENTS.md は「現状は土台のみ・dev/build 未実装」と記載しているが実態と乖離（→ C3）。

## 2. 現状評価

### 良い点（尊重する設計意図）

- **取得/表示の分離・支店フィルタ・API マナー**（UA 必須・適応ディレイ `lib/http.mjs:34-36`・503 バックオフ）が一貫
- **XSS 対策が堅牢**: API 由来文字列は全て `textContent`、`innerHTML` は定数のみ 2 箇所、CSP meta、静的解析テストで方針を強制（`tests/web/security-static.test.ts`）。web に `any` ゼロ
- **テスト文化**: 39 ファイル、DI シーム（`_http`）によるネットワークモック、純関数中心で brittle でない
- **CI 運用設計**: state orphan ブランチ + `concurrency: state-writer` で書き込み直列化、`.deploy-needed` センチネルで無駄 deploy 抑止、Action は全て SHA ピン（テストで強制）
- a11y が丁寧（skip link / aria / focus 管理）、docs は受け入れ条件が検証日付き

### 危うい点

- **prevViewCounter が upsert のたびに無条件クロバー**（`scripts/store/store.mjs:520-521`）— 1 run 内で同一エピソードが 2 回 upsert されると（B3 seed → A2 rescue → B6 verify の経路が再 upsert し得る）、その日の delta（Hot ランキングの核）が静かに消える。経路重複の頻度は未計測（仮説）だが機構は確認済み
- **複数ファイル永続化に横断的原子性がない**: 個々の書き込みは tmp+rename で原子的だが、`writeBackStore` → `projectAll` の 2 段（`fetch.mjs:704-705`）の間でクラッシュすると prev-views だけ進み delta が恒久喪失。provisional series の `unlinkSync`（`fetch.mjs:311,553`）も同種
- **リトライは 503 のみ**（`lib/http.mjs:42-51`）。snapshot の 1 年窓が 500/429 で落ちると日次全体が中断（`nico/snapshot.mjs:67-68`）
- **drop-rate ガードが死んでいる**: `assertSnapshotOk` に `previousTotalCount=null` を渡している（`fetch.mjs:367`）ため `nico/assert.mjs:64-73` は永久に発火しない

### すぐ問題になる点

- **CI に品質ゲートが皆無**: 約 6,400 行のテスト・lint・typecheck・build 検証が**どのワークフローでも実行されていない**。壊れたコードが main に入りそのまま deploy される
- **ops-health が誤報中**: 直近 15 run 中 7 失敗。判定基準の設計問題 2 件が原因（→ §6 調査結果①）
- **AGENTS.md が実装と矛盾**: dev/build「雛形（未実装）」表記（実際は稼働中）、「生成物はコミットしない」と実態（公開 JSON 6 本コミット済み）の食い違い。エージェント駆動開発の正本が古いのは判断ミスを直接誘発
- **集計ロジックの二重実装**: `buildEpAggMap`（`project.mjs:44-93`）と `exportWorksPartial` 内（`project.mjs:352-392`）が同一の totalViews/latestAt/firstAt/so 番号タイブレークを重複実装。「毎時とパリティ必須」とコメントで明記されたドリフト・トラップ

### 将来ボトルネックになりそうな点

- **works.json 18MB を main にコミット**: clone 肥大 + フロントは全量 fetch してメモリ保持 + 毎 render で全配列 clone-sort（`web/src/features/list/filter.ts:175` ほか）
- **神モジュール**: store.mjs（I/O+CRUD+話数パーサ 110 行混在）、fetch.mjs（rescue/reconciliation アルゴリズム内蔵・未 export=単体テスト不能）、list.ts の renderList（約 590 行の単一関数）、main.ts render()（約 330 行）
- **O(series×episodes) の全走査**: `_getEpisodesForSeriesSorted`（`store.mjs:1075-1081`）がシリーズ毎に全エピソードを走査。約 6,700 シリーズで二次コスト
- **データ契約が片側のみ**: `web/src/data/types.ts` は「正本」を名乗るが生成側 `.mjs` は型なし、loader のガードはトップレベルのみ（`loader.ts:17-20`）。契約ドリフトは実行時 undefined 伝播で発覚する構造
- **設定の分散**: チャンネル ID が数値 `2632720`（`nico/filter.mjs:4`）/ 文字列 `'ch2632720'`（`nico/nvapi.mjs:14`）/ RSS URL 直書き（`nico/rss.mjs:7`）の 3 形態。閾値・URL・実測フロア（`ops-health.mjs:34-56`）が 10 ファイル超に散在
- **web の状態モデル不統一**: fav は URL、want/watched/showEmpty はモジュールグローバル `let`（`main.ts:69-73`）。同種フィルタでリロード時挙動が異なる
- **credits.mjs（857 行の正規表現パイプライン）**: 直近コミット履歴がノイズ除去の反復修正で占められる=最も品質コストの高い領域。export は 2 関数のみで内部はE2E経由でしかテスト不能

## 3. 改善候補一覧

| #   | テーマ                       | 問題                                                                                                                                                                                                              | 根拠                                              | 放置リスク                        | 効果                         | 難易度 | 破壊リスク           | 優先度                 |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------- | ---------------------------- | ------ | -------------------- | ---------------------- |
| C1  | PR/push CI ゲート            | test/lint/typecheck/build が全ワークフロー未実行                                                                                                                                                                  | `.github/workflows/` 全検索                       | 退行が main 直行→本番 deploy      | 全テスト資産が即ゲート化     | 低     | なし                 | **最高**               |
| C15 | ops-health 判定基準修正      | U1 の意味論混同・provisional に猶予なし（§6 参照）                                                                                                                                                                | 失敗ログ + `ops-health.mjs:414-472`               | 誤報でアラート疲れ→本物を見逃す   | 監視の信頼回復               | 低〜中 | 低                   | **最高**（現に誤報中） |
| C3  | AGENTS.md/README 現行化      | dev/build「未実装」表記・データコミット方針の矛盾                                                                                                                                                                 | AGENTS.md:14-15,25 vs 実装                        | エージェント/新規開発者の判断ミス | オンボード・エージェント精度 | 低     | なし                 | 高                     |
| C2  | prevViewCounter クロバー修正 | run 内再 upsert で delta 消失                                                                                                                                                                                     | `store.mjs:520-521`                               | Hot ランキングの静かな劣化        | データ正しさの根幹保護       | 低〜中 | 低                   | 高                     |
| C5  | 設定/定数の一元化            | チャンネル ID 3 形態・閾値散在                                                                                                                                                                                    | `filter.mjs:4`/`nvapi.mjs:14`/`rss.mjs:7` ほか    | 変更漏れ・値の不整合              | 変更コスト減・暗黙知可視化   | 低     | 低                   | 高                     |
| C6  | 集計 reducer 一本化          | 日次/毎時で同一集計を二重実装                                                                                                                                                                                     | `project.mjs:44-93` vs `352-392`                  | 日次と毎時で数値ドリフト          | パリティを構造で保証         | 低〜中 | 低（テスト有）       | 高                     |
| C4  | 永続化トランザクション化     | writeBackStore→projectAll 間クラッシュで torn state                                                                                                                                                               | `fetch.mjs:704-705`, `store.mjs:329-406`          | まれだが復旧不能なデータ破損      | クラッシュ耐性               | 中     | 低                   | 高（Phase 2 先頭）     |
| C7  | リトライ一般化+窓単位許容    | 503 のみリトライ・1 窓失敗で日次全断                                                                                                                                                                              | `http.mjs:42-51`, `snapshot.mjs:67`               | 一過性障害で日次欠損が常態化      | 運用安定性                   | 中     | 低                   | 中〜高                 |
| C8  | 神モジュール分割（scripts）  | 話数パーサ・rescue/reconciliation がテスト圏外                                                                                                                                                                    | `store.mjs:944-1055`, `fetch.mjs:175-318,480-562` | 最重要ロジックが未テスト          | テスト可能化                 | 中     | 中（移動のみなら低） | 中                     |
| C9  | データ契約の共有・深い検証   | 生成側型なし・loader は要素未検証                                                                                                                                                                                 | `types.ts`, `loader.ts:17-20`                     | スキーマ変更時の静かな破損        | 契約同期の機械化             | 中     | 低                   | 中                     |
| C10 | web 状態統一+render 分割     | fav=URL / want=グローバル let の不整合、god 関数                                                                                                                                                                  | `main.ts:69-73,388,554-563`, `list.ts:313-899`    | UI 機能追加のたびに複雑化         | フロント開発速度             | 中〜高 | 中                   | 中                     |
| C11 | 性能（二次走査・clone-sort） | シリーズ毎全走査・キー操作毎の全 sort                                                                                                                                                                             | `store.mjs:1075-1081`, `filter.ts:175-248`        | データ増で劣化                    | 実測後で足りる               | 中     | 低                   | 中〜低                 |
| C12 | works.json 18MB 戦略         | main 肥大・フロント全量ロード                                                                                                                                                                                     | `git ls-files data/`                              | clone/CI 遅延の漸増               | リポジトリ健全性             | 中〜高 | 中（運用変更）       | 低〜中                 |
| C13 | 細部の頑健性                 | localStorage quota 未処理（`user-state.ts:22-24`）・未使用 sanitize 層・死んだ drop-rate assert（`fetch.mjs:367`）・重複 util（`ms`/`soNum` が main.ts と filter.ts に重複、`normalizeTitleForMatch` 同名別実装） | 各所                                              | 個別は小さいが蓄積                | 低コスト解消                 | 低     | なし                 | 低〜中                 |
| C14 | カバレッジ計測導入           | 実カバレッジなし（docs/coverage.json は traceability map で別物）                                                                                                                                                 | `package.json:16`                                 | テスト空白の不可視                | 空白の可視化                 | 低     | なし                 | 中                     |
| C16 | タグ品質                     | isTitleTag のフランチャイズ名非対称（§6 調査結果②）・タグ意味論が暗黙知                                                                                                                                           | `etl/tags.mjs:70-78`                              | フランチャイズ横断検索の取り逃し  | 発見性向上                   | 低〜中 | 中（タグ増減）       | 低〜中                 |

## 4. 優先順位トップ5

1. **C1: PR/push CI ゲート追加** — 最小工数で最大の退行防止。他のすべての改善の安全網になるため必ず最初。
2. **C15: ops-health 判定基準修正** — 現在進行形の誤報を止める。誤報が続くと「失敗通知は無視してよい」が常態化し、本物の障害を見逃す。
3. **C3: AGENTS.md/README 現行化** — エージェント駆動開発が前提のリポジトリで、正本が「未実装」と嘘をつく状態は以後のすべての作業品質に響く。
4. **C2: prevViewCounter クロバー修正** — 中核指標（Hot）の静かなデータ破損。C1 のゲート下で回帰テストを書いて直す。C4 より先なのは、こちらは毎 run 発生し得るのに対し C4 はクラッシュ時のみのため。
5. **C5: 設定一元化** — 機械的で安全、以後のすべての変更コストを下げる。C7（リトライ）や C8（分割）の前提整備。

## 5. 推奨改善ロードマップ

- **Phase 1**（[phase1.md](phase1.md)）: CI ゲート → ops-health 修正 → ドキュメント現行化 → prevViewCounter 修正 → 死んだ assert 整理 → 小物（quota/sanitize/重複 util）
- **Phase 2**（[phase2.md](phase2.md)）: config 一元化 → 集計 reducer 一本化 → 永続化トランザクション化 → 神モジュール分割 → リトライ一般化
- **Phase 3**（[phase3.md](phase3.md)）: データ契約の機械化 → web 状態統一と render 分割 → 性能 → works.json 戦略 → カバレッジ → タグ品質

## 6. 調査結果（2026-07-03 実施）

### 調査結果①: Ops Health workflow 失敗の原因（ログで裏取り済み）

直近 15 run 中 7 失敗（断続的）。失敗 run のログを複数取得し、判定基準の設計問題を 2 つ特定した。

**(a) U1「新着反映ラグ」の意味論混同** — 直近 3 連続失敗（07-02 19:36 / 07-03 03:37 / 07-03 09:24 UTC）の原因。

- U1 = `max(works.latestAt) − max(new.json pubDate) > 24h` で FAIL・**ci=true**（`ops-health.mjs:414-428`、`UV.newLag=24h`）
- しかし `works.latestAt` は **snapshot の startTime**（予約公開・snapshot 経由の後追い取り込みを含む）、`new.json` の pubDate は**チャンネル RSS フィード**由来（`project.mjs:290-317`）。**別ソース・別意味の時刻の比較**になっている
- 失敗 run ではラグが 25.5h → 35.5h と経過時間どおりに増加 = RSS store の最新 pubDate が約 2 日間凍結し、works 側は更新継続。つまり**上流 RSS フィードの停滞（または RSS 条件付き GET/HWM の固着=仮説・外部検証未実施）を「自システムのデータ破損」として通知**している。同じ run で hourly workflow は成功・構造チェックは全 PASS
- 対処: phase1.md の項目 2 参照（U1 を「射影の正しさ（ci=true）」と「上流鮮度（ci=false WARN）」に分割 + 診断情報出力 + RSS HWM 固着の実データ検証）

**(b) provisional シリーズ（負 seriesId）の過渡状態に猶予がない** — 07-02 19:36 run の 3 FAIL 中 2 件。

- 「値域 サムネ URL」FAIL 例 `-1339667619`、「U3 取りこぼし」FAIL 例 `-394943246, -385264685` = すべて負 ID = 毎時で仮登録され日次で本解決される provisional
- fetch 側には 2〜3 日のグレース期間がある（`fetch.mjs:103-104`）のに ops-health 側は猶予なし。失敗が日次実行（22:30 UTC）直前の 19〜20 時 UTC に集中するパターンとも一致
- 対処: 負 seriesId を U3/値域チェックから除外するか、グレース付き WARN に降格（phase1.md 項目 2）

### 調査結果②: 一覧画面のタグ検索は全シリーズタグを対象にしているか

**結論: はい。一覧の `#タグ` AND フィルタは全話タグの union を対象にしている。**

- 導出: `deriveSeriesTagsFromStore`（`scripts/etl/tags.mjs:116-142`）が**全エピソード**の tags を distinct union → `works.json` の `w.tags`（`project.mjs:113`）
- 照合: `web/src/features/list/filter.ts:107-118` が URL の tags と `w.tags` を両側 NFKC 正規化（`shared/tag-filter.ts normalizeTagForMatch`）で AND マッチ。素のワード検索はタイトルのみ（§87・タグ対象外=設計どおり）

**ただし「union がそのまま残る」わけではない（注意点 4 つ）**:

1. 導出時除外: ノイズタグ（dアニメストア/アニメ/第1話/第一話 `tags.mjs:7`）、キュレーションマーカー正規化（`_dアニメ` 接尾/`dアニメ_` 接頭）
2. **isTitleTag ヒューリスティック**（`tags.mjs:70-78`）: タグ==タイトル or タイトルがタグで始まる（タグ 4 文字以上）→そのシリーズから除外。副作用として「物語シリーズ」のようなフランチャイズ名タグが**タイトルがそれで始まるシリーズからだけ**抜け、フランチャイズ横断のタグ検索が非対称になり得る（→ C16）
3. UI 候補のみの隠蔽: クール由来（`YYYY年<季>アニメ`）・構造タグ（最終回/第N話/#N）はオートコンプリート/チップに出ないが**データには残り、URL 直指定なら照合される**（`shared/tag-filter.ts isHiddenTag`）
4. 鮮度: タグ導出は日次 full のみ（`fetch.mjs:624`）。毎時は永続化済み `s.tags` を carry-forward（欠損なし・更新は翌日次）。snapshot 未到達のエピソード（nvapi seed/RSS のみ）はタグを供給しない
