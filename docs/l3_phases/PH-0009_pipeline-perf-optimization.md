# PH-0009: パイプライン実行時間の最適化（ToS・整合を守ったまま削る）

## 目的

PH-0008（脱SQLite・純JSON＋メモリJS ETL）で本番稼働している取得パイプライン（daily / hourly）の
**実行時間を、ToS（取得層無改修・逐次・≥500ms・UA・503バックオフ）と データ整合（孤児を残さない・痩せない・
予防ガード）を一切崩さずに短縮する**。

- 本書は **分析（実コード＋実 run ログの実測）に基づく L3 最適化 Plan**。**本フェーズでは実装しない**（spec-first）。
- **API 負荷を上げる案（並列化・レート上げ・リクエスト増）は全て対象外**。狙いは「同じ取得負荷のまま、待ち時間・処理時間・無駄取得を削る」。
- 前提：取得層 `scripts/nico/{snapshot,rss,nvapi,list,period}.mjs`・`scripts/lib/http.mjs` は **無改修**（リクエスト数・間隔・UA は不変）。

---

## §0. 制約（破ってはいけない前提）

| 制約                                                                                  | 根拠                                                                                                                                       | 本 Plan での扱い                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| snapshot/nvapi/period は **逐次・前回応答時間ぶん待機（≥500ms）・UA・503=5分backoff** | `scripts/lib/http.mjs` `fetchWithToS`＝`await sleep(Math.max(_lastResponseMs, 500))`。SKILL.md L17「前回レスポンスにかかった時間ぶん待つ」 | **取得層は一切触らない**。短縮は「取得回数を減らす」「取得以外を速くする」のみ |
| snapshot `_limit` 上限 **100**・`_offset` 上限 100000                                 | SKILL.md L50-51（公式ガイド）                                                                                                              | ページ当たり件数は増やせない＝**snapshot のリクエスト数は固定**                |
| API 負荷を増やさない（前回障害の文脈・安全最優先）                                    | 運用方針                                                                                                                                   | 並列取得・レート上げ・差分なし全件再取得は **却下**                            |
| データ整合（孤児を残さない・痩せない・予防ガード）                                    | PH-0008 §0-6 invariant・`detectShrink`                                                                                                     | 全施策が detectShrink/件数アサートを通過した上でのみ writeBack                 |
| 出力契約（`web/src/data/types.ts`）不変                                               | PH-0008 §B-2                                                                                                                               | JSON の **値・スキーマは不変**（空白整形は契約外＝変更可）                     |

---

## §1. 時間内訳（実測・verify before assert）

> 出典＝実 run ログ（`gh run view <id> --log` のステップ別時刻 ＋ fetch.mjs の phase ログ JSON）。
> 計測 run はいずれも **旧 SQLite 経路（`main()`）**。JS 経路（`runFullJS`）は 2026-06-18 02:54 JST 投入で、
> 初の scheduled run が計測時点で進行中。**network 系の所要は経路非依存**（同一 `fetchAllBranchEpisodes`/`fetchPeriodHtml` を呼ぶ）。

### 1-1. 通常 daily（seed なし）＝ run `27657855069`（18m40s, workflow_dispatch, SQLite 経路）

| 局面                                          |                           所要 | 性質                                                                                                                |
| --------------------------------------------- | -----------------------------: | ------------------------------------------------------------------------------------------------------------------- |
| CI セットアップ（checkout/pnpm/node/install） |                           ~25s | CI オーバヘッド                                                                                                     |
| **Phase A: snapshot**                         |                     **16m49s** | **ToS network（~875 ページ × ~1.2s／≥500ms 床＋応答時間）＝daily の約 90%**                                         |
| Phase B: list.json                            |                            ~1s | network 1 req                                                                                                       |
| Phase C: seed                                 | **skip**（daysSinceRefresh=0） | —                                                                                                                   |
| Phase D: RSS                                  |                            ~2s | network 1 req（条件付き GET）                                                                                       |
| Phase E: ETL 派生                             |                           ~53s | **うち period HTML 32 季 ≈ 40s（network・逐次≥500ms）**／overview/tags/franchise/cours-from-tags 等の純 JS は計 <3s |
| Phase F: metrics（二段パス JS）               |                         ~0.05s | JS（実質ゼロ）                                                                                                      |
| Phase G: export/projection                    |                          ~1.1s | I/O（SQLite 版は無インデント書き出し）                                                                              |
| Build static site（vite＋cp）                 |                            ~2s | I/O                                                                                                                 |
| **Upload Pages artifact**                     |                        **~2s** | **単一 tar.gz＝律速ではない（後述 §3 で仮説を否定）**                                                               |
| Deploy to Pages                               |                            ~6s | GitHub CDN                                                                                                          |
| Save state（rsync＋commit＋push）             |                            ~8s | git                                                                                                                 |
| **合計**                                      |                  **~18–20 分** | snapshot が支配的                                                                                                   |

snapshot 内訳（年窓・逐次）：2012 56s／2019 77s／2020 149s／2024 93s／2025 148s … 件数の多い年ほどページ数増。
合計ページ ≈ 87,374 件 ÷ 100 ≈ **875 リクエスト**（＝ToS 床で ~7.3 分、応答時間込みで実測 ~17 分）。

### 1-2. full seed（週次／force／初回）＝ run `27710746177`（1h44m, SQLite 経路）

| 局面                               |      所要 | 性質                                                                      |
| ---------------------------------- | --------: | ------------------------------------------------------------------------- |
| fetch 全体（snapshot＋seed＋派生） | **1h42m** | うち snapshot ~18 分、**nvapi seed ~85 分**（6,299 series × ≥500ms 逐次） |
| Upload artifact                    |       ~5s | 律速でない                                                                |
| Deploy to Pages                    |      ~27s | CDN                                                                       |
| Save state                         |      ~36s | git                                                                       |

### 1-3. hourly ＝ run `27690215425` 等（42s–1m20s）

RSS 1 req（条件付き GET）＋（新着があれば）対応 series のみ nvapi backfill＋`new.json` のみ。**軽量・既に最適**。

### 1-4. JS 経路（現行コード `runFullJS`）の構造的差分（コード検証・要実測）

- **`writeBackStore(store, DATA_DIR, {now})`＝`seriesIds` 未指定 → 全 6,352 series を書き出す**。しかも
  **`for…await _writeJsonAtomic`＝逐次**、`JSON.stringify(data, null, 2)`＝**2スペース整形**（`store.mjs:331,368,408`）。
  → 推定 +10–30s の書き込み＋ stringify CPU。`data/series`＝**実測 193MB / 6,352 ファイル（既に整形済み）**。
- snapshot upsert で **各 episode に `lastUpdated: now` を必ず付与**（`fetch.mjs:768`）→ **毎日全 series ファイルが必ず変化**
  ＝state ブランチで 6,352 ファイル churn ＋ deploy artifact 全差し替え（容量はともかく git/diff コストは毎回フル）。

---

## §2. ボトルネック（ランク順・実測/コード検証）

| #      | ボトルネック                                                                                                                                                                                                                                                                                                                                                                                      |                           規模 | 削減可否                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----------------------------: | -------------------------------------------------------- |
| **B1** | **JS 経路 seed の全件化**：`selectSeedTargets({allIfOrphans:true})` は **孤児が 1 件でもあれば全 6,299 series を返す**（`store.mjs:727`）。snapshot は新規 episode を **`seriesId=null`＝孤児**で挿入（`store.mjs:456`・snapshot に series id 無し）。`runFullJS` は `orphans>0` で seed 起動（`fetch.mjs:814`）。→ **新規アップロードがある日（＝平常運転のほぼ毎日）に full seed ~85 分が走る** |          **~85 分/日（潜在）** | **削減可（最大・ToS は逆に軽くなる）**                   |
| **B2** | **snapshot ~17 分/日**                                                                                                                                                                                                                                                                                                                                                                            |                      ~17 分/日 | **不可**（ToS 床＋`_limit`100 固定＝リクエスト数も固定） |
| **B3** | **period HTML 32 季 ~40s/日**：過去季（例 2018-冬）は静的履歴なのに毎日全季再取得                                                                                                                                                                                                                                                                                                                 |                     ~30–40s/日 | **削減可（ToS は軽くなる）**                             |
| **B4** | **writeBackStore（全6,352・逐次・整形）＋全 churn**                                                                                                                                                                                                                                                                                                                                               | ~10–30s/日＋artifact/diff 肥大 | **削減可（I/O・ToS 非関与）**                            |
| B5     | CI セットアップ・save-state（git clone/rsync）                                                                                                                                                                                                                                                                                                                                                    |                     ~30–60s/日 | 小（限定的）                                             |

> **注（B1 の性質）**：これは PH-0008 §0-5 の設計意図（「孤児は seriesId 不明＝候補集合＝①新規 list series ②話数不足 series
> ③孤児件数が**閾値超**なら全件 fallback」）からの **実装乖離**。現行は閾値＝0（`orphans>0` で即全件）＝設計の「③ fallback」を
> 常時発火させている。**設計どおりに戻すこと自体が最大の最適化**。

---

## §3. 検証で否定した仮説（記録）

- **「deploy の artifact upload（6,352 ファイル・172MB）が律速」→ 否定**。
  `upload-pages-artifact` は dist 全体を**単一 tar.gz** にして送る。実測 **2–6s**（run 27657855069／27696628560／27710746177）。
  ファイル数・総 MB は upload 時間にほぼ無関係（高圧縮 JSON）。**まとめ方/圧縮/変更分のみ送付は不要**。
  ただし §4-S4b の compact 化は artifact/diff を**副次的に**縮小する（律速対策ではなく衛生）。
- **「純 JS 化で加工が遅くなった」→ 否定**。metrics 二段パス ~0.05s、projection 6 ファイル並列 ~1–2s。加工は誤差。律速は network。

---

## §4. 施策（短縮見込み × 安全性の順）

### S1. seed を §0-5 どおり「対象限定＋閾値 fallback」に戻す ★最大・ToS 改善

**現状**：`orphans>0` → 全 6,299 seed（~85 分）。
**改修**：seed 候補を以下に限定（PH-0008 §0-5 を実装に反映）。

1. **新規 list series**（episodes 0 件）
2. **話数不足 series**（episode 数 ≤ 閾値・既存 `insufficientThreshold`）
3. **孤児 episode をタイトル前方一致で既存 series に対応付け**（hourly の `matchRssOnlyToSeries`／`backfillSeries` と同方式）→ 対応した series のみ seed
4. **全件 fallback は「孤児件数 > 有意閾値（例 500）」または週次経過 or force のときだけ**（＝ドリフト/データ欠損時の復旧路）

- **短縮見込み**：平常日の seed＝6,299 → **数〜数十 series＝~1–3 分**（または孤児ゼロ日は skip）。**~80 分/日 削減**（潜在）。
- **ToS**：nvapi リクエストは**厳密に減る**（6,299 → 数十）＝負荷低下。
- **整合**：孤児は対応 series の seed で解消。未対応孤児は据え置き（痩せない）＋週次 full と閾値 fallback が残渣を回収。`detectShrink` は従来どおり通す。
- **コスト**：中。**リスク**：中（タイトル突合の正確性）→ 緩和＝hourly で実績ある方式の流用・週次 full を安全網に維持・seed 後に「孤児が増えていない」アサート。

### S2. 初回 full seed の明示化（一度きり ~85 分）

- 現状 `data/state/meta.json` の **`lastSeedAt: null`** → 初の JS daily が（孤児有無に関わらず）full seed。現在進行中の run がこれを支払い、
  完了時 `storeUpdateMeta(store,{lastSeedAt:now})` で解消される。
- **施策**：M-pre enrich または初回成功後に `lastSeedAt` を必ず確定（S1 と併用で、以降の平常日は full seed されない）。
- **短縮見込み**：一度きり（次回 run 限定）。**コスト**：小。**リスク**：低。

### S3. period HTML の季キャッシュ ★ToS 改善

- **改修**：過去季の `parsePeriodHtml` 結果（entries）を `data/state/period-cache.json` に保存。daily は **現行季＋直近 1 季のみ再取得**、
  それ以前はキャッシュから読む。series 突合（in-memory）は毎回実行（series 集合が変わるため）。
- **短縮見込み**：~30–40s/日（30 季前後の HTTP を省く）。**ToS**：リクエストが減る。
- **整合/リスク**：低。取得し続ける季には従来の変更検知アサート（`dアニメストア` 文字列・slug 数）を維持。過去季 HTML が稀に改訂された場合に備え、**月次でキャッシュ全季 refresh** のフラグを持つ。
- **コスト**：低。

### S4. writeBackStore の I/O 効率化 ★ToS 非関与

- **S4a 並列書き込み**：series 書き出しを `loadStore` 同様の **chunked `Promise.all`（CHUNK=200）** に。逐次 await を解消。
- **S4b compact 化**：series JSON を **無インデント**（`JSON.stringify(data)`）に（旧 SQLite export と同方針・PH-0008 §A-6）。193MB → ~150MB。stringify/書込/artifact/git-object すべて縮小。**`types.ts` 契約は空白に依存しないので不変**。
- **S4c 変更分のみ書き出し**：store は既に **`_dirtySeries` を保持**（`store.mjs:399-403`）。`seriesIds` 未指定時も **dirty set のみ書く**ように。併せて **無条件の per-episode `lastUpdated=now` を廃止**（または「viewCounter 等が実変化した episode のみ」スタンプ）→ 変化のない tail series がファイル churn しない＝state コミット・deploy 差分が最小化。
- **短縮見込み**：~10–30s/日（書込）＋ save-state/artifact/diff の縮小。**コスト**：中（S4c は dirty 追跡の正確性が要）。**リスク**：低〜中。**ToS**：無関与。
- **検証**：書込前後で **値が変わった series のみ** diff・冪等（同入力 2 回目は state diff 空）。

### S5. CI/save-state の軽量化（小）

- hourly/daily は毎回 state ブランチを `git clone --depth 1` → rsync → commit。**daily の `--check-version` ステップ**は情報取得のみ（1 req・継続エラー）で、本体 `runFullJS` も内部で version 取得するため**二重**。daily から `--check-version` ステップを外しても version gate は本体が担う（リクエスト 1 本減）。
- **短縮見込み**：~5–15s/日。**コスト**：小。**リスク**：低。

---

## §5. 期待される総効果

| ケース                                       |               現状（JS 経路・lastSeedAt 確定後の想定） |                                                          施策後 | 主因                         |
| -------------------------------------------- | -----------------------------------------------------: | --------------------------------------------------------------: | ---------------------------- |
| 平常 daily（新規アップロードあり＝大半の日） | **~17 分 snapshot ＋ ~85 分 seed ＋ 諸経費 ≈ ~103 分** | **~17 分 snapshot ＋ ~1–3 分 targeted seed ＋ 諸経費 ≈ ~20 分** | **S1（決定打・~80 分削減）** |
| 平常 daily（孤児ゼロ日）                     |                                              ~18–20 分 |                                 ~18 分（S3+S4 で更に -40〜60s） | S3/S4                        |
| 週次/force full seed                         |                                            ~100–105 分 |                           ~100 分（seed 自体は ToS 床で不可侵） | —                            |
| hourly                                       |                                              42s–1m20s |                                                据置（既に最適） | —                            |

**結論**：律速は **B2 snapshot（~17 分・ToS 床で不可侵）** だが、JS 経路で顕在化した **B1 seed 全件化（~85 分/日）が現実の最大コスト**。
**S1（seed を設計どおり対象限定）が単独で平常 daily を ~100 分 → ~20 分に戻す決定打**。S3/S4 は snapshot 床上の数十秒の衛生改善。
**snapshot 自体は削れない**＝「daily の理論下限 ≈ snapshot 17 分＋諸経費 ≈ 18–19 分」。

---

## §6. 却下した案（API 負荷増・効果なし）

| 案                                            | 却下理由                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| snapshot を並列取得／レート上げ／`_limit`>100 | ToS 違反（逐次・≥500ms・上限 100 固定）。**負荷増は絶対制約で禁止**                                                         |
| 差分 snapshot（古い動画を取らず新着のみ）     | 全作品の **日次 view 更新（delta/popular）** が崩れる＝発見 UI の鮮度・ランキングが破綻。v1 スコープの挙動変更で却下        |
| nvapi seed の並列化／間隔短縮                 | 非公式 API への負荷増＝最も避けるべき。却下                                                                                 |
| artifact をまとめ直す／圧縮／変更分のみ送付   | **律速ではない（実測 2–6s）**。投資対効果なし（S4b で副次的に縮小はする）                                                   |
| version gate で daily snapshot を skip        | snapshot 索引は AM5 更新・daily は 06:00 起動＝**毎日 version が変わる**ので平常日は skip 不発（同日再 run のみ有効＝据置） |

---

## §7. 段階移行（P1→P4・各段ロールバック可）

| 段                         | 作業                                                                                                                                                                               | Exit/検証                                                                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1 計測**                | 初の JS scheduled daily を完走させ、**phase 別の実時間ログ**（fetch.mjs に経過 ms ログを追加）で JS 経路の真の内訳を取得。B1（seed 全件化）・B4（writeBack）の実コストを実測で確定 | JS 経路の time breakdown が §1-4 推定と一致するか確認                                                                                                                                                                           |
| **P2 S1（seed 対象限定）** | `selectSeedTargets` を §0-5 に整合（候補①②③＋閾値 fallback）。孤児→title 突合を `runFullJS` Phase C に組み込み                                                                     | `test_seed_targets_orphan_match`（孤児注入→対応 series のみ seed）／`test_seed_full_fallback_threshold`（閾値超のみ全件）／週次・force は従来どおり／`detectShrink` green。手動 dispatch で平常日相当の seed 件数が数十に収まる |
| **P3 S3+S4**               | period 季キャッシュ・writeBack 並列＋compact＋dirty 限定・per-ep lastUpdated 廃止                                                                                                  | 値 diff 不変（空白のみ差）・冪等（2 回目 state diff 空）・period 取得季が現行＋直近 1 のみ・書込時間短縮を実測                                                                                                                  |
| **P4 観測**                | cron で 24–48h 観測。seed 件数・daily 所要・孤児推移・churn を監視。閾値（孤児 fallback 値）を実データで調整                                                                       | 痩せ/churn/zombie 無し・daily 所要が ~20 分（孤児ゼロ日 ~18 分）に収束                                                                                                                                                          |

> P1 は計測のみ（無改修）。P2 が本丸。P3 は衛生。**稼働中 cron・取得層・workflow（cache 撤去済）は P2/P3 とも手動 dispatch で検証してから既定化**。

---

## §8. 検証方法（ToS・整合の非後退を担保）

- **等価性**：施策前後で `data/*.json` を生成し diff。**ep>0 distinct series 数不変**（痩せていない）・works 行数不変・hot/popular 上位不変。
- **seed 限定の正しさ**：孤児を人工注入 → **対応 series のみ** nvapi 取得（リクエスト数をログでカウント＝6,299 でないこと）。閾値超の注入でのみ全件 fallback。
- **ToS 非後退**：1 run の **nvapi/period/snapshot リクエスト総数が現状以下**であることをログ集計で確認（S1/S3 は減る・S4 は不変・どの施策も増やさない）。
- **整合ガード**：`detectShrinkFromStore` が全施策後も green。孤児が日を跨いで蓄積しない（毎日の orphan 件数が単調増加しない）。
- **冪等**：同入力 2 回連続で 2 回目の state diff が空（per-ep lastUpdated 廃止後）。
- **所要計測**：phase 別経過 ms ログ＋`gh run view --json jobs` で wall-clock を施策前後比較。
- `pnpm test`/`typecheck`/`lint`/`build` 全通過・`types.ts` 出力契約不変。

---

## Exit Criteria

- [ ] 平常 daily の seed が **全 6,299 固定でなくなり**、孤児は対象限定 seed（title 突合＋新規/不足 series）で解消、全件は閾値/週次/force 時のみ（S1）。
- [ ] 平常 daily の wall-clock が **~20 分以下**（snapshot 床＋諸経費）に収束し、潜在の ~85 分/日 seed が解消（実測）。
- [ ] period 過去季が季キャッシュで再取得されない（現行＋直近 1 季のみ fetch・S3）。
- [ ] writeBack が **変更 series のみ・compact・並列**で、state churn と deploy 差分が最小化（S4）。冪等が成立。
- [ ] 全施策で **nvapi/period/snapshot のリクエスト総数が現状以下**（ToS 非後退）。
- [ ] `detectShrink`/件数アサート green・`types.ts` 契約不変・`pnpm test/typecheck/lint/build` 全通過。
- [ ] cron 観測 24–48h で痩せ/churn/zombie/孤児蓄積なし。
