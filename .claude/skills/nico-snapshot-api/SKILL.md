---
name: nico-snapshot-api
description: ニコニコ動画の公開APIで dアニメストア「ニコニコ支店」の作品データを正しく取得するための開発リファレンス＆ヘルパ。snapshot 検索API v2（作品メタ・タグ・再生数・投稿日。q=dアニメストア&targets=tagsExact → channelId==2632720 でクライアント側フィルタ）、nvapi ランキング（genre/<key>?term=...）、nvapi v2 series（各話一覧・話順・owner.channel.id==ch2632720 で支店判定）、補助源（list.json の col_key=五十音 / programlist.json / period HTML）、ToS・CORS の制約、Node の fetch サンプルを内蔵。ニコニコ支店のデータ取得・ランキング・各話取得・fetchスクリプト実装・APIクエリ設計・JSON化を行うときに参照する。本店（animestore.docomo.ne.jp）は対象外。
---

# ニコニコ API（dアニメストア ニコニコ支店）リファレンス

ニコニコ支店の作品データを **公開 API ＋静的補助源から正しく取得**するための開発リファレンス。
取得（fetch）の知識に特化する。視聴本体・UI 設計は扱わない。実測の裏付けは `validation/api-availability.md` を参照。

**公式ガイド**: https://site.nicovideo.jp/search-api-docs/snapshot （Snapshot 検索API v2）。本書はこのガイドに準拠する。

## 大前提（ToS・制約）— 必ず守る（要点。全文は公式ガイド参照）

- **非営利のみ**。商用利用しない。
- **User-Agent 必須**。サービス／アプリ名を入れる（例: `nico-danime-viewer/0.1 (contact: ...)`）。UA 無しは弾かれうる。
- **連打しない**: **前回のレスポンスにかかった時間と同じだけ待ってから**次を投げる。同時接続も控える。
- **`status` が 503 のときは 5 分以上空けてからリトライ**。
- データ（索引）は毎日 **AM5:00 頃**更新（実際の切替時刻は後述 `version` で確認できる）。高頻度取得に意味はない。
- **CORS**: ブラウザ／静的サイトから直接 API は詰まる。→ **ローカル or CI の fetch スクリプトで取得し、静的 JSON 化 → サイトはその JSON を読む**。
- **視聴は公式プレイヤーへ deep-link**。動画本体・字幕は API で扱わない。支店本編は有料チャンネル動画。

## API の信頼度の階層

依存先は安定度で 3 段階。**snapshot で取れるものは snapshot を優先**し、非公式に頼る箇所は**必ず変更検知アサートで守る**（構造変化で取得を fail させ、壊れた／空の JSON を公開しない）。

| 段階 | 対象 | 備考 |
|------|------|------|
| **公式（最も安定）** | snapshot 検索API v2 | 公式ドキュメントあり: https://site.nicovideo.jp/search-api-docs/snapshot |
| **半公式** | チャンネル RSS `ch.nicovideo.jp/ch2632720/video?rss=2.0` | 公開フィード。新着の高頻度源 |
| **非公式（ドキュメント無し・予告なく仕様変更/廃止されうる）** | nvapi（`/v1/ranking…`, `/v2/series/<id>`、要 `X-Frontend-Id: 6`）／静的 JSON（list.json・programlist.json）／period HTML | いつ壊れてもおかしくない前提で扱う |

## 主データ源: snapshot 検索API v2

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
| `filters[field][op]=val` | 任意 | 絞り込み。`op` は `gte` / `lt` / `gt` / `lte` / `0,1,2…`（範囲・完全一致） |
| `_sort` | 必須 | 並び順。降順は `-` 前置（例 `-viewCounter`、`-startTime`） |
| `_offset` | 任意 | 取得開始位置。**最大 100000** |
| `_limit` | 任意 | 取得件数。**最大 100** |
| `_context` | 必須 | アプリ名（識別子）。例 `nico-danime-viewer` |

### 支店の取り方（最重要）

dアニメ支店は **チャンネル ID `2632720`**。`channelId` は fields で取得できるが **filter 不可**。手順:

1. `q=dアニメストア` & `targets=tagsExact`（タグ「dアニメストア」完全一致）で取得。
2. `fields` に `channelId` を含める。
3. **レスポンスの `channelId === 2632720` をクライアント側でフィルタ**して支店だけ残す。

この条件で `meta.totalCount` は約 **87,327**。各話単位（例「ぼっち・ざ・ろっく！ #8」）が `viewCounter` 付きで返る。

### fields / sort / filter（公式準拠）

| フィールド | 取得 | sort | filter | 備考 |
|-----------|:---:|:---:|:---:|------|
| `contentId` | ✓ | | ✓ | 動画ID。支店各話は `so…`。filter 書式 `filters[contentId][0]=so…` |
| `title` | ✓ | | | `targets` でも使う |
| `description` | ✓ | | | 各話のあらすじ。HTML（`<br>` 等）混じり |
| `userId` | ✓ | | | チャンネル動画では空 |
| `channelId` | ✓ | | **✗** | **取得のみ。支店判定はクライアント側** |
| `viewCounter` | ✓ | ✓ | ✓ | 再生数（累計） |
| `mylistCounter` | ✓ | ✓ | ✓ | |
| `likeCounter` | ✓ | ✓ | ✓ | |
| `commentCounter` | ✓ | ✓ | ✓ | |
| `lengthSeconds` | ✓ | ✓ | ✓ | 尺（秒） |
| `startTime` | ✓ | ✓ | ✓ | 投稿時間（ISO8601）。**filter は TZ 必須（後述）** |
| `lastCommentTime` | ✓ | ✓ | ✓ | 最終コメント時刻 |
| `lastResBody` | ✓ | | | 最新コメント本文 |
| `thumbnailUrl` | ✓ | | | サムネ |
| `categoryTags` | ✓ | | ✓ | |
| `tags` | ✓ | | ✓ | スペース区切り |
| `genre` | ✓ | | ✓ | 値の扱いは下記「genre」を参照 |
| `contentType` | ✓ | | ✓ | enum: `long` / `short` |
| `tagsExact` | （filter/targets 専用） | | ✓ | タグの完全一致（取得フィールドではない） |
| `genre.keyword` | （filter 専用） | | ✓ | `genre` の完全一致 filter 用 |

- **`contentId` は filter 可能**（書式 `filters[contentId][0]=so…`）。**`channelId` は filter 不可**（API が許可 filter フィールドを列挙し、その中に `channelId` は含まれない）→ 支店判定は取得後にクライアント側 `channelId==2632720`。
- **`startTime` の filter は ISO8601＋タイムゾーン必須**: `filters[startTime][gte]=2025-01-01T00:00:00+09:00`。TZ を付けないと 400。期間ウィンドウ分割にもこの形式を使う。
- `tagsExact` / `genre.keyword` は**取得フィールドではなく filter/targets 専用**（完全一致）。

### ページング（_offset 上限の回避）

- `_offset` は最大 100000、`_limit` は最大 100。順次取得は `_offset` を 100 ずつ進める。
- 総件数が `_offset` 上限を超える／取りこぼし対策には、`filters[startTime][gte]` / `filters[startTime][lt]`（TZ 付き）で
  **投稿期間を区切ってウィンドウをずらす**（例: 月単位や四半期単位）。各ウィンドウ内で `_offset` を回す。

### レスポンス形

```jsonc
{
  "meta": { "status": 200, "totalCount": 87327, "id": "..." },
  "data": [
    { "contentId": "so...", "title": "...", "viewCounter": 12345, "channelId": 2632720, "tags": "...", "genre": "アニメ", "startTime": "2022-..." }
    // ...
  ]
}
```

### version（鮮度確認・変更検知）

- `GET https://snapshot.search.nicovideo.jp/api/v2/snapshot/version` → `{ "last_modified": "2026-06-15T07:14:26+09:00" }`
- 現在参照中データの**切替日時**。fetch 前に取得して前回値と比較すれば、索引が更新されたか（再取得する価値があるか）を低コストで判定でき、変更検知にも使える。

### genre

支店では `genre` は **99.95%「アニメ」一色**でサブジャンルの判別に使えない。
**ジャンル軸では使わず、`tags` / `categoryTags` を主軸**にする。

### 概要（あらすじ）

各話の `description` は**その話のあらすじ**（HTML 混じり）。シリーズ直下の要約は空のことが多い。
**シリーズ概要は第1話の `description` を流用**し、**HTML タグ（`<br>` 等）を除去**して表示する。

## ランキング（nvapi）

- **エンドポイント**: `https://nvapi.nicovideo.jp/v1/ranking/genre/<key>?term=<term>`
- **必須ヘッダ**: `X-Frontend-Id: 6`（加えて `X-Frontend-Version: 0`、`X-Niconico-Language: ja-jp`）。
- `<key>`: ジャンルキー（`anime`, `game`, `music_sound` 等。一覧は `https://nvapi.nicovideo.jp/v1/genres`）。
- `<term>`: **`hour` / `24h` / `week` / `month` / `total`**。
- 返却は 100 件。item は `id`(=contentId)、`title`、`count.view`、`owner`（`ownerType`/`id`/`name`）等。
- **注意**: `pageSize`/`page` を付けると 400（無効パラメータ）。`v1/ranking/teiban/<key>` パスは無効。

### 支店スコープには絞れない

- ranking item の `owner` は**作品ごとの個別チャンネル**（`ch2650080` 等）で、`genre/anime` の top100 に
  **dアニメ支店（2632720）は現れない**。ranking に channel フィルタ引数は無い。
- タグ指定（`?tag=dアニメストア`）のランキングは **404**（不可）。
- → **支店スコープの週/月/急上昇ランキングは、この API からは取得できない。**

## 各話・シリーズ（nvapi v2 series）

- **エンドポイント**: `https://nvapi.nicovideo.jp/v2/series/<id>`（`X-Frontend-Id: 6`）。
- 返却: `data.detail` ＋ `data.items[]`。
  - `detail`: `id`, `title`, `thumbnailUrl`, `owner` 等。
  - **`detail.owner.channel.id == "ch2632720"` で支店シリーズと判定できる。**
  - `items[]`: **第1話→最終話の順**。各 `video` に `id`(=contentId)、`title`、`count.view`、`thumbnail`、`registeredAt` 等。
- **各話一覧・話順・各話再生数の主源**。snapshot は series id を持たないため、各話の束ねはこの API を使う。
- シリーズ id は補助カタログ（list.json の `url` = `/series/<id>`）から得る。

## 補助データ源（公開・静的・認証不要）

| 用途 | URL | 形 |
|------|-----|----|
| 全作品カタログ／**五十音** | `https://site.nicovideo.jp/danime/static/data/list.json` | `[{title, col_key, url: nicovideo.jp/series/<id>}]` |
| 今季番組表 | `https://site.nicovideo.jp/danime/static/data/programlist.json` | `[{workweek, worktime, title, series, imgpagh, fast}]` |
| クール一覧（過去季も） | `https://anime.nicovideo.jp/period/<年>-<季>-danime.html` | サーバーレンダ HTML。`季 = winter/spring/summer/autumn`（例 `2025-autumn-danime`）。各作品は `/detail/<slug>/`、`-danime` が支店スコープ |

- `programlist.json` の画像キーは **`imgpagh`**。`series` は数値のシリーズ id。
- snapshot（再生数・タグ・各話メタ）と補助源（カタログ・シリーズ id・クール）を **contentId / series id / title で突き合わせ**て使う。

### 五十音（list.json `col_key`）

- `col_key` は**読みベースの五十音「行」バケット**（`あ / か / さ / た / な / は / ま / や / ら / わ`）。支店カタログ全件に付与され、欠落は無い。
- **完全な読み（yomi）は無い** → 五十音ボタンで「行」に括るのは正確だが、**行内の厳密な50音順ソートは不可**（タイトル文字列順で代替）。

### クール判定

- `startTime`（ニコ投稿日）から判定できるのは**現行季のみ**。過去作はバルク投稿日で放送季と無関係。
- 過去季は `programlist.json` ／ period ページを補助に使い、判定できない作品は「クール不明」とする。

## deep-link（視聴導線）

- シリーズ: `https://www.nicovideo.jp/series/<id>`
- 動画: `https://www.nicovideo.jp/watch/<contentId>`
- 発見に特化し、**視聴は必ず公式（会員視聴）へ送る**。

## ヘルパスクリプト

- `scripts/fetch-branch.mjs` — 支店作品を snapshot API から取得し、`channelId===2632720` で絞って件数を出すサンプル。
  プロジェクトの `scripts/fetch.mjs` を実装する際の雛形として流用してよい。

  ```bash
  NICO_USER_AGENT="nico-danime-viewer/0.1 (contact: you@example.com)" \
    node .claude/skills/nico-snapshot-api/scripts/fetch-branch.mjs
  ```

## チェックリスト（取得コードを書くとき）

- [ ] User-Agent を付けたか（非空・連絡先入り）。nvapi は `X-Frontend-Id: 6` も。
- [ ] `_context` を付けたか（snapshot）。
- [ ] `channelId === 2632720` でクライアント側フィルタしたか（本店混入なし）。
- [ ] `channelId` を filter に使っていないか（不可。支店判定はクライアント側。なお `contentId` は filter 可）。
- [ ] `startTime` の filter に TZ（`+09:00`）を付けたか。
- [ ] ジャンル分けに `genre` を使っていないか（tags/categoryTags 主軸）。
- [ ] 各話一覧は nvapi v2 series から取っているか。
- [ ] リクエスト間隔を空けたか（低頻度）。
- [ ] 取得結果を `data/*.json`（git 管理外）へ静的化したか。
- [ ] 100000 件超／取りこぼしに `startTime` ウィンドウで対応したか。

## 依存禁止の廃止 API

2024 年のサイバー攻撃後に**提供終了・代替なし**となった API 群。**これらには依存しない**（出典: https://blog.nicovideo.jp/niconews/182541.html 2024-08-01）。

- `nvcomment.nicovideo.jp/legacy/*`
- `flapi.nicovideo.jp/api/*`
- `getflv/*`
- `getpostkey/*`
- その他 flapi サーバ系 API

## 参考リンク

- 公式ガイド（正本）: https://site.nicovideo.jp/search-api-docs/snapshot
- 廃止 API の告知: https://blog.nicovideo.jp/niconews/182541.html （2024-08-01）
- 非公式まとめ（例 https://github.com/niconicolibs/api ）は**約4年前の情報で廃止分を含む**。**エンドポイントは必ず実機で生存確認してから使う**（鵜呑みにしない）。
