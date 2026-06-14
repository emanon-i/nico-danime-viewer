# nico-danime-viewer

**dアニメストア ニコニコ支店**の作品を「見やすく・発見しやすく」する非公式ビューア（発見 UI）。

> ⚠️ 個人による非営利・非公式プロジェクトです。dアニメストア／ニコニコ動画とは関係ありません。

## これは何か

dアニメストア ニコニコ支店（docomo 本店とは**別サービス**＝ラインナップもプレイヤーも別。本店は対象外）の
ラインナップを、行動心理にもとづいた“探しやすい”レイアウトで一覧・発見できる静的サイト。
視聴は公式プレイヤーへ **deep-link** で飛ばす（動画本体は扱わない）。

## 仕組み（概要）

ブラウザから API を直接叩くと CORS で詰まるため、**取得と表示を分離**する。

```
[fetch スクリプト (ローカル/CI)]  ──→  data/*.json (静的)  ──→  [静的サイト web/]  ──→  公式プレイヤーへ deep-link
        ニコニコ snapshot 検索API
```

- **データ源（公開・非営利・UA 必須）**: ニコニコ snapshot 検索 API
  `https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search`
  - `q=dアニメストア&targets=tagsExact` で取得 → レスポンスの `channelId == 2632720`（ニコニコ支店）で**クライアント側絞り込み**
    （`channelId` は filter 不可・取得のみ可）
  - 取得フィールド: `contentId` / `title` / `viewCounter` / `tags` / `genre` / `startTime` / `thumbnailUrl` など
- **補助データ**: `site.nicovideo.jp/danime/static/data/list.json`（全作品）、`programlist.json`（今季）、
  `anime.nicovideo.jp/period/<年>-<季>-danime.html`（クール・過去季）

## v1 スコープ

全作品ブラウズ ＋ 再生数ランキング ＋ ジャンル ＋ クール ＋ 公式プレイヤーへの deep-link。

**phase2**: 急上昇（`viewCounter` の日次スナップショット差分）、個人化（視聴履歴）。

## ディレクトリ構成

| パス | 役割 |
|------|------|
| `scripts/` | データ取得スクリプト（snapshot API → `data/*.json`） |
| `data/` | 静的 JSON 出力（生成物。git 管理外。`npm run fetch` で再生成） |
| `web/` | 静的フロントエンド（`data/*.json` を読んで表示） |
| `docs/` | 仕様ドキュメント（Tri-SSD: L1 要件 / L2 構成 / L3 フェーズ） |

## はじめかた

```bash
npm install
npm run fetch    # data/*.json を生成（API 取得。UA 必須）
npm run dev      # ローカル開発サーバ
npm run build    # 静的サイトをビルド
```

> 現状は**土台のみ**。各スクリプトは雛形（未実装）。詳細仕様は `docs/` を参照。

## ライセンス・利用上の注意

- snapshot 検索 API は公開だが **User-Agent 必須**・非営利利用が前提。アクセスは節度を持って行う。
- 本リポジトリは作品データのキャッシュやスクレイピング結果を再配布しない（生成 JSON は git 管理外）。
