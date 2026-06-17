# データ取得パイプライン 再設計 Plan（L2）

> 役割: **設計のみ（spec-first）**。本書は実装しない。`dataflow.md` / `db-design.md` の現行設計に対し、
> 2026-06 のデータ痩せ連鎖障害（§G）を踏まえて **真実源・責務分離・cache 戦略・冪等性/耐障害性** を再設計する。
> コード・workflow・data は変更しない。確定後に L3 / gen-code で段階実装する。
>
> 根拠は全て実コードの読解（推測なし）：`.github/workflows/{fetch-hourly,fetch-daily,deploy-pages}.yml` /
> `scripts/fetch.mjs` / `scripts/db/db.mjs` / `scripts/nico/{snapshot,rss,nvapi}.mjs` /
> `scripts/backfill.mjs` / `scripts/export/export.mjs` / 現行 `dataflow.md` `db-design.md` / git log。

---

## 1. 背景・目的

dアニメストア ニコニコ支店（`channelId 2632720`）の静的発見ページ。GitHub Actions の cron で
取得 → ビルド時 SQLite で加工 → 用途別静的 JSON を export → GitHub Pages に配信する。

2026-06、**単一のフラグ更新バグ**が「データ痩せ → cache 縮小ループ → ライブ縮小 → zombie ジョブ
→ 全 cron 凍結」まで連鎖した。暫定復旧は完了（ライブ=6299 series・Fate/Zero 在・回帰ガード有効・cron 停止中）。
本書は **「同じ操作で同じ結果」（CLAUDE.md L0 指針）を満たすデータフロー** を再設計し、

- **新着が壊さず速く出る**（hourly は増分だけ・全体を触らない）
- **全件が痩せない**（真実源が自己汚染しない・回復が高コスト経路に依存しない）
- **失敗が連鎖しない**（zombie/timeout/lock が他ジョブを巻き込まない）

を恒久的に保証する。

---

## 2. 現状アーキテクチャ（実測）

### 2.1 3 つの状態ストアと 2 つのデプロイ経路

| ストア             | 実体                                  | 保持内容                                           | 永続性                                       | 真実源か                             |
| ------------------ | ------------------------------------- | -------------------------------------------------- | -------------------------------------------- | ------------------------------------ |
| **main ブランチ**  | git（6359 data ファイル commit 済み） | `data/*.json` + `data/series/*.json`               | 恒久                                         | 暗黙の真実源（push で Pages へ）     |
| **state ブランチ** | git（orphan）                         | `data/*.json`（**`*.sqlite` 除外**）               | 恒久                                         | 仕様上の真実源（だが DB を持たない） |
| **actions/cache**  | `sqlite-daily-<os>-<run_id>`          | **`build.sqlite`（series_id 紐付けの唯一の住処）** | 揮発（7日無アクセス / 10GB LRU で eviction） | 実質の DB 真実源（だが揮発）         |

デプロイ経路が 2 系統あり、**どちらが「今のライブ」か曖昧**：

- **A) push 経由** `deploy-pages.yml`：main の commit 済み `data/*.json` を Vite が dist に同梱 → Pages。
- **B) cron 経由** `fetch-daily.yml` / `fetch-hourly.yml`：state から JSON 復元 → cache から DB 復元 →
  fetch/export → **直接 `upload-pages-artifact` → `deploy-pages` で Pages へ** → JSON を state に push（main には書かない）。

→ B は main を更新しないため、**A の main commit と B の state/ライブが恒久的に乖離し得る**。

### 2.2 紐付け（series_id）の生成と永続性 — 障害の核心

- snapshot 検索 API の取得フィールドに **series 情報は無い**（`scripts/nico/snapshot.mjs` の `FIELDS`）。
  → `bulkUpsertEpisodes` は新規 contentId を **`series_id = NULL`（孤児）** で挿入。`ON CONFLICT` は
  **series_id / episode_no を更新しない**（既存紐付けは保全するが、新規話は孤児のまま）。
- 孤児話に series_id を与えるのは **nvapi seed（`fetch.mjs` Phase C → `updateEpisodeOrderBatch`）だけ**
  （他に hourly D2 backfill と `backfill.mjs` が一部を補う）。seed は **全 ~6299 series を逐次 nvapi 取得
  （ToS で >=500ms 待機）≈ 85 分** かかる重処理。
- この **高コストな紐付け結果は per-series JSON に既に永続化されている**
  （`export.mjs exportSeries` が各 series ファイルに episode↔series を書き出す）。
  **にもかかわらず、その JSON から DB を再構築する経路が存在しない。**

→ つまり「紐付け」は **揮発する cache（DB）にしか効力を持たず、回復には 85 分の nvapi seed が要る** という
**脆い派生状態**になっている。真実源（JSON）は紐付けを持っているのに使われない。

---

## 3. 障害の構造分析（増幅経路）

### 3.1 連鎖（実コードに基づく機序）

```
[1] フラグバグ：main() が last_full_refresh_at を毎回更新（272fe8463 以前）
        └─ 7日ガード `daysSinceRefresh >= 7` が初回以降ずっと false
            └─ Phase C nvapi seed が恒久 skip
                                │
[2] cache eviction or 痩せ DB restore で build.sqlite が再構築/再投入される
        └─ snapshot が episodes を孤児(series_id=NULL)で再投入
            └─ seed skip のため紐付けが復元されない
                └─ distinct(series_id) = ep>0 件数が 6256 → 1873 に劣化
                                │
[3] 痩せた 1873 DB が actions/cache に保存される
        └─ hourly が save も restore も行い、restore-keys が直近(痩せた hourly)を拾う
            └─ 痩せ DB を source 化 → 痩せ export → deploy → ライブ縮小(Fate/Zero 消失)
                                │
[4] force-seed daily がランナー喪失で zombie 化
        └─ concurrency=state-writer / cancel-in-progress:false でロック保持
            └─ hourly が後ろで永久キュー → 全体凍結（手動 cancel で解除）
```

### 3.2 設計上の弱点（恒久対策の対象）

| #   | 弱点                                   | 説明                                                                                                                                           | 連鎖での役割       |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| W1  | **真実源の曖昧さ**                     | main commit / state / cache の 3 重管理。DB 真実源が「揮発する cache」。仕様(§7)では state が真実源のはずが、DB(=紐付け)は state に無い        | [2] の前提         |
| W2  | **紐付けが脆い派生状態**               | series_id は高コスト nvapi seed でしか復元できず、JSON に在る紐付けを再利用しない                                                              | [2] 増幅           |
| W3  | **フラグの意味の混線**                 | `last_full_refresh_at` が「最後に seed した時刻」と「最後に走った時刻」を兼ねていた                                                            | [1] 起点           |
| W4  | **hourly の責務肥大**                  | 増分のはずが、フル DB を復元し・nvapi backfill し・全 JSON を export し・deploy する＝**全件 blast radius**                                    | [3] 増幅           |
| W5  | **cache 自己フィードバック**           | hourly が save かつ restore-keys で自分の痩せ cache を拾う縮小ループ（6acbd17d2 で部分対処済）                                                 | [3] 起点           |
| W6  | **回復経路が高コスト依存**             | cache 喪失時の唯一の回復が full snapshot + 85分 seed。JSON からの再構築が無い                                                                  | [2] 増幅           |
| W7  | **zombie/lock 耐性なし**               | `cancel-in-progress:false` + 150分 timeout。stuck daily が hourly を巻き込み凍結。lease/heartbeat 無し                                         | [4]                |
| W8  | **回帰ガードが反応的**                 | `detectShrink` は痩せ export を止めるのみ（痩せ自体は防げない）。threshold 0.9 で最大10%の無言縮小を許容。baseline が一度痩せると ratchet down | 最後の砦だが不完全 |
| W9  | **version ゲートと DB 完全性の非結合** | snapshot version 不変なら full fetch skip。だが cache 喪失で DB が痩せても version は一致し得る → 痩せ DB が温存される                         | [2] 助長           |

> 既に入っている良い対策（**活かす**）：`detectShrink` 回帰ガード、空 DB ガード、version ゲート、
> 条件付き GET（RSS 304）、逐次 ToS + 503 バックオフ、daily 専用 cache namespace + hourly restore 専用化、
> seed 実行時のみ `last_full_refresh_at` 更新（272fe8463）。

---

## 4. 設計原則

1. **真実源を 1 つに畳む（Single Source of Truth）**
   - 配信される **JSON（state ブランチ）を唯一の真実源**とする。**DB は派生・再生成可能な中間物**に降格する。
   - cache は **純粋な高速化** であり真実源ではない（喪失しても JSON から完全再構築できる）。

2. **一方向フロー・自己汚染しない（acyclic）**
   - 「真実源 JSON → DB 復元 → 取得/加工 → 新 DB → 検証 → 真実源 JSON 更新」の一方向。
   - **export の source が現真実源より不完全なら、書き戻し/deploy をしない**（縮小は構造的に不可能にする）。

3. **責務と頻度を分離する**
   - **hourly = 増分のみ**：RSS 新着の append。全件を触らず、blast radius を「new.json + 触れた series」に限定。
   - **daily = フル**：snapshot 全件（可変メトリクス）・タグ/クール/franchise 派生・全 export。
   - **seed = 紐付け**：孤児解消。回復には使わず（JSON 再構築が回復経路）、**真に新規/未紐付けの分だけ**実行。

4. **cache 戦略を明文化する**
   - **save は daily のみ**（完全 DB を専用 namespace で）。restore は両者可（**hourly は restore 専用**）。
   - **cache miss 時の安全動作 = 真実源 JSON から DB を再構築**（nvapi 不要）。再構築できない場合のみ export skip。

5. **冪等・回帰ガード・耐 zombie/timeout を既定にする**
   - 全 step 冪等（再実行で重複も縮小もしない）。export 前に **縮小ガード**（W8 を予防型に強化）。
   - lock 保持に **lease/heartbeat と stale 強制解放**、または **増分ジョブを lock から外す**。

---

## 5. 新データフロー

### 5.1 段階図

```
              ┌──────────────── 真実源（state ブランチ・恒久）────────────────┐
              │  data/*.json + data/series/*.json （= 紐付け済みの完全データ）   │
              └───────────────┬──────────────────────────┬───────────────────┘
                  ① restore    │                          │  ⑤ commit（検証通過時のみ）
                              ▼                          │
        ┌─ DB 復元（高速化＋安全網）──────────────┐       │
        │ a. cache hit  → build.sqlite を復元      │       │
        │ b. cache miss → JSON→SQLite importer で  │       │  ← W2/W6 解消：
        │    真実源 JSON から完全 DB を再構築       │       │    紐付けは JSON に在る＝
        │    （nvapi 不要・85分 seed 不要）          │       │    seed 無しで完全復元
        └───────────────┬─────────────────────────┘       │
                        ▼                                  │
        ┌─ 取得・加工（モード別）────────────────────────┐  │
        │ HOURLY: RSS 増分のみ → 新規話を append          │  │
        │         （触れた series だけ部分 export）        │  │
        │ DAILY : snapshot フル + メトリクス + 派生 +      │  │
        │         全 export                               │  │
        │ SEED  : 孤児(series_id NULL)だけ nvapi 紐付け    │  │
        └───────────────┬─────────────────────────────────┘  │
                        ▼                                     │
        ┌─ 検証ゲート（縮小予防）──────────────────────┐      │
        │ ・schema/件数アサート                         │      │
        │ ・detectShrink（予防型・§6.5）                │      │
        │  → 不合格なら export/commit/deploy を全 skip   │──────┘（書き戻さない）
        └───────────────┬─────────────────────────────┘
                        ▼ 合格時のみ
              data/*.json 更新 → state へ commit → Pages へ単一経路 deploy
```

### 5.2 ジョブ責務マトリクス

| 観点            | hourly（増分）                                                           | daily（フル）                           | seed（紐付け・必要時）                                    |
| --------------- | ------------------------------------------------------------------------ | --------------------------------------- | --------------------------------------------------------- |
| 頻度            | 毎時                                                                     | 日次（JST 05:00）                       | daily 内で **条件付き**（孤児あり / 週次 / `force_seed`） |
| 取得源          | RSS page1（条件付き GET）                                                | snapshot 全件 + list/programlist/period | nvapi v2/series（孤児 series のみ）                       |
| DB への作用     | 新規話 append のみ                                                       | 全話 upsert（prev 退避）+ 派生再計算    | 孤児に series_id/episode_no 付与                          |
| export 範囲     | **触れた series + new.json のみ**（全 works/ranking を毎時再書きしない） | 全 JSON                                 | （daily の export に従う）                                |
| deploy          | 新規話があるときだけ                                                     | 毎回（検証通過時）                      | （daily に従う）                                          |
| blast radius    | 新着のみ（**全件を縮小し得ない**）                                       | 全件                                    | 紐付けのみ                                                |
| cache           | **restore 専用**（save しない）                                          | restore + **save（完全 DB）**           | （daily に従う）                                          |
| state へ commit | 触れた分のみ                                                             | 全 data                                 | （daily に従う）                                          |

### 5.3 個別設計判断

#### (a) 真実源 ＝ JSON。DB は再構築可能な中間物（W1/W2/W6）

- **JSON→SQLite importer を新設**（中心施策）。`data/series/*.json` は各話の
  `contentId / episodeNo / series` 紐付けを既に保持しているため、**nvapi 無しで完全 DB を決定的に再構築**できる。
  works.json / ランキング等の集計列は再計算（既存 `recalcSeriesMetrics` 等）で復元。
- これにより **cache eviction は無害**（JSON から再構築）、**seed は回復目的では不要**（新規紐付け専用）になる。
- 代替案（却下）：build.sqlite を state/専用 orphan ブランチ/LFS に永続化。実現可能だが、
  **真実源を二重化（JSON と DB）** して W1 を温存する。importer の方が真実源を 1 本化できるため採用。

#### (b) hourly の脱・全件化（W4/W5）

- hourly は **export を全件再生成しない**：RSS で挿入した series と `new.json` だけ部分 export。
  → 仮に hourly が壊れても works/ranking/全 series を縮小し得ない（構造的縮小不能）。
- cache は **restore 専用継続**（save は daily のみ）。restore-keys が痩せ hourly を拾う経路を恒久封鎖。
- 既存の「空 DB ガード」「`.deploy-needed` で新規時のみ deploy」は維持。

#### (c) seed の意味分離（W3）

- メタを **「seed 完了時刻」と「孤児件数」に分離**。seed のトリガは
  「**孤児(series_id NULL かつ branch)が存在する** OR 週次経過 OR `force_seed`」。
  時刻フラグ単独の gate をやめ、**実際の未紐付けという観測量**で駆動する（フラグ事故が起きても孤児が在れば必ず治る）。
- importer 導入後、フル DB は常に紐付け済みで起動するため、**seed は新規 series/新規話の差分のみ**＝短時間化。

#### (d) cache 戦略の確定（W5/W9）

- key：daily が `sqlite-daily-<os>-<run_id>` で save、restore-keys `sqlite-daily-<os>-`（現行踏襲）。
- **cache と DB 完全性の結合**：restore 後に **完全性チェック**（series 件数・ep>0 件数を JSON baseline と照合）。
  痩せていれば cache を捨てて **(a) importer で JSON から再構築**。
  → version ゲートが「version 不変だから skip」しても、DB が痩せていれば再構築が走る（W9 解消）。

#### (e) 検証ゲートを予防型に（W8）

- `detectShrink` を **export 前の必須ゲート**として全モードに適用（既存ロジック活用）。
- baseline ratchet-down 対策：baseline は **「state の現行 works.json」固定**（自分が今書こうとしている DB ではなく、
  確定済み真実源と比較）。threshold は維持しつつ、**0.9 を割ったら fail（warn でなく）**＝痩せを公開しない。
- 縮小検知時の動作を統一：**export/commit/deploy を全 skip し、真実源を保全**（hourly/daily 共通）。

#### (f) 耐 zombie / timeout / concurrency（W7）

- **増分（hourly）を state-writer lock の巻き添えから外す**案を軸に検討：
  - 案1（推奨）：lock を **「state への commit/push 区間だけ」に最小化**し、取得/加工は lock 外。
    commit は秒オーダなので zombie が長時間ロックを保持し得ない。
  - 案2：hourly と daily を **別 concurrency group** にし、state commit の競合のみ
    「commit 前に `git pull --rebase` で直列マージ」する楽観ロックにする。
- **stale lock 強制解放**：実行開始時刻を記録し、`timeout-minutes` 超過 or ハートビート途絶のジョブは
  後続が安全に reclaim できるようにする（GH の workflow run 監視 + 古い run の明示 cancel ステップ）。
- daily timeout 150分は **seed 短縮（c 項）後に圧縮**（フル DB が紐付け済み起動なら force_seed の 85 分は例外時のみ）。

---

## 6. 移行手順（段階的・稼働中 cron / #21 に触れない）

> 原則：**ライブ（6299・安全状態）を壊さない**。各段は単独でロールバック可能。cron 再開は最終段で。

| 段  | 作業                                                                      | 完了条件（受け入れ）                                                 | リスク低減                     |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------ |
| M0  | 本 Plan 確定（L2）→ L3 フェーズ化                                         | 受け入れ条件が L3 に落ちている                                       | 設計のみ・無変更               |
| M1  | **JSON→SQLite importer 実装**（§5.3a）＋単体テスト                        | ローカルで state の JSON から再構築した DB が ep>0=6299 を再現。冪等 | コード追加のみ・cron 無変更    |
| M2  | **DB 復元 step に完全性チェック＋importer フォールバック**を組込（§5.3d） | cache 破棄シナリオで importer 経由復元を確認                         | dry-run / 手動 dispatch で検証 |
| M3  | **hourly 部分 export 化**（§5.3b）＋検証ゲート予防型（§5.3e）             | hourly が works/ranking 全体を書き換えないことをログ/diff で確認     | restore 専用は現状維持で安全   |
| M4  | **seed トリガを孤児観測駆動に**（§5.3c）＋メタ分離                        | 孤児を人為注入 → 次回 daily で自動解消を確認                         | force_seed 退避路は残す        |
| M5  | **concurrency/timeout の耐 zombie 化**（§5.3f）                           | 模擬 stuck run が後続を凍結しないことを確認                          | 段階適用・lock 区間最小化から  |
| M6  | **デプロイ経路の一本化**（§2.1 A/B の統合方針を決定）                     | ライブの出所が単一・main と state の乖離が解消                       | 最後に実施（影響最大）         |
| M7  | cron 再開（hourly → daily の順で観測再開）                                | 24h 観測で痩せ・churn・zombie 無し                                   | ガード有効下で再開             |

> 注：#21 と現行 cron 設定（disabled）には本 Plan では触れない。M7 で安全確認後に別途 GO 判断。

---

## 7. 検証方法

- **再構築等価性**：state の JSON → importer → DB → 再 export した JSON が、元 JSON と
  （集計の浮動小数を除き）一致すること。`ep>0 distinct series == 6299`。
- **縮小不能性（ファズ）**：cache を空/痩せ/破損で与えても、最終 export の ep>0 が baseline×0.9 を割らない
  （割る入力では export/deploy が skip される）こと。
- **hourly blast radius**：hourly 実行前後で `works.json` / `ranking.json` の
  非新着部分が**バイト不変**であること（部分 export の証明）。
- **seed 自己治癒**：孤児を N 件人為作成 → 次 daily 後に孤児 0 へ収束すること（フラグに依存しない）。
- **耐 zombie**：daily を強制 stuck（sleep）させても hourly が時間内に完走すること（lock 巻き添えなし）。
- **冪等**：同一入力で 2 回連続実行し、state diff が 2 回目に空であること。
- 既存の **schema/件数アサート**（`Assert data files exist` 等）と CSP/ビルド健全性は維持。

---

## 8. 却下した代替案

| 案                                  | 却下理由                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| build.sqlite を state/LFS に永続化  | 真実源を JSON と DB に二重化し W1 を温存。importer による一本化が上位互換           |
| seed を毎回フル実行（gate 撤廃）    | ToS 上 85 分/回の nvapi 負荷を毎日課す。importer で回復が賄えるので不要             |
| 回帰ガードの threshold 引き上げのみ | 反応的対症療法。真実源の脆さ（W1/W2/W6）が残り再発する                              |
| hourly を廃止し daily だけにする    | 新着鮮度（毎時）を失う＝L0「新着が速く出る」に反する                                |
| cancel-in-progress:true             | 実行中ジョブを殺すと書き込み途中で状態を割る恐れ。lock 区間最小化＋楽観マージが安全 |

---

## 付記：本 Plan が断ち切る連鎖（§3.1 との対応）

- [1] フラグ → **(c) 観測量駆動**で「孤児が在れば必ず治る」ため起点を無力化。
- [2] cache 喪失で痩せ → **(a) importer**で JSON から完全復元＝痩せが発生しない。
- [3] cache 縮小ループ → **(b) hourly restore 専用 + 部分 export**で構造的に縮小不能。
- [4] zombie 凍結 → **(f) lock 最小化 + stale 解放**で巻き添え遮断。
