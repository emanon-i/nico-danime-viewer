# 改善計画（リポジトリ全体分析）

作成日: 2026-07-03。リポジトリ全体（scripts / web / tests / CI / docs）を読み、今後の開発速度・保守性・品質を上げるための改善課題を優先順位つきで整理したもの。

- 段階別の実行計画: [phase1.md](phase1.md)（低リスク高効果）→ [phase2.md](phase2.md)（設計整理）→ [phase3.md](phase3.md)（中長期）
- 各 phase ファイルに項目ごとの「対象ファイル・変更方針・受け入れ条件・検証方法」を記載

---

## 1. リポジトリ全体の理解

**目的**: dアニメストア ニコニコ支店（`channelId 2632720`）専用の非公式発見 UI。ニコニコ公開 API（snapshot 検索 / nvapi series / チャンネル RSS / 静的 JSON）からデータを取得し、静的 JSON に射影して GitHub Pages で配信。視聴は公式プレイヤーへの deep-link のみ。

**技術スタック**: データ層 = Node.js ESM `.mjs`（JSDoc 型・runtime 検証なし。**tsconfig の include は web/tests のみで scripts/ は `pnpm typecheck` の対象外**=JSDoc は実質未検査 → C20）、フロント = Vanilla TypeScript + Vite（フレームワークなし）、テスト = Vitest（39 ファイル / 約 6,400 行）、CI = GitHub Actions（cron fetch + Pages deploy）、pnpm（**`packageManager` 未ピン** → C29）。

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
- **第2回レビューで健全と確認**: style.css（3103 行だが `@layer` + デザイントークンで規律あり）、タイムゾーン処理（cours はタグ文字列パース・時刻比較は epoch で TZ 非依存）、メモリ（daily の 4GB 設定に対しピーク実測見積 約1GB で余裕）、logger 使用の一貫性、tooltip/disclosure/search/tag-autocomplete のリスナーライフサイクル、deeplink の入力検証（`^so\d+$`）

### 危うい点

- **prevViewCounter が upsert のたびに無条件クロバー**（`scripts/store/store.mjs:520-521`）— 1 run 内で同一エピソードが 2 回 upsert されると（B3 seed → A2 rescue → B6 verify の経路が再 upsert し得る）、その日の delta（Hot ランキングの核）が静かに消える。経路重複の頻度は未計測（仮説）だが機構は確認済み
- **複数ファイル永続化に横断的原子性がない**: 個々の書き込みは tmp+rename で原子的だが、`writeBackStore` → `projectAll` の 2 段（`fetch.mjs:704-705`）の間でクラッシュすると prev-views だけ進み delta が恒久喪失。provisional series の `unlinkSync`（`fetch.mjs:311,553`）も同種
- **リトライは 503 のみ**（`lib/http.mjs:42-51`）。snapshot の 1 年窓が 500/429 で落ちると日次全体が中断（`nico/snapshot.mjs:67-68`）
- **drop-rate ガードが死んでいる**: `assertSnapshotOk` に `previousTotalCount=null` を渡している（`fetch.mjs:367`）ため `nico/assert.mjs:64-73` は永久に発火しない
- **web のリスナー/オブザーバ蓄積リーク 2 件**（C17）: `marquee.ts:99,176` の `window.addEventListener('pointerup', ...)` が解除されず、`top.ts:303-311` の IntersectionObserver が disconnect されない。`app.innerHTML=''` 再レンダーモデルのため Top 画面訪問のたびに単調増加
- **データロードが全滅型・無通知**（C18）: `main.ts:136` の `Promise.all` は 5 ファイル中 1 つの失敗で全体 reject → 空 catch（`main.ts:151-153`）。エラー表示もリトライ UI もなく全画面ブランク
- **provisional ID（32bit djb2）の衝突検知なし**（C24）: `list.mjs:284-288`。衝突すると別作品のエピソードが同一負 ID に混ざる（静かな破損・確率は現状約 0.05% だが二次関数的に増加）
- **franchise union-find の誤結合が推移的に伝染**（C25）: `series.mjs:113-126` の titleStem が `~` で貪欲カット、`/シリーズ$/` タグエッジが無条件（`:218`）

### すぐ問題になる点

- **CI に品質ゲートが皆無**: 約 6,400 行のテスト・lint・typecheck・build 検証が**どのワークフローでも実行されていない**。壊れたコードが main に入りそのまま deploy される
- **ops-health が誤報中**: 直近 15 run 中 7 失敗。判定基準の設計問題 2 件が原因（→ §6 調査結果①）
- **AGENTS.md が実装と矛盾**: dev/build「雛形（未実装）」表記（実際は稼働中）、「生成物はコミットしない」と実態（公開 JSON 6 本コミット済み）の食い違い。エージェント駆動開発の正本が古いのは判断ミスを直接誘発
- **集計ロジックの二重実装**: `buildEpAggMap`（`project.mjs:44-93`）と `exportWorksPartial` 内（`project.mjs:352-392`）が同一の totalViews/latestAt/firstAt/so 番号タイブレークを重複実装。「毎時とパリティ必須」とコメントで明記されたドリフト・トラップ
- **`.deploy-needed` センチネルの取り扱い非対称**（C21）: daily の state 保存 rsync だけ exclude し忘れ（`fetch-daily.yml:165` vs `fetch-hourly.yml:135`）+ fetch.mjs は残存センチネルを unlink しない → **daily 後の最初の hourly が「新規 0 件」でも毎日 1 回必ず無駄デプロイ**（churn 対策ゲートの自己敗北）
- **`.claude/skills/` と `.agents/skills/` が実際には非同期**（C22）: AGENTS.md は「同一内容の複製」と言うが、prettier（`trailingComma: es5`）が `.agents` 側 SKILL.md の json コードフェンス内に**不正な末尾カンマを注入済み**（現に壊れている）。原因は eslint が `.claude/**` のみ ignore という非対称。同期を保証する仕組みがない
- **`packageManager` 未ピン**（C29）: CI は pnpm 9.x フロート、ローカルは 10.x が入り得る。pnpm 10 で `pnpm install` すると lockfile が書き換わり CI の `--frozen-lockfile` が落ちる導線

### 将来ボトルネックになりそうな点

- **works.json 18MB を main にコミット**: clone 肥大 + フロントは全量 fetch してメモリ保持 + 毎 render で全配列 clone-sort（`web/src/features/list/filter.ts:175` ほか）
- **神モジュール**: store.mjs（I/O+CRUD+話数パーサ 110 行混在）、fetch.mjs（rescue/reconciliation アルゴリズム内蔵・未 export=単体テスト不能）、list.ts の renderList（約 590 行の単一関数）、main.ts render()（約 330 行）
- **O(series×episodes) の全走査**: `_getEpisodesForSeriesSorted`（`store.mjs:1075-1081`）がシリーズ毎に全エピソードを走査。約 6,700 シリーズで二次コスト
- **データ契約が片側のみ**: `web/src/data/types.ts` は「正本」を名乗るが生成側 `.mjs` は型なし、loader のガードはトップレベルのみ（`loader.ts:17-20`）。契約ドリフトは実行時 undefined 伝播で発覚する構造
- **設定の分散**: チャンネル ID が数値 `2632720`（`nico/filter.mjs:4`）/ 文字列 `'ch2632720'`（`nico/nvapi.mjs:14`）/ RSS URL 直書き（`nico/rss.mjs:7`）の 3 形態。閾値・URL・実測フロア（`ops-health.mjs:34-56`）が 10 ファイル超に散在
- **web の状態モデル不統一**: fav は URL、want/watched/showEmpty はモジュールグローバル `let`（`main.ts:69-73`）。同種フィルタでリロード時挙動が異なる
- **credits.mjs（857 行の正規表現パイプライン）**: 直近コミット履歴がノイズ除去の反復修正で占められる=最も品質コストの高い領域。export は 2 関数のみで内部はE2E経由でしかテスト不能。**「残N件根治」が再発する根本原因**（C26）: `entryToTags` が順序非可換な 17 段の文字列変換パイプライン（コメント自身が「順序が重要」と明記）+ 実在文字列を焼き込んだ denylist/魔法定数 + **ゴールデンコーパス皆無**（tests/ に fixture JSON がゼロ）＝修正のたびに過去ケースの回帰を証明する held-out セットがない
- **scripts/ 全体が型検査の圏外**（C20）: `tsconfig.json` の include は `web/src`・`tests`・vite/vitest config のみ。`checkJs`/`allowJs` なし。最も複雑で最もテストが薄い層（約 5,600 行）に型検査もない。eslint も最弱ティア（`recommended`・type-checked なし）
- **決定性が「ソート済みロード」という大域不変量に暗黙依存**（C23）: `tags.json`（`project.mjs:206`）・`hotTop20/popularTop20`（`:211-224`）・`new.json`（`:300`）のソートに明示タイブレークがなく、同点は Store 挿入順=ロード順（`store.mjs:134` のファイル名ソート）で決まる。ロード方式を変えた瞬間に「決定的ビルド」が壊れる
- **LICENSE 不在 + 再配布方針の矛盾**（C28）: L1 `vision.md:43`「取得結果を再配布しない（生成 JSON は git 管理外）」・L2 `foundation.md:65,121` と、public repo に 18MB works.json がコミットされている実態が矛盾（法的衛生の観点でも要方針決定）

## 3. 改善候補一覧

| #   | テーマ                       | 問題                                                                                                                                                                                                              | 根拠                                                                 | 放置リスク                                                  | 効果                         | 難易度         | 破壊リスク                     | 優先度                 |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------- | -------------- | ------------------------------ | ---------------------- |
| C1  | PR/push CI ゲート            | test/lint/typecheck/build が全ワークフロー未実行                                                                                                                                                                  | `.github/workflows/` 全検索                                          | 退行が main 直行→本番 deploy                                | 全テスト資産が即ゲート化     | 低             | なし                           | **最高**               |
| C15 | ops-health 判定基準修正      | U1 の意味論混同・provisional に猶予なし（§6 参照）                                                                                                                                                                | 失敗ログ + `ops-health.mjs:414-472`                                  | 誤報でアラート疲れ→本物を見逃す                             | 監視の信頼回復               | 低〜中         | 低                             | **最高**（現に誤報中） |
| C3  | AGENTS.md/README 現行化      | dev/build「未実装」表記・データコミット方針の矛盾                                                                                                                                                                 | AGENTS.md:14-15,25 vs 実装                                           | エージェント/新規開発者の判断ミス                           | オンボード・エージェント精度 | 低             | なし                           | 高                     |
| C2  | prevViewCounter クロバー修正 | run 内再 upsert で delta 消失                                                                                                                                                                                     | `store.mjs:520-521`                                                  | Hot ランキングの静かな劣化                                  | データ正しさの根幹保護       | 低〜中         | 低                             | 高                     |
| C5  | 設定/定数の一元化            | チャンネル ID 3 形態・閾値散在                                                                                                                                                                                    | `filter.mjs:4`/`nvapi.mjs:14`/`rss.mjs:7` ほか                       | 変更漏れ・値の不整合                                        | 変更コスト減・暗黙知可視化   | 低             | 低                             | 高                     |
| C6  | 集計 reducer 一本化          | 日次/毎時で同一集計を二重実装                                                                                                                                                                                     | `project.mjs:44-93` vs `352-392`                                     | 日次と毎時で数値ドリフト                                    | パリティを構造で保証         | 低〜中         | 低（テスト有）                 | 高                     |
| C4  | 永続化トランザクション化     | writeBackStore→projectAll 間クラッシュで torn state                                                                                                                                                               | `fetch.mjs:704-705`, `store.mjs:329-406`                             | まれだが復旧不能なデータ破損                                | クラッシュ耐性               | 中             | 低                             | 高（Phase 2 先頭）     |
| C7  | リトライ一般化+窓単位許容    | 503 のみリトライ・1 窓失敗で日次全断                                                                                                                                                                              | `http.mjs:42-51`, `snapshot.mjs:67`                                  | 一過性障害で日次欠損が常態化                                | 運用安定性                   | 中             | 低                             | 中〜高                 |
| C8  | 神モジュール分割（scripts）  | 話数パーサ・rescue/reconciliation がテスト圏外                                                                                                                                                                    | `store.mjs:944-1055`, `fetch.mjs:175-318,480-562`                    | 最重要ロジックが未テスト                                    | テスト可能化                 | 中             | 中（移動のみなら低）           | 中                     |
| C9  | データ契約の共有・深い検証   | 生成側型なし・loader は要素未検証                                                                                                                                                                                 | `types.ts`, `loader.ts:17-20`                                        | スキーマ変更時の静かな破損                                  | 契約同期の機械化             | 中             | 低                             | 中                     |
| C10 | web 状態統一+render 分割     | fav=URL / want=グローバル let の不整合、god 関数                                                                                                                                                                  | `main.ts:69-73,388,554-563`, `list.ts:313-899`                       | UI 機能追加のたびに複雑化                                   | フロント開発速度             | 中〜高         | 中                             | 中                     |
| C11 | 性能（二次走査・clone-sort） | シリーズ毎全走査・キー操作毎の全 sort                                                                                                                                                                             | `store.mjs:1075-1081`, `filter.ts:175-248`                           | データ増で劣化                                              | 実測後で足りる               | 中             | 低                             | 中〜低                 |
| C12 | works.json 18MB 戦略         | main 肥大・フロント全量ロード                                                                                                                                                                                     | `git ls-files data/`                                                 | clone/CI 遅延の漸増                                         | リポジトリ健全性             | 中〜高         | 中（運用変更）                 | 低〜中                 |
| C13 | 細部の頑健性                 | localStorage quota 未処理（`user-state.ts:22-24`）・未使用 sanitize 層・死んだ drop-rate assert（`fetch.mjs:367`）・重複 util（`ms`/`soNum` が main.ts と filter.ts に重複、`normalizeTitleForMatch` 同名別実装） | 各所                                                                 | 個別は小さいが蓄積                                          | 低コスト解消                 | 低             | なし                           | 低〜中                 |
| C14 | カバレッジ計測導入           | 実カバレッジなし（docs/coverage.json は traceability map で別物）                                                                                                                                                 | `package.json:16`                                                    | テスト空白の不可視                                          | 空白の可視化                 | 低             | なし                           | 中                     |
| C16 | タグ品質                     | isTitleTag のフランチャイズ名非対称（§6 調査結果②）・タグ意味論が暗黙知                                                                                                                                           | `etl/tags.mjs:70-78`                                                 | フランチャイズ横断検索の取り逃し                            | 発見性向上                   | 低〜中         | 中（タグ増減）                 | 低〜中                 |
| C17 | web リーク修正               | marquee の window リスナー未解除 ×2・Top の IntersectionObserver 未 disconnect（再レンダー毎に蓄積）                                                                                                              | `marquee.ts:99,176`, `top.ts:303-311`                                | 長時間セッションでメモリ/リスナー単調増加                   | 2 箇所の小修正で完治         | 低             | なし                           | 高（quick-win）        |
| C18 | データロードの部分失敗耐性   | `Promise.all` 全滅型 + 空 catch（エラー表示・リトライ UI なし）                                                                                                                                                   | `main.ts:136,151-153`                                                | 副次ファイル 1 つの 404 で全画面ブランク                    | 障害時も works だけで動く    | 低〜中         | 低                             | 高                     |
| C19 | スクロール管理               | `scrollRestoration` 未設定・navigate で scrollTo なし・popstate 復元が async render 前に発火                                                                                                                      | `main.ts:306-310,694`                                                | 遷移のたびに位置が不自然（UX）                              | 予測どおりに動く（L0 準拠）  | 低〜中         | 低                             | 中                     |
| C20 | scripts の型検査導入         | tsconfig include が web/tests のみ＝データ層 5,600 行が typecheck 圏外（JSDoc は装飾）                                                                                                                            | `tsconfig.json` include                                              | 最複雑層の契約が誰にも守られない                            | 既存 JSDoc 資産が即戦力化    | 中             | 低                             | 高                     |
| C21 | .deploy-needed 整合          | daily rsync が exclude し忘れ＋残存 unlink なし → 毎日 1 回の無駄デプロイ                                                                                                                                         | `fetch-daily.yml:165` vs `fetch-hourly.yml:135`, `fetch.mjs:714,917` | churn 対策の自己敗北・hourly のメトリクス更新未配信と非対称 | 1 行修正＋方針明文化         | 低             | なし                           | 高（quick-win）        |
| C22 | skills 複製の同期保証        | `.agents` 側 SKILL.md の json 例が prettier で破損済み・同期機構なし                                                                                                                                              | `.agents/skills/` vs `.claude/skills/`, `eslint.config.js` ignores   | エージェントが壊れた/古い手順を読む                         | 同一性テストで恒久化         | 低             | なし                           | 高（quick-win）        |
| C23 | 決定性のローカル化           | tags/new/hotTop20 のソートに明示タイブレークなし（ロード順依存）                                                                                                                                                  | `project.mjs:206,211-224,300`                                        | ロード方式変更で「決定的ビルド」が静かに壊れる              | 決定性が局所保証に           | 低             | 低（出力 diff ゼロ確認）       | 中                     |
| C24 | provisional ID 衝突検知      | 32bit djb2 に衝突チェックなし＝衝突時は別作品のエピソードが混線                                                                                                                                                   | `list.mjs:284-288`                                                   | 低確率だが検出不能な静かな破損                              | 検知＋回避で封じる           | 低             | 低                             | 中                     |
| C25 | franchise 導出の抑制         | titleStem の `~` 貪欲カット・`/シリーズ$/` エッジ無条件・union-find で誤結合が伝染                                                                                                                                | `series.mjs:113-126,204,218,238`                                     | 無関係作品が「関連シリーズ」に混入                          | 発見 UI の信頼性             | 中             | 中（franchise 変動）           | 中                     |
| C26 | credits ゴールデンコーパス   | 順序非可換 17 段パイプライン＋fixture ゼロ＝「残N件根治」が構造的に再発                                                                                                                                           | `credits.mjs:564-646,315-355`, tests に fixture JSON なし            | 修正のたびに過去ケースが回帰し得る                          | 回帰を機械証明できる         | 中             | 低（まず現状スナップショット） | 高                     |
| C27 | docs ドリフト解消            | dataflow.md に credits 未記載・フラット §NN（§20〜§94）が未解決参照・日付付き実測値の腐り                                                                                                                         | `dataflow.md:303-322,374-384`、コード中 §NN 多数                     | 仕様と実装の乖離が拡大・オンボード阻害                      | 正本性の回復                 | 低〜中         | なし                           | 中                     |
| C28 | LICENSE/再配布方針           | LICENSE なし + L1/L2「再配布しない」と committed 18MB JSON の矛盾                                                                                                                                                 | `vision.md:43`, `foundation.md:65,121`, `git ls-files data/`         | 法的衛生・方針の宙吊り                                      | 方針確定（要ユーザー判断）   | 低（決めれば） | 中（b 案は運用変更）           | 中                     |
| C29 | packageManager ピン          | CI=pnpm 9.x フロート / ローカル 10.x 可 → lockfile 書き換え事故導線                                                                                                                                               | `package.json`（フィールドなし）, workflows `version: 9`             | contributor の install で CI 赤                             | 1 行で恒久解消               | 低             | なし                           | 高（quick-win）        |

## 4. 優先順位トップ5

（第2回レビュー反映版）

1. **C1: PR/push CI ゲート追加** — 最小工数で最大の退行防止。他のすべての改善の安全網になるため必ず最初。
2. **C15: ops-health 判定基準修正** — 現在進行形の誤報を止める。誤報が続くと「失敗通知は無視してよい」が常態化し、本物の障害を見逃す。
3. **C2: prevViewCounter クロバー修正** — 中核指標（Hot）の静かなデータ破損。C1 のゲート下で回帰テストを書いて直す。C4 より先なのは、こちらは毎 run 発生し得るのに対し C4 はクラッシュ時のみのため。
4. **quick-wins バンドル（C21 + C29 + C17 + C22 の破損修正）** — rsync exclude 1 行・packageManager 1 行・リーク 2 箇所・壊れた JSON 修正。いずれも数分〜数十分の修正で、現に起きている実害（毎日の無駄デプロイ / lockfile 事故導線 / メモリリーク / 壊れたスキル文書）を止める。
5. **C20: scripts 型検査の段階導入開始** — 最複雑・最重要層に検査ゼロという最大の静かなギャップ。JSDoc `@typedef` 資産が既にあるため、`checkJs` を小さいモジュールから有効化するだけで効き始める。

C3（AGENTS.md 現行化）と C5（設定一元化）は前回トップ 5 から Phase 1/2 の項目として継続（重要性は不変。上記 4・5 は「現に起きている実害」「最大の構造ギャップ」を優先した結果の入れ替え）。

## 5. 推奨改善ロードマップ

- **Phase 1**（[phase1.md](phase1.md)）: CI ゲート → ops-health 修正 → quick-wins（C21/C29/C17/C22）→ ドキュメント現行化 → prevViewCounter 修正 → データロード耐性（C18）→ 死んだ assert 整理 → 小物（quota/sanitize/重複 util/stripHtml/import 無音失敗）
- **Phase 2**（[phase2.md](phase2.md)）: config 一元化 → 集計 reducer 一本化 → 永続化トランザクション化 → scripts 型検査導入（C20）→ 決定性タイブレーク（C23）→ provisional 衝突検知（C24）→ 神モジュール分割 → リトライ一般化
- **Phase 3**（[phase3.md](phase3.md)）: credits ゴールデンコーパス（C26・先頭に昇格）→ データ契約の機械化 → web 状態統一と render 分割（スクロール管理 C19 含む）→ franchise 抑制（C25）→ 性能 → works.json 戦略/LICENSE 方針（C12+C28）→ カバレッジ・テスト衛生 → タグ品質 → docs ドリフト解消（C27）

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

**union と候補表示の境界（C16 修正後）**:

1. 導出時除外: ノイズタグ（dアニメストア/アニメ/第1話/第一話 `tags.mjs:7`）、キュレーションマーカー正規化（`_dアニメ` 接尾/`dアニメ_` 接頭）
2. 作品名タグ: 検索対象の union には残す。`isTitleTag` は候補辞書の整理だけに使い、単独作品だけの作品名タグを候補から隠し、2作品以上で共有するタグは残す
3. NFKC 集約: `tags.json` は NFKC key ごとに同一シリーズを1回だけ数える。`works.tags` は表示元の表記を保持し、一覧照合時に同じ NFKC 規則で一致させる
4. UI 候補のみの隠蔽: クール由来（`YYYY年<季>アニメ`）・構造タグ（最終回/第N話/#N）はオートコンプリート/チップに出ないが**データには残り、URL 直指定なら照合される**（`shared/tag-filter.ts isHiddenTag`）
5. 鮮度: タグ導出は日次 full のみ。毎時は永続化済み `s.tags` を carry-forward（欠損なし・更新は翌日次）。snapshot 未到達のエピソード（nvapi seed/RSS のみ）はタグを供給しない

### 調査結果③: 第2回全体レビュー（2026-07-03・前回の空白領域の深掘り）

前回カバーが薄かった領域（web の components/CSS/リスナーライフサイクル、credits.mjs 内部、docs L0〜L2 整合、ワークフロー細部、ツールチェーン設定）を 3 並列で調査。主要な断定は実コードで裏取り済み。

**新発見（→ C17〜C29 として §3 に登録）**:

| 領域           | 発見                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ツールチェーン | scripts/ が typecheck 圏外（C20）・packageManager 未ピン（C29）・eslint 最弱ティア                                                                                                                                  |
| 運用           | `.deploy-needed` の daily rsync exclude 漏れ＝毎日 1 回の無駄デプロイ（C21）・deploy-pages の state 復元無音失敗（series 欠落でも main の committed JSON で assert が緑になり得る）                                 |
| web            | marquee/Top のリスナー・オブザーバ蓄積リーク（C17）・データロード全滅型＋無通知（C18）・スクロール管理なし（C19）・settings インポート無音失敗・フォント（IBM Plex Sans JP フル 3 ウェイト）が最重量アセット        |
| データ導出     | 決定性がロード順に暗黙依存（C23）・provisional ID 衝突検知なし（C24）・franchise union-find の誤結合伝染（C25）・stripHtml の 16 進実体/astral 未対応                                                               |
| credits        | 「残N件根治」再発の根本原因＝順序非可換 17 段パイプライン＋ゴールデンコーパス皆無（C26）・credit-index の 4 export 中 3 つ未テスト・先頭話探索ロジックが 4 箇所に重複                                               |
| docs           | dataflow.md に credits パイプライン未記載・フラット §NN（§20〜§94）が未解決参照・LICENSE 不在と L1/L2「再配布しない」の矛盾（C27/C28）・skills 複製が現に非同期＋JSON 破損（C22）                                   |
| テスト         | smoke（1+1=2）/structure（beforeAll で自己修復する存在チェック）は無信号・e2e.test.ts は実態コンポーネントスモーク（fetch パイプラインの統合テストは不在）・playwright はスクショ専用なのに全 install でブラウザ DL |

**健全と確認（対処不要）**: style.css の構造（`@layer` + トークン）、タイムゾーン処理、メモリ余裕（4GB 設定に対しピーク約 1GB）、logger 一貫性、tooltip/disclosure/search/tag-autocomplete のライフサイクル、deeplink の入力検証。
