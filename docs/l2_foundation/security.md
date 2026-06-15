# セキュリティ設計（L2）

> `foundation.md` の補足。**軽い脅威モデル＋対策レベル**を定める。コード・詳細実装は書かない（L3 / gen-code）。

## 前提（脅威モデル）

- **公開静的サイト（GitHub Pages）／認証なし・サーバなし**。
- **外部（ニコニコ）由来データを描画**し、**公式へ deep-link**する。
- **ビルドは GitHub Actions**（取得・加工・export）。秘密情報を持たない（公開 API のみ・認証不要）。
- 守る対象＝**閲覧ユーザーのブラウザ**（注入・誘導からの保護）と**ビルド経路の健全性**。攻撃面は主に「外部データの描画」と「サプライチェーン」。

## 1. XSS / コンテンツ注入（最重要）

- **脅威**: ニコニコ由来の**タイトル・概要（HTML 混じり）・タグ・各話名**を DOM に描画 → 注入の温床。
- **対策**:
  - 外部文字列は**すべてエスケープ**して描画（`textContent`／フレームワークの自動エスケープを使う。**`innerHTML` の生使用禁止**）。
  - 概要 HTML は**タグ allowlist でサニタイズ**（`<br>` 等の最小限のみ許可、または全除去）。属性・`<script>`・`on*`・`style` は不許可。
  - JSON 取り込み時にも想定外（HTML/制御文字）を正規化。

## 2. 外部リンクの安全化

- **脅威**: reverse tabnabbing、open-redirect、`javascript:` 等のスキーム注入（データ由来 URL を無検証で `href` にする）。
- **対策**:
  - 外部リンク（`nicovideo.jp/watch`・`/series`・公式トップ）は **`rel="noopener noreferrer"` ＋ `target="_blank"`**。
  - **データ由来 URL は検証してから使う**: **スキーム＝`https:` のみ**、**ホスト＝allowlist（`*.nicovideo.jp` 等）**。満たさなければリンク化しない。
  - 自前生成の deep-link は **id を検証**（`contentId`＝`so…`、`series` id＝数値）してからテンプレに埋める。

## 3. CSP（Content-Security-Policy・可能な範囲で）

- **脅威**: 注入されたスクリプト/リソースの実行・外部送信。
- **対策**: Pages はレスポンスヘッダ設定が難しいため **`<meta http-equiv="Content-Security-Policy">`** で絞る:
  - `default-src 'self'`、`script-src 'self'`（**インライン script を避ける**）、`connect-src 'self'`（自分の静的 JSON＝同一オリジンのみ）、
    `img-src` は**ニコニコのサムネ画像ドメイン**（`*.nimg.jp` 等）＋`'self'`、`style-src 'self'`（必要なら最小の `'unsafe-inline'` 検討）、`frame-ancestors 'none'`、`base-uri 'self'`。
  - 可能な範囲で段階的に強める（L3 で確定）。

## 4. ブラウザの通信範囲

- **方針**: 実行時ブラウザは **自分（Pages）の静的 JSON ＋ ニコニコ画像 CDN のみ**にアクセス。
- **niconico の API/RSS へはブラウザから直アクセスしない**（取得はビルド時の Actions のみ）。CORS 的にも安全で、ToS（低頻度・サーバ集約）とも整合。

## 5. ビルド / サプライチェーン（GitHub Actions）

- **脅威**: 依存・action の汚染、過剰権限のトークン、秘密漏洩。
- **対策**:
  - **`GITHUB_TOKEN` は最小権限**（`permissions:` を必要分のみ・原則 `read`、Pages publish に要る箇所だけ `write`）。
  - サードパーティ action は **SHA（またはバージョン）固定**。
  - **`pnpm install --frozen-lockfile`**、**`pnpm audit`／Dependabot** で依存を監視。
  - **秘密情報を持たない・コミットしない**（公開 API のみ・認証不要）。検証用メール等の個人情報もコミットしない。

## 6. 個人データ / プライバシー

- お気に入り/見たは **クライアント IndexedDB のみ・外部送信なし**。アカウント無し・サーバに個人データを置かない。
- 個人情報（検証用メール等）はコミットしない（既存方針）。
- トラッキング/解析を入れる場合は**プライバシー配慮＋最小限**（**v1 は入れない想定**）。

## 7. データ完全性

- 取得データは**公開前に検証**（変更検知・`foundation.md` §5.4）＝**壊れ/空/想定外を公開しない**（前回正常物を保持）。
- SQLite 等の**中間生成物は配信に出さない**（用途別 JSON のみ export）。

## 対策レベルまとめ

| 脅威 | 対策レベル | v1 で必須 |
|------|-----------|:---:|
| XSS/注入 | エスケープ徹底・概要は allowlist サニタイズ・`innerHTML` 禁止 | ✓ |
| 外部リンク | `noopener noreferrer`・スキーム/ホスト allowlist・id 検証 | ✓ |
| CSP | `<meta>` CSP で `default-src 'self'` 等・インライン script 回避 | ✓（可能な範囲） |
| 通信範囲 | ブラウザは自JSON＋画像CDNのみ・API/RSS直叩き禁止 | ✓ |
| サプライチェーン | 最小権限トークン・action 固定・`--frozen-lockfile`・audit | ✓ |
| プライバシー | IndexedDB のみ・送信なし・解析なし | ✓ |
| データ完全性 | 公開前検証・中間物は非配信 | ✓ |
