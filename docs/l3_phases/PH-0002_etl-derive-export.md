# PH-0002: 派生データ・新着・静的JSON export

## 目的
SQLite 上で各話統合・タグ正規化・概要・五十音・クール・フランチャイズ・勢いスコアを導出し、新着 RSS（毎時・ID解決）を取り込み、用途別の静的 JSON（`works/ranking/tags/cours/kana/new/series`）を export する。これで `data/*.json` が一式そろう。dataflow.md・db-design.md 準拠。

## 機能一覧

### F-0012: nvapi v2 series 各話統合・支店判定
**対応REQ**: REQ-0001（validation D, dataflow.md §7）

各話リスト・話順は **nvapi `v2/series/<id>`** を主源とし、`items[]` で `episode_no`（話順）を確定、`owner.channel.id=="ch2632720"` でシリーズ判定を行う。**初回は list.json の全カタログ series を一度シード取得**（ToS 遵守＝逐次・前回レスポンス時間待機・低頻度バッチ）して各話を網羅する。**以降は RSS で変化したシリーズだけ／週次程度**の差分更新に切り替える（全件を毎回引かない）。

**受け入れ条件**:
- [ ] 初回シードで list.json の全 series に対し nvapi 各話が取り込まれる（網羅）
  - 検証: テスト `test_initial_nvapi_seed_covers_all_series`（カタログ件数＝シード対象件数）
- [ ] series の `items[]` 順で `episode_no` が採番される
  - 検証: テスト `test_episode_order_from_nvapi`
- [ ] `owner.channel.id!="ch2632720"` のシリーズは支店外として除外
  - 検証: テスト `test_series_branch_check`
- [ ] 2回目以降は全件一括ではなく差分（RSS変化/週次）対象のみ取得する
  - 検証: テスト `test_nvapi_differential_after_seed`（更新対象がフィルタされる）
- [ ] シード取得が逐次・前回レスポンス時間待機（ToS）で行われる
  - 検証: テスト `test_nvapi_seed_rate_limited`

---

### F-0013: タグ正規化（dアニメ キュレーション・接頭/接尾両対応）
**対応REQ**: REQ-0003 / REQ-0008（foundation §1.2, validation B/キュレーション検証）

**シリーズ代表タグは各シリーズの第1話（最古話 min `start_time`・F-0014 と同じ選定）の `tags` を源**にする（全話 union で話固有ラベルを混ぜない＝シリーズ平面を汚さない。必要時のみ全話 union を将来検討）。`tags` から **`dアニメ` マーカー**（接尾 `_dアニメ(ストア)?$`・接頭 `^dアニメ_`）を除去 → `/` 分割 → trim → 大小・全半角統一 → エイリアス吸収して `tags.name` に UNIQUE 格納。素の `dアニメストア`（配信元）は除外。`is_curated=1`。正規化タグは通常タグと**同じ平面（フラット1系統）**で扱い、別 facet にしない。

**受け入れ条件**:
- [ ] シリーズ代表タグが第1話（最古話）の tags から導出される（全話 union しない）
  - 検証: テスト `test_series_tags_from_first_episode`（第2話以降の固有タグが混入しない）
- [ ] 接尾型 `ドラマ/青春_dアニメ` → `ドラマ`,`青春` に正規化される
  - 検証: テスト `test_normalize_suffix_curation_tag`
- [ ] 接頭型 `dアニメ_音楽系` → `音楽系` に正規化される
  - 検証: テスト `test_normalize_prefix_curation_tag`
- [ ] 素の `dアニメストア` はタグ集合から除外される
  - 検証: テスト `test_exclude_distributor_tag`
- [ ] 大小（`sf`→`SF`）・全半角・エイリアスが吸収され重複しない
  - 検証: テスト `test_tag_alias_and_case_dedup`
- [ ] キュレーション由来は `is_curated=1` で識別でき、別 facet テーブルを作らない
  - 検証: テスト（`tags` は単一フラット集合）

---

### F-0014: シリーズ概要（第1話あらすじ流用・HTML除去）
**対応REQ**: REQ-0001（validation C/E）

シリーズ概要は**第1話の snapshot `description`** を流用し、HTML を除去して「第1話のあらすじ」と明示する。第1話は**日次フルで取得済みの全 episode から各シリーズの最古話（min `start_time`）を選んで導出**し、per-series の `contentId` 直引きを増やさない。

**受け入れ条件**:
- [ ] `description_first` が各シリーズの最古話 description から HTML 除去して格納される
  - 検証: テスト `test_series_overview_from_first_episode`
- [ ] HTML（`<br>` 等）・制御文字が除去/正規化される
  - 検証: テスト `test_strip_html_in_overview`
- [ ] 最古話の選定が取得済み episode の min(start_time) で行われ、直引きを伴わない
  - 検証: テスト（直引き呼び出しが発生しない）

---

### F-0015: 五十音 col_key 取り込み
**対応REQ**: REQ-0011（validation A, foundation §1.2）

`list.json` を取り込み、`col_key`（読みの行・あ〜わ）を `series.col_key` に格納する。完全な読み（yomi）は無いため**行バケットのみ正確**、行内はタイトル文字列順フォールバック。

**受け入れ条件**:
- [ ] `list.json` の `{title,col_key,url}` を取り込み series に紐付ける
  - 検証: テスト `test_import_list_json_colkey`
- [ ] 取り込んだ全件で `col_key` 欠落が 0（監査と同じ前提）
  - 検証: テスト `test_colkey_no_missing`
- [ ] 行（あ〜わ）以上の厳密 50 音ソートを行わない（行内は title 順）
  - 検証: テスト `test_kana_row_bucket_only`

---

### F-0016: クール結合（period HTML）
**対応REQ**: REQ-0004（foundation §1.2, validation C/5回目）

クール帰属は**今季＝`programlist.json`（現行季の番組表）／過去季＝period HTML `anime.nicovideo.jp/period/<年>-<季>-danime.html`**（過去季可・支店明示）を源にする。period の `/detail/<slug>` を series へ**正規化タイトル＋信頼度スコアで結合**、未一致/曖昧はレポートし**少数の手動 override 表**を併用。判定できない作品は `cours=NULL`（不明）で正直に扱う。`startTime` 推定は現行季しか当たらないため使わない。取得は変更検知アサート必須。

**受け入れ条件**:
- [ ] `programlist.json` から今季作品を取り込み現行季の `cours` を付与する（画像キーは綴り注意 `imgpagh`）
  - 検証: テスト `test_ingest_programlist_current_cours`（`imgpagh` キーで参照・誤綴り `imgpath` を使わない）
- [ ] period HTML から `年-季` と `/detail/<slug>` 件数を抽出する（過去季）
  - 検証: テスト `test_parse_period_html`
- [ ] slug ↔ series をタイトル正規化＋信頼度で結合し、低信頼は未確定としてレポートする
  - 検証: テスト `test_period_series_match_confidence`
- [ ] 手動 override 表（docs/data 配下）が結合に反映される
  - 検証: テスト `test_period_manual_override`
- [ ] 判定不能は `cours=NULL`（不明）として保持する
  - 検証: テスト `test_cours_unknown_is_null`
- [ ] period の変更検知（`<title>` に「<年><季>アニメ dアニメストア(ニコニコ支店)」・`/detail/` 件数下限）が効く
  - 検証: テスト `test_assert_period_structure`

---

### F-0017: フランチャイズ束ね（ベストエフォート）
**対応REQ**: REQ-0014（validation D-2/D-3）

公式の関係フィールドは存在しないため、**共有作品タグ／`〜シリーズ` タグの正規化**でフランチャイズを束ねる（`franchise_key`）。タイトル語幹は弱い補助、少数の手動補正を併用。**取れない作品は非表示**（無理に推定しない）。

**受け入れ条件**:
- [ ] 共有作品タグ／`〜シリーズ` タグで同一フランチャイズが束ねられる
  - 検証: テスト `test_franchise_by_shared_tag`（ゆるキャン系の束ね）
- [ ] タイトル語幹マッチは補助に留め、単独主源にしない
  - 検証: テスト（タグ無しスピンオフはタグがあれば拾い、語幹のみでは束ねない）
- [ ] 関連が取れない作品は `franchise_key=NULL`（詳細で非表示になる前提）
  - 検証: テスト `test_franchise_null_when_unknown`

---

### F-0018: 勢いスコア（Hot）＋指標の set-based 再計算
**対応REQ**: REQ-0002（foundation §1.2, db-design.md §4）

差分 UPSERT 後、**1 文で `series_metrics` を再計算**（行ループ禁止）。`total_views`（Σ各話 view）・`delta_views`（Σ(view−prev)）・`velocity`（total ÷ 公開からの経過日数）・`recency`（最新話の新しさ）を集計し、ブレンドして `hot_score` を出す。新着話は comment/like/mylist が疎なため**view 主体**。累計順は `total_views`。

**Hot スコアの式（v1 確定・決定的）**: 各因子を全シリーズ内で **min-max 正規化（0..1）** し、重み付き和を取る。

```
delta_n    = minmax(delta_views)               # 前日比の伸び（prev=NULL 時は 0）
velocity_n = minmax(log1p(velocity))           # 規模差を圧縮（対数）
recency_n  = exp(-recency_days / TAU)           # TAU=14日 の指数減衰（新しいほど 1 に近い）
hot_score  = 0.5*delta_n + 0.3*velocity_n + 0.2*recency_n
```

- 重み `(0.5, 0.3, 0.2)`・`TAU=14` は v1 既定値（設定で外出し）。delta 主体だが初日（prev=NULL で delta=0）は velocity/recency が支える。
- **タイブレーク**: `hot_score` 同値は `total_views` 降順 → `series_id` 昇順で決定的に確定。

**受け入れ条件**:
- [ ] `series_metrics` が set-based（単一 SQL）で再計算される
  - 検証: テスト `test_metrics_set_based`
- [ ] `delta_views` が `Σ(view_counter − prev_view_counter)` で算出される（prev=NULL は実質0）
  - 検証: テスト `test_delta_views_sum`
- [ ] `velocity` = total_views ÷ max(1, 経過日数)、`recency` = 最新話 start_time の新しさ
  - 検証: テスト `test_velocity_recency`
- [ ] `hot_score` が上式（正規化＋重み 0.5/0.3/0.2＋TAU=14）で算出され、重み/TAU は設定で外出しされる
  - 検証: テスト `test_hot_score_formula`（既知入力→期待スコア）
- [ ] 同入力で同順位（タイブレーク total_views→series_id で決定的）
  - 検証: テスト `test_hot_score_deterministic_tiebreak`
- [ ] 初日（prev=NULL）は delta=0 として velocity/recency 主体で算出される
  - 検証: テスト `test_hot_score_first_day`
- [ ] 勢いは view 主体で、comment/like/mylist を主因にしない
  - 検証: テスト（疎な指標が hot_score を支配しない）

---

### F-0019: 新着 RSS（毎時・HWM 増分）＋ watch id 解決
**対応REQ**: REQ-0010（dataflow.md §3/§6.1, validation 更新頻度）

チャンネル RSS `ch.nicovideo.jp/ch2632720/video?rss=2.0` の **page1 のみ**を条件付き GET（304 ならスキップ）。`rss_last_guid` を HWM に新 item を `rss_items` にステージング。**watch id（数値）→ `contentId`（so…）** を redirect もしくは「正規化 title＋pubDate 一致」で解決し `episodes` に統合、**未解決は `rss_only`** として「最新の動画」枠にのみ出す（誤統合しない）。初回のみ page 遡及でシード。境界 `>=`＋id dedup。

**受け入れ条件**:
- [ ] 条件付き GET で 304 なら本文を取らずスキップする
  - 検証: テスト `test_rss_conditional_get_304`
- [ ] HWM（`rss_last_guid`）より新しい item のみ採用し、id dedup する
  - 検証: テスト `test_rss_hwm_dedup`
- [ ] watch id → contentId 解決に成功したら episodes に統合（`resolved`）
  - 検証: テスト `test_rss_resolve_to_content_id`
- [ ] 未解決は `rss_only` とし、誤った id 統合をしない
  - 検証: テスト `test_rss_unresolved_stays_rss_only`
- [ ] RSS 変更検知（XML パース可・`channel.title` に支店名・item 数下限・link が watch URL）が効く
  - 検証: テスト `test_assert_rss_structure`

---

### F-0020: 用途別 静的 JSON export（export メタ付き）
**対応REQ**: REQ-0001〜0014（dataflow.md §5）

SQLite から `works/ranking/tags/cours/kana/new/series` 等の**用途別 JSON** を export。**作品詳細用に各シリーズの関連シリーズ（同一 `franchise_key` のメンバー series id/title/thumb・自身を除く）も出力**（REQ-0014・取れない作品は空配列＝詳細で非表示）。トップのタグ導線（Hot のタグ＝勢い上位作品の頻出タグ／人気のタグ＝累計上位の頻出タグ／ランダムタグ＝正規化辞書からサンプル／定番タグ）も出力。各 export に**最終更新時刻**（取得/ビルドのタイムスタンプ）を含める。フロントが読むのはこの JSON のみ。

**この JSON スキーマ（TS 型）はデータ契約の正本として本フェーズで `web/src/data/` の型定義に置き**、PH-0003 のローダはこれを import して消費する（契約は生産側で定義）。

**受け入れ条件**:
- [ ] `data/` に用途別 JSON（works/ranking/tags/cours/kana/new/series）が出力される
  - 検証: テスト `test_export_produces_all_json`
- [ ] export 結果が本フェーズで定義した TS 型スキーマと一致する（後発フェーズに依存しない）
  - 検証: テスト `test_export_matches_own_schema`（本フェーズ内の型/バリデータで検証）
- [ ] 各シリーズの関連シリーズ配列が同一 franchise の他メンバーで構成され、無ければ空配列
  - 検証: テスト `test_export_related_series`（ゆるキャン系は相互に含む／franchise_key=NULL は空）
- [ ] トップのタグ導線（Hot/人気/ランダム/定番）が正規化済みタグから生成される
  - 検証: テスト `test_top_tag_chips_from_normalized`
- [ ] 各 export に最終更新時刻メタが含まれる
  - 検証: テスト `test_export_has_last_updated`
- [ ] 配信出力に SQLite・中間生成物が含まれない
  - 検証: テスト/Grep（`data/` に `.sqlite` が無い）

---

## Exit Criteria
- [ ] `pnpm fetch` で `data/*.json` が一式生成され、各 JSON にスキーマ整合＋最終更新メタがある
- [ ] タグ正規化・五十音・クール・フランチャイズ・勢いスコアの単体テストがパス
- [ ] 新着 RSS の HWM 増分・watch id 解決・未解決の rss_only 分離がテストで確認できる
- [ ] `pnpm test` / `pnpm typecheck` / `pnpm lint` が通る
