# PH-0001: データ取得基盤＋SQLite ビルドDB

## 目的
ToS を厳守した nico API 取得層・支店フィルタ・snapshot 日次フル取得・SQLite ビルドDB（スキーマ／UPSERT／前日比 delta）・上流変更検知を実装し、`pnpm fetch` で支店各話を SQLite に取り込める状態にする。L2 §1.2/§1.3・dataflow.md・db-design.md 準拠。

## 機能一覧

### F-0006: nico API クライアント＆ToS順守
**対応REQ**: 非機能（L2 §3 APIマナー / dataflow.md §7）

取得を `scripts/nico/` に集約し、ブラウザからは一切叩かない。User-Agent 必須、逐次取得（並列禁止）、**前回レスポンス時間ぶん待機**、503 は 5 分以上バックオフ、条件付き GET（`If-Modified-Since`/`ETag`）に対応する。

**受け入れ条件**:
- [ ] すべての外部リクエストに User-Agent ヘッダが付与される
  - 検証: テスト `test_request_has_user_agent`（リクエストヘッダのアサート）
- [ ] リクエストは逐次（同時並列で外部を叩かない）で、前回レスポンス時間ぶん待機する
  - 検証: テスト `test_sequential_with_adaptive_delay`（モックでスリープ呼び出しを確認）
- [ ] 503 受信時に 5 分以上のバックオフへ入る
  - 検証: テスト `test_503_backoff`
- [ ] 取得コードは `scripts/` 配下のみに存在し、`web/` から外部 API/RSS を呼ぶ箇所が無い
  - 検証: テスト/Grep（`web/` 内に nicovideo API/RSS 直叩きが0件）

---

### F-0007: 支店フィルタ（channelId==2632720）
**対応REQ**: REQ-0001 / REQ-0005（L2 §6.1, validation A）

snapshot は `q=dアニメストア&targets=tagsExact` で取得し、`channelId` は filter 不可のため**取得後にクライアント側で `channelId==2632720`** を絞ってから `episodes` へ insert する。本店（docomo）データを混ぜない。`contentId` は filter 可能（個別話直引き）。

> 注: `episodes` スキーマ（db-design.md §1）に `channelId` 列は持たない（支店判定済みのみ格納）。検証は**フィルタ境界（insert 前のステージング）**で行う。

**受け入れ条件**:
- [ ] フィルタ段で `channelId!=2632720` の行が除外され、`episodes` insert へ渡らない
  - 検証: テスト `test_branch_filter_excludes_non_2632720`（混在フィクスチャで除外件数をアサート）
- [ ] `contentId` 直引き（`filters[contentId][0]=so…`）で個別話を取得できる
  - 検証: テスト（モックレスポンスで total=1 / 該当 contentId）
- [ ] 支店のみ混在フィクスチャ投入後、`episodes` の件数が支店該当数と一致する
  - 検証: テスト `test_branch_only_rows_inserted`（混在 N+M 件 → 支店 N 件のみ insert）

---

### F-0008: snapshot 日次フル取得（期間ウィンドウ分割＋version ゲート）
**対応REQ**: REQ-0002 / 非機能（L2 §2.5, dataflow.md §3, validation B）

`viewCounter` 等の可変メトリクスは日次フルで全件再取得する。`_offset` 上限（100000）は `filters[startTime]`（**TZ `+09:00` 必須**）の期間ウィンドウ分割で回避。日次フルの前に `…/snapshot/version` の `last_modified` を確認し、前回から変わった時だけ走らせる。

**受け入れ条件**:
- [ ] `filters[startTime]` に TZ 無しを渡さない（必ず `+09:00` 付き）
  - 検証: テスト `test_starttime_filter_has_timezone`
- [ ] `startTime` 期間ウィンドウ分割で全件を `_offset`≤100000 / `_limit`≤100 の範囲で取得する
  - 検証: テスト `test_window_split_covers_all`（境界 `>=`＋id dedup の確認）
- [ ] version ゲート: `last_modified` が前回と同じなら日次フルをスキップする
  - 検証: テスト `test_version_gate_skips_when_unchanged`
- [ ] 期間ウィンドウ分割の境界がフィクスチャで全件カバーする（重複/欠落 0）
  - 検証: テスト `test_window_split_no_gap_no_overlap`（既知件数フィクスチャで取得総数＝期待値）

---

### F-0009: SQLite ビルドDB（スキーマ・PRAGMA・一括ロード）
**対応REQ**: 非機能（db-design.md §1/§2/§5）

db-design.md のスキーマ（`series` / `episodes` / `rss_items` / `tags` / `series_tags` / `meta_state` / `series_metrics`）を作成。**一括 INSERT は `BEGIN…COMMIT` でまとめ**、prepared statement ＋バッチ、**インデックスは一括ロード後に作成**、ロード後 `ANALYZE`。PRAGMA は再生成可能な中間物前提で速度優先。DB は配信に出さない。

**受け入れ条件**:
- [ ] db-design.md §1 のテーブル/列が作成される（`episode_view_history` は将来用として未使用で可）
  - 検証: テスト（`PRAGMA table_info` でスキーマ一致）
- [ ] 一括ロードがトランザクションでまとまり、インデックスはロード後に作成される
  - 検証: テスト `test_bulk_load_uses_transaction_then_index`
- [ ] PRAGMA（WAL/synchronous/temp_store/cache_size/foreign_keys）が設定される
  - 検証: テスト（`PRAGMA` 値の確認）
- [ ] SQLite ファイルが `data/*.json` の配信出力に含まれない（中間生成物）
  - 検証: テスト/Grep（export 対象に `.sqlite` が無い）

---

### F-0010: UPSERT と前日比 delta（1スロット bounded）
**対応REQ**: REQ-0002（db-design.md §3, foundation §1.2）

`INSERT … ON CONFLICT(content_id) DO UPDATE` で**旧 `view_counter` を `prev_view_counter` に退避**しつつ最新へ更新する（無制限履歴を持たない＝1スロット bounded）。`delta = view_counter − prev_view_counter`。初回は `prev=NULL` → delta は2回目更新（翌日）から有効。

**受け入れ条件**:
- [ ] 2回目の取り込みで `prev_view_counter` に前回値が退避され、`view_counter` が新値になる
  - 検証: テスト `test_upsert_shifts_prev_view_counter`
- [ ] 初回取り込み時は `prev_view_counter` が NULL で delta が無効扱い
  - 検証: テスト `test_first_load_delta_inactive`
- [ ] 7スロット ring（`episode_view_history`）は v1 では生成・参照しない
  - 検証: テスト/Grep（v1 コードが当該テーブルへ書き込まない）

---

### F-0011: 上流変更検知アサート
**対応REQ**: 非機能（foundation §5.4, dataflow.md §7）

各源を**公開前にアサート**し、想定外なら**非ゼロ終了して Actions を fail** させ、壊れた/空の JSON で上書き公開しない（前回正常物を保持）。しきい値（件数下限・急減率）は設定で持つ。

**受け入れ条件**:
- [ ] snapshot: `meta.status==200`／`data[]` 非空／必須フィールド存在／`channelId==2632720` が一定数以上／`totalCount` が前回比で急減していない を検査
  - 検証: テスト `test_assert_snapshot_ok` / `test_assert_snapshot_fails_on_empty`
- [ ] しきい値（下限件数・急減率）が設定値として外出しされている
  - 検証: テスト（設定値を差し替えると判定が変わる）
- [ ] アサート失敗時は非ゼロ終了し、既存の公開物を上書きしない
  - 検証: テスト `test_fail_keeps_previous_output`

---

## Exit Criteria
- [ ] `pnpm fetch`（snapshot 経路）で支店各話が SQLite に取り込まれ、`channelId!=2632720` が 0 件
- [ ] 2回実行で `prev_view_counter`／delta が期待どおり遷移する（テストで確認）
- [ ] 変更検知アサートが空/壊れレスポンスで fail し、前回出力を保持する
- [ ] `pnpm test` / `pnpm typecheck` / `pnpm lint` が通る
