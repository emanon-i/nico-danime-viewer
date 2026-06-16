# PH-0005: ユーザー状態＆UX（お気に入り/見た・設定・テーマ・レスポンシブ）

## 目的
クライアント側のユーザー状態（お気に入り/見た localStorage）、設定/情報モーダル（export/import・キャッシュ削除）、ダーク/ライトテーマ、ⓘ ツールチップ、レスポンシブ、empty/欠損表示を実装し、UX を仕上げる。個人化データはサーバへ送らない。screens.md・foundation §1.1 準拠。

## 機能一覧

### F-0034: お気に入り／見たマーク（localStorage）
**対応REQ**: REQ-0015（screens.md カード内訳/§2, dataflow.md §6）

一覧カード（左上）と詳細に **♥ お気に入り／✓ 見た** トグル。状態は **localStorage**（「id＋フラグ」程度・クライアント側・**サーバに出さない**）。一覧で「♥お気に入りだけ／✓未視聴だけ」の絞り込み（任意）。♥/✓ と [↗] はタップ領域が重ならない位置に置く。

**受け入れ条件**:
- [ ] ♥/✓ トグルが localStorage に保存され、再読込で復元される
  - 検証: テスト `test_favorite_watched_persist`
- [ ] 「♥お気に入りだけ／✓未視聴だけ」で一覧が絞れる
  - 検証: テスト `test_filter_by_favorite_unwatched`
- [ ] 状態を外部へ送信する通信が発生しない
  - 検証: テスト `test_no_network_for_user_state`
- [ ] ♥/✓（左上）と [↗]（右上）のタップ領域が重ならない
  - 検証: テスト `test_tap_targets_separate`

---

### F-0035: 設定／情報モーダル（export/import・キャッシュ削除）
**対応REQ**: REQ-0016（screens.md 設定/情報モーダル）

ヘッダ ⚙ で開く 2 区画モーダル（Esc/×/背景で閉じる）。**設定**＝お気に入り/見たの **export/import（JSON ファイル）**・**キャッシュ（localStorage）削除**・将来設定の受け皿。**情報**＝リポジトリ（公開可否で出し分け）／**データ最終更新時刻**（export メタ）／主要出典リンク。外部リンクは `noopener noreferrer`＋`target=_blank`。

**受け入れ条件**:
- [ ] ⚙ でモーダルが開き、Esc/×/背景クリックで閉じる
  - 検証: テスト `test_settings_modal_open_close`
- [ ] お気に入り/見たを JSON で export / import でき、ラウンドトリップで一致する
  - 検証: テスト `test_export_import_roundtrip`
- [ ] キャッシュ削除で localStorage のマーク等が消える
  - 検証: テスト `test_clear_cache`
- [ ] 「データ最終更新」が export メタの代表タイムスタンプを表示する
  - 検証: テスト `test_last_updated_display`
- [ ] リポジトリリンクが公開可否で出し分けられる（非公開時は非表示/「準備中」）
  - 検証: テスト `test_repo_link_visibility`

---

### F-0036: ダーク/ライトテーマ切替
**対応REQ**: REQ-0012（screens.md ヘッダ, foundation §1.1）

ヘッダのトグル（☀/🌙）で即時切替。既定は OS 追従（`prefers-color-scheme`）、ユーザー選択は **localStorage**（**テーマ設定のみ＝個人化データではない**）。サーバ不要・遷移なし。

**受け入れ条件**:
- [ ] 既定が `prefers-color-scheme` に追従する
  - 検証: テスト `test_theme_follows_os_default`
- [ ] トグルでテーマが即時切替され localStorage に保存・再読込で復元される
  - 検証: テスト `test_theme_toggle_persist`
- [ ] 保存されるのはテーマ設定のみ（視聴履歴等を保存しない）
  - 検証: テスト `test_theme_storage_scope`

---

### F-0037: ⓘ ツールチップ（各画面1か所集約）
**対応REQ**: REQ-0002（screens.md ⓘ 文言表）

ⓘ は乱発せず、**各画面で最も目立つ 1 か所に集約**（トップ＝TOP10見出し、一覧＝「並び替え」、詳細＝主要メタ）。文言は利用者向け（API 内部名・機構用語を出さない）。グローバルな出典/更新時刻は ⚙ モーダルが担う。

**受け入れ条件**:
- [ ] 各画面の ⓘ が screens.md の指定位置に1か所だけ存在する
  - 検証: テスト `test_info_tooltip_single_per_screen`
- [ ] ⓘ 文言が screens.md の利用者向け表記と一致する
  - 検証: テスト `test_info_tooltip_copy`
- [ ] カードの各フィールド・各話行・タグごとに ⓘ を付けない
  - 検証: テスト `test_no_per_field_tooltip`

---

### F-0038: レスポンシブ（モバイル/デスクトップ/ウルトラワイド）
**対応REQ**: REQ-0001（screens.md レスポンシブ注記）

グリッド列数は幅で増える（モバイル2／タブレット3／デスクトップ4〜6／ウルトラワイド7〜8+、カード最小幅維持で列を足す）。モバイルは左サイドバーを「絞り込み・並び」ドロワーに格納、デスクトップ/UW は常駐。TOP10/五十音は横スワイプ（バー非表示）。一覧グリッドは横スクロールにしない。

**受け入れ条件**:
- [ ] ブレークポイントごとに想定列数になる（min幅維持で列増）
  - 検証: テスト `test_grid_columns_by_breakpoint`（レイアウトアサート）
- [ ] モバイルでフィルタがドロワー化し、選択後に閉じる
  - 検証: テスト `test_mobile_filter_drawer`
- [ ] 一覧グリッドは縦グリッド（横スクロールしない）／TOP10 は横スワイプ
  - 検証: テスト `test_grid_vertical_top10_horizontal`

---

### F-0039: empty／欠損表示（配信停止作品）
**対応REQ**: REQ-0001（screens.md empty 状態, foundation 非機能）

配信停止っぽい作品もそのまま扱い、各話/メタ/公式リンクが取れない場合は**欠損を正直に出す**（「取得できませんでした」）。取れたメタ・生存リンク・タグ回遊は生かす。**変更検知（fetch の fail）とは別**＝個別作品の欠損は fail させずその作品だけ empty 表示。

**受け入れ条件**:
- [ ] `is_available=0`/各話空で empty メッセージが出る（誤魔化さない）
  - 検証: テスト `test_empty_message_render`
- [ ] 取れたメタ・生存している公式リンク・タグ回遊のみ表示する
  - 検証: テスト `test_empty_shows_partial_only`
- [ ] 個別作品の欠損で画面全体やビルドが壊れない
  - 検証: テスト `test_empty_does_not_break_app`

---

## Exit Criteria
- [ ] お気に入り/見た・テーマが localStorage に保存され、export/import・キャッシュ削除が動く（サーバ送信なし）
- [ ] ⓘ が各画面1か所、レスポンシブ3段、empty 表示が screens.md どおり
- [ ] 個人化データがサーバへ送られないことがテストで確認できる
- [ ] `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm build` が通る
