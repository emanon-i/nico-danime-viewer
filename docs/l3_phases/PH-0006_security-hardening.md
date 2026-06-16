# PH-0006: セキュリティ硬化（XSS・外部リンク・CSP・通信範囲）

## 目的
外部（ニコニコ）由来データの描画と公式 deep-link を安全化する。XSS 対策（エスケープ徹底・概要 HTML の allowlist サニタイズ）、外部リンク安全化（`noopener`＋URL/id allowlist）、`<meta>` CSP、ブラウザ通信範囲の制限、サプライチェーン硬化を適用し、監査チェックを通す。security.md 準拠。

## 機能一覧

### F-0040: XSS／コンテンツ注入対策
**対応REQ**: 非機能（security.md §1）

ニコニコ由来のタイトル・概要（HTML 混じり）・タグ・各話名を描画する際、**外部文字列はすべてエスケープ**（`textContent` 使用・**`innerHTML` の生使用禁止**）。概要 HTML は**タグ allowlist でサニタイズ**（`<br>` 等の最小限のみ、`<script>`/`on*`/`style`/属性は不許可）。JSON 取り込み時にも HTML/制御文字を正規化。

**受け入れ条件**:
- [ ] 外部文字列が `textContent` 等でエスケープ描画され、`innerHTML` の生使用が無い
  - 検証: テスト/Grep `test_no_raw_innerHTML`
- [ ] 概要サニタイザが `<script>`/`on*`/`style`/危険属性を除去し、`<br>` 等のみ許可する
  - 検証: テスト `test_sanitize_overview_allowlist`（注入文字列を入れて無害化を確認）
- [ ] 取り込み時に HTML/制御文字が正規化される
  - 検証: テスト `test_ingest_normalizes_html`

---

### F-0041: 外部リンクの安全化（allowlist＋id検証）
**対応REQ**: 非機能（security.md §2）

外部リンク（watch/series/公式トップ）は **`rel="noopener noreferrer"`＋`target="_blank"`**。**データ由来 URL は検証**（スキーム＝`https:` のみ・ホスト＝allowlist `*.nicovideo.jp` 等）してから使い、満たさなければリンク化しない。自前生成 deep-link は id 検証（`so…`／数値）済みのものだけ。

**受け入れ条件**:
- [ ] 外部リンクに `rel="noopener noreferrer"` と `target="_blank"` が付く
  - 検証: テスト `test_external_link_rel`
- [ ] `https:` 以外・許可外ホスト・`javascript:` 等はリンク化されない
  - 検証: テスト `test_url_allowlist_rejects_bad_scheme_host`
- [ ] 不正 id（非 `so…`／非数値）は deep-link 化されない
  - 検証: テスト `test_deeplink_id_validation`（PH-0003 F-0026 と整合）

---

### F-0042: CSP（`<meta>` で可能な範囲）
**対応REQ**: 非機能（security.md §3）

GitHub Pages はレスポンスヘッダ設定が難しいため **`<meta http-equiv="Content-Security-Policy">`** で絞る: `default-src 'self'`／`script-src 'self'`（インライン script 回避）／`connect-src 'self'`／`img-src 'self' *.nimg.jp`／`base-uri 'self'` 等。`frame-ancestors` は meta では強制されない旨を明記（必要なら実ヘッダ可能なホスティング）。

**受け入れ条件**:
- [ ] ビルド成果物に CSP `<meta>` が含まれ、`default-src 'self'` 等が設定される
  - 検証: テスト `test_csp_meta_present`（`dist/index.html` の CSP 検査）
- [ ] インライン script を使わない（`script-src 'self'` と整合）
  - 検証: テスト/Grep `test_no_inline_script`
- [ ] `img-src` がニコニコ画像 CDN（`*.nimg.jp` 等）＋`'self'` に限定される
  - 検証: テスト `test_csp_img_src`

---

### F-0043: 通信範囲の制限＋サプライチェーン硬化＋監査
**対応REQ**: 非機能（security.md §4/§5/§7）

実行時ブラウザは**自分の静的 JSON ＋ニコニコ画像 CDN のみ**にアクセス（API/RSS 直叩き禁止）。依存は `pnpm install --frozen-lockfile` で固定、秘密情報・個人情報を持たない/コミットしない。中間生成物（SQLite）は配信に出さない。security.md の対策レベル表を監査チェックリストとして通す。

**受け入れ条件**:
- [ ] ブラウザが API/RSS を直叩きせず、自 JSON＋画像 CDN のみへ通信する
  - 検証: テスト/Grep `test_browser_only_self_and_cdn`
- [ ] `--frozen-lockfile` でビルドが固定され、リポジトリに秘密/個人情報が無い
  - 検証: テスト/コマンド（lockfile 整合・secret scan）
- [ ] 配信物に SQLite/中間生成物が含まれない
  - 検証: テスト `test_no_intermediate_in_dist`
- [ ] security.md 対策レベル表の v1 必須項目がすべて満たされる（監査チェック）
  - 検証: チェックリスト（各項目に対応テスト/Grep がパス）

---

## Exit Criteria
- [ ] 注入文字列を入れても XSS が成立しない（サニタイズ/エスケープのテストがパス）
- [ ] 外部リンクが allowlist＋id 検証＋`noopener` で安全化される
- [ ] CSP `<meta>` が効き、ブラウザ通信が自 JSON＋画像 CDN に限定される
- [ ] security.md 対策レベル表の v1 必須が監査チェックで全て満たされる
- [ ] `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm build` が通る
