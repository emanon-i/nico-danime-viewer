# PH-0003: Web コア（ローダ・3画面骨格・URL状態）

## 目的

型付き JSON ローダと 3 画面（トップ／一覧／作品詳細）の骨格、URL クエリによる状態再現、公式プレイヤーへの deep-link を実装し、生成済み `data/*.json` を読んで基本ブラウズができる状態にする。screens.md・foundation §2.1/§2.4 準拠。実行時は API 直叩きなし。

## 機能一覧

### F-0021: 型付き JSON ローダ

**対応REQ**: REQ-0001（foundation §1.1/§2.1, dataflow.md §5）

`data/*.json` を読む**唯一の窓口**を `web/src/data/` に置く。スキーマの TS 型は**PH-0002 F-0020 で定義したデータ契約型を import** して使う（型の正本は生産側＝export 側）。フロントは API/DB を直叩きせず、このローダ経由でのみデータへアクセスする。

**受け入れ条件**:

- [x] ローダが PH-0002 定義の契約型で各 JSON を型付きで返す（works/ranking/tags/cours/kana/new/series）
  - 検証: テスト `test_loader_typed_access` がパス ✓ (2026-06-16)
- [x] フロントのデータアクセスがローダ1経路に集約され、`fetch()` で外部 API/RSS を呼ばない
  - 検証: Grep `web/src/` で `fetch(` が `loader.ts` のみ ✓ (2026-06-16)
- [x] スキーマ不一致の JSON でローダが型エラー/実行時バリデーションを出す
  - 検証: テスト `test_loader_rejects_bad_schema` がパス ✓ (2026-06-16)

---

### F-0022: ルーティング＆URL クエリ状態

**対応REQ**: REQ-0001（screens.md 全体, foundation §2.4）

3 画面のルーティングを実装し、**全状態を URL クエリで再現**（`?q=&row=&tag=&cours=&sort=&page=` 等）。共有・ブックマーク・戻り位置が予測どおりになる。隠れた状態を持たない。

**受け入れ条件**:

- [x] 一覧の状態（検索/五十音/タグ/クール/並び/ページ）が URL クエリに反映される
  - 検証: テスト `test_list_state_in_url` がパス ✓ (2026-06-16)
- [x] 同じ URL を開くと同じ結果が再現される（決定的）
  - 検証: テスト `test_url_reproduces_state` がパス ✓ (2026-06-16)
- [x] ブラウザ戻る/進むで状態が予測どおり遷移する
  - 検証: テスト `test_history_navigation`（buildListUrl→parseScreen ラウンドトリップ）がパス ✓ (2026-06-16)

---

### F-0023: トップ画面 骨格

**対応REQ**: REQ-0001/0002/0004/0008/0010/0012（screens.md §1）

ヒーロー検索・クイックアクセス列・人気 TOP10 帯・最近追加/更新・クールから探す・タグから探す のセクションをレイアウトする（中身のデータ結線は本/後続フェーズ）。カードは原則シリーズ単位・正方形(1:1)、カードに ⓘ は付けない。

**受け入れ条件**:

- [x] 7 セクション（ヘッダ/ヒーロー検索/クイックアクセス/TOP10/最近追加/クール/タグ）が所定順で描画される
  - 検証: テスト `test_top_sections_render_in_order` がパス ✓ (2026-06-16)
- [x] カードは正方形で ⓘ を持たず、♥/✓/[↗] のみアイコンを持つ
  - 検証: テスト `test_card_icons` がパス ✓ (2026-06-16)
- [x] ヘッダ🔍 はヒーローが隠れてから出現する
  - 検証: テスト `test_header_search_appears_after_hero`（初期 `aria-hidden="true"` 確認）がパス ✓ (2026-06-16)

---

### F-0024: 一覧画面 骨格

**対応REQ**: REQ-0001（screens.md §2）

最上部検索バー＋五十音ボタン＋左フィルタ（タグ/クール・常駐）＋右グリッド＋ページングをレイアウト。カードは**主＝本体→詳細／副＝右上[↗]→公式 series**。**無限スクロールにしない**（`[← 前][次 →]` ページング）。

**受け入れ条件**:

- [x] 検索バー・五十音・左フィルタ・右グリッド・ページングが描画される
  - 検証: テスト `test_list_layout_render` がパス ✓ (2026-06-16)
- [x] カードの主/副アクションが分離（本体→詳細、[↗]→公式 series）
  - 検証: テスト `test_card_primary_secondary_action` がパス ✓ (2026-06-16)
- [x] ページングで遷移し、無限スクロール要素が無い
  - 検証: テスト `test_pagination_not_infinite_scroll` がパス ✓ (2026-06-16)

---

### F-0025: 作品（シリーズ）詳細画面 骨格

**対応REQ**: REQ-0001/0005/0014（screens.md §3）

バナー＋主要メタ（タイトル/タグチップ/公式シリーズリンク）＋第1話あらすじ＋各話一覧（話順）＋関連シリーズ枠＋♥/✓ をレイアウト。`genre` は表示しない。配信情報が取れない作品は **empty/unavailable 表示**（取れたメタ・生存リンク・タグ回遊のみ生かす）。

**受け入れ条件**:

- [x] 各話一覧が話順（episode_no）で描画され、各話に公式 watch リンクがある
  - 検証: テスト `test_detail_episode_list_order` がパス ✓ (2026-06-16)
- [x] `genre` 欄を表示しない
  - 検証: テスト `test_detail_no_genre` がパス ✓ (2026-06-16)
- [x] 関連シリーズ（export の related_series）が非空なら描画され、空配列なら**セクションごと非表示**になる
  - 検証: テスト `test_detail_related_series_render_and_hide` がパス ✓ (2026-06-16)
- [x] 関連シリーズの各リンクがうちのシリーズ詳細へ遷移する（ベストエフォート・取れた分のみ）
  - 検証: テスト `test_detail_related_series_links` がパス ✓ (2026-06-16)
- [x] `is_available=0`（配信情報欠損）の作品で empty 表示になり、取れたメタ・生存リンクのみ出す
  - 検証: テスト `test_detail_empty_state` がパス ✓ (2026-06-16)

---

### F-0026: 公式プレイヤー deep-link 生成

**対応REQ**: REQ-0005（screens.md §3, security.md §2）

`contentId` から `nicovideo.jp/watch/<contentId>`、series id から `nicovideo.jp/series/<id>` を生成する。**id を検証**（`contentId`=`so…`、series id=数値）してからテンプレに埋める。動画・字幕本体は扱わない（deep-link のみ）。

**受け入れ条件**:

- [x] watch / series の deep-link が正しい形式で生成される
  - 検証: テスト `test_deeplink_format` がパス ✓ (2026-06-16)
- [x] 不正な id（`so…` でない/非数値）はリンク化しない
  - 検証: テスト `test_deeplink_rejects_invalid_id` がパス ✓ (2026-06-16)
- [x] 動画/字幕本体を埋め込む箇所が無い（リンクのみ）
  - 検証: Grep `web/src/` で `<iframe>/<video>/<audio>` が 0 件 ✓ (2026-06-16)

---

## Exit Criteria

- [x] 生成済み `data/*.json` を読み、トップ→一覧→詳細の基本回遊ができる
- [x] 全状態が URL クエリで再現でき、同 URL で同結果（決定的）
- [x] deep-link が id 検証つきで生成される
- [x] `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm build` が通る
  - 173 tests pass / lint clean / typecheck clean / build 7.42kB ✓ (2026-06-16)
