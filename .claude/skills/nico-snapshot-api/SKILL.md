---
name: nico-snapshot-api
description: ニコニコ動画 スナップショット検索API v2 で dアニメストア「ニコニコ支店」の作品データを正しく取得するための開発リファレンス＆ヘルパ。支店データの取り方（q=dアニメストア&targets=tagsExact → レスポンスの channelId==2632720 でクライアント側フィルタ）、取得可能フィールド・sort・filter・ページング、補助データ源（list.json / programlist.json / period HTML）、ToS・CORS の制約、急上昇の出し方、Node の fetch サンプルを内蔵。ニコニコ支店のデータ取得・fetchスクリプト実装・APIクエリ設計・JSON化を行うときに参照する。本店（animestore.docomo.ne.jp）は対象外。
---

# ニコニコ snapshot 検索API（dアニメストア ニコニコ支店）リファレンス

ニコニコ支店の作品データを **公開API＋静的補助源から正しく取得**するための開発リファレンス。
このスキルは「取得（fetch）」の知識に特化する。視聴本体・UI 設計は扱わない。

## 大前提（ToS・制約）— 必ず守る

- **非営利のみ**。商用利用しない。
- **User-Agent 必須**。サービス／アプリ名を入れる（例: `nico-danime-viewer/0.1 (contact: ...)`）。UA 無しは弾かれうる。
- **低頻度アクセス**。連続リクエストは間隔を空ける。索引は毎日 **AM5:00** 更新なので、高頻度取得に意味はない。
- **CORS**: ブラウザ／静的サイトから直接 API は詰まる。→ **ローカル or CI の fetch スクリプトで取得し、静的 JSON 化 → サイトはその JSON を読む**。
- **視聴は公式プレイヤーへ deep-link**。動画本体・字幕は API で扱わない。支店本編は有料チャンネル動画。

## 主データ源: スナップショット検索API v2

- **エンドポイント**（`api.search...` ではない点に注意）:
  ```
  https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search
  ```
- **HTTP**: GET。必須ヘッダに User-Agent。

### 主要クエリパラメータ

| パラメータ | 必須 | 説明 |
|-----------|------|------|
| `q` | 必須（空文字可） | 検索語。支店取得では `dアニメストア` |
| `targets` | 必須 | 検索対象フィールド。`title` / `description` / `tags`、**タグ完全一致は `tagsExact`** |
| `fields` | 任意 | 取得項目（カンマ区切り） |
| `filters[field][op]=val` | 任意 | 絞り込み。`op` は `gte` / `lt` / `gt` / `lte` / `0,1,2...`（範囲・完全一致） |
| `_sort` | 必須 | 並び順。降順は `-` 前置（例 `-viewCounter`、`-startTime`） |
| `_offset` | 任意 | 取得開始位置。**最大 100000** |
| `_limit` | 任意 | 取得件数。**最大 100** |
| `_context` | 必須 | アプリ名（識別子）。例 `nico-danime-viewer` |

### 支店の取り方（最重要）

dアニメ支店は **チャンネル ID `2632720`**。ただし **`channelId` は fields で取得できるが filter 不可**。
したがって取得手順は:

1. `q=dアニメストア` & `targets=tagsExact`（タグ「dアニメストア」完全一致）で取得。
2. `fields` に `channelId` を含める。
3. **レスポンスの `channelId === 2632720` をクライアント側でフィルタ**して支店だけ残す。

> 実証済: この条件で `meta.totalCount` ≒ 87,312。各話単位（例「ぼっち・ざ・ろっく！ #8」）が `viewCounter` 付きで返る。

### fields / sort / filter 可能項目

| フィールド | 取得 | sort | filter | 備考 |
|-----------|:---:|:---:|:---:|------|
| `contentId` | ✓ | | | 動画ID（`sm...` 等） |
| `title` | ✓ | | | |
| `description` | ✓ | | | |
| `viewCounter` | ✓ | ✓ | ✓ | 再生数。ランキングの主軸 |
| `mylistCounter` | ✓ | ✓ | ✓ | |
| `likeCounter` | ✓ | ✓ | ✓ | |
| `commentCounter` | ✓ | ✓ | ✓ | |
| `lengthSeconds` | ✓ | ✓ | ✓ | 尺 |
| `startTime` | ✓ | ✓ | ✓ | 投稿時間（ISO8601）。ページング回避に使う |
| `thumbnailUrl` | ✓ | | | サムネ |
| `channelId` | ✓ | | **✗** | **取得のみ。支店判定はクライアント側** |
| `tags` | ✓ | | | スペース区切り |
| `categoryTags` | ✓ | | | |
| `genre` | ✓ | | ✓ | ジャンル別ブラウズに使う |
| `contentType` | ✓ | | | |

### ページング（_offset 上限の回避）

- `_offset` は最大 100000、`_limit` は最大 100。全件取得は `_offset` を 100 ずつ進める。
- **総件数が `_offset` 上限を超える / 取りこぼし対策**には、`filters[startTime][gte]` / `filters[startTime][lt]` で
  **投稿期間を区切ってウィンドウをずらす**（例: 月単位や四半期単位）。各ウィンドウ内で `_offset` を回す。

### レスポンス形

```jsonc
{
  "meta": { "status": 200, "totalCount": 87312, "id": "..." },
  "data": [
    { "contentId": "sm...", "title": "...", "viewCounter": 12345, "channelId": 2632720, "tags": "...", "genre": "...", "startTime": "2022-..." }
    // ...
  ]
}
```

## 補助データ源（公開・静的・認証不要）

| 用途 | URL | 形 |
|------|-----|----|
| 全作品カタログ | `https://site.nicovideo.jp/danime/static/data/list.json` | `[{title, col_key(あ行), url: nicovideo.jp/series/<id>}]` |
| 今季番組表 | `https://site.nicovideo.jp/danime/static/data/programlist.json` | `[{workweek, worktime, title, series, imgpath, fast}]` |
| クール一覧（過去季も） | `https://anime.nicovideo.jp/period/<年>-<季>-danime.html` | サーバーレンダ HTML。`季 = winter/spring/summer/autumn`（例 `2025-autumn-danime`）。各作品は `/detail/<slug>/`、`-danime` が支店スコープ |

- **シリーズ／クール軸**は補助源が強い（snapshot は各話単位のため、シリーズ束ねには `series` 情報が要る）。
- snapshot（再生数・タグ・各話）と補助源（カタログ・シリーズ・クール）を **contentId / series id / title で突き合わせ**て使う。

## 急上昇（後段）

- API は時系列を返さない。→ `viewCounter` を**日次でスナップショット**し、**前日との差分（伸び率）**で急上昇を算出する。
- スナップショットは肥大化するため git 管理外（`data/snapshots/`）に保存する運用を想定。

## deep-link（視聴導線）

- シリーズ: `https://www.nicovideo.jp/series/<id>`
- 動画: `https://www.nicovideo.jp/watch/<contentId>`
- 本ツールは発見に特化し、**視聴は必ず公式（会員視聴）へ送る**。

## ヘルパスクリプト

- `scripts/fetch-branch.mjs` — 支店作品を snapshot API から取得し、`channelId===2632720` で絞って件数を出すサンプル。
  プロジェクトの `scripts/fetch.mjs` を実装する際の雛形として流用してよい。

  ```bash
  NICO_USER_AGENT="nico-danime-viewer/0.1 (contact: you@example.com)" \
    node .claude/skills/nico-snapshot-api/scripts/fetch-branch.mjs
  ```

## チェックリスト（取得コードを書くとき）

- [ ] User-Agent を付けたか（非空・連絡先入り）。
- [ ] `_context` を付けたか。
- [ ] `channelId === 2632720` でクライアント側フィルタしたか（本店混入なし）。
- [ ] `channelId` を filter に使っていないか（filter 不可）。
- [ ] リクエスト間隔を空けたか（低頻度）。
- [ ] 取得結果を `data/*.json`（git 管理外）へ静的化したか。
- [ ] 100000 件超／取りこぼしに `startTime` ウィンドウで対応したか。
