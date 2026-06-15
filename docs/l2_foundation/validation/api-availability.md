# データ可用性 実証ログ（ニコニコ API）

> L2（`../foundation.md`）の §6「データ可用性の裏付け」の**詳細根拠**。実クエリ・レスポンス例・件数・フィールド確認を記録する。
> L2 本体を膨らませないため詳細はここに分離。結論サマリは L2 本体 §6 を参照。

## 方法

- 実施日: 2026-06-15
- アクセス: **User-Agent 付き**（`nico-danime-viewer/0.1 (verification; contact: ...)`）／**低頻度・数回**／`_limit` 小（3〜5）。
- ToS 遵守（非営利・UA・低頻度）。索引は毎日 AM5:00 更新のため高頻度取得は無意味。
- ツール: PowerShell `Invoke-RestMethod`。`q="dアニメストア"` は UTF-8 で事前パーセントエンコード
  （`d%E3%82%A2%E3%83%8B%E3%83%A1%E3%82%B9%E3%83%88%E3%82%A2`）して URI パース問題を回避。

---

## 検証A: 支店規模・sort・channelId・フィールド

**リクエスト**
```
GET https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search
  ?q=dアニメストア
  &targets=tagsExact
  &fields=contentId,title,viewCounter,startTime,tags,genre,thumbnailUrl,channelId
  &_sort=-viewCounter
  &_limit=5
  &_context=nico-danime-viewer
Header: User-Agent: nico-danime-viewer/0.1 (...)
```

**レスポンス（要約）**: `meta.status=200` / **`meta.totalCount=87,327`**

| channelId | viewCounter | startTime | genre | title |
|-----------|-------------|-----------|-------|-------|
| 2632720 | 382,849 | 2022-11-29 | アニメ | ぼっち・ざ・ろっく！ #8 ぼっち・ざ・ろっく |
| 2632720 | 313,102 | 2022-11-08 | アニメ | ぼっち・ざ・ろっく！ #5 飛べない魚 |
| 2632720 | 286,241 | 2021-03-30 | アニメ | ウマ娘 プリティーダービー Season 2 13 夢をかける |
| 2632720 | 284,752 | 2018-01-05 | アニメ | ゆるキャン△ 第1話 ふじさんとカレーめん |
| 2632720 | 277,875 | 2022-12-27 | アニメ | ぼっち・ざ・ろっく！ #12 君に朝が降る |

**item0 フィールド確認**
- `contentId = so41433905`（チャンネル動画は `so…`）
- `thumbnailUrl = https://nicovideo.cdn.nimg.jp/thumbnails/41433905/41433905.69271658`
- `tags = アニメ dアニメストア ぼっち・ざ・ろっく！ 2022年秋アニメ 結束バンド(ぼざろ) …`（スペース区切り）

**判明**
- `totalCount` が想定（~8.7万）と一致。`channelId==2632720` が `data[]` に含まれクライアント側で絞れる。
- `_sort=-viewCounter` は降順で機能。設計で使う全 fields が返却。
- ⚠ `genre` は粗く、観測範囲では一律「アニメ」。ジャンル軸には不足 → `tags`/`categoryTags` を主軸にする。

---

## 検証B: filter（startTime）と TZ 要件

**B-1（失敗）**: `filters[startTime][gte]=2025-01-01T00:00:00`（タイムゾーンなし）
→ **HTTP 400 Bad Request**。

**B-2（成功）**: `filters[startTime][gte]=2025-01-01T00:00:00+09:00`（TZ 付与）, `_sort=-startTime`, `_limit=3`
→ `meta.totalCount=17,992`（全体 87,327 から減少＝filter 有効）

| channelId | startTime | title |
|-----------|-----------|-------|
| 2632720 | 2026-06-15 00:30 | ゴーストコンサート : missing Songs 第11話 臨命終時 |
| 2632720 | 2026-06-15 00:30 | 左ききのエレン 第10話 俺の人生は始まらなかったな |
| 2632720 | 2026-06-15 00:30 | ニワトリ・ファイター 11羽 孤掌難鳴 |

**判明**
- `filters[startTime][gte]` は機能するが **ISO8601＋タイムゾーン（`+09:00`）が必須**（無いと 400）。
- 全件取得時の `_offset` 上限（100000）回避は、この `startTime` 期間ウィンドウで分割する方針が有効。
- `_sort=-startTime` で新着（当日投稿）まで取得できることを確認。

---

## 検証C: 補助データ源（静的・認証不要）

### C-1: 全作品カタログ `list.json`
`GET https://site.nicovideo.jp/danime/static/data/list.json` → **6,698 件**

- keys: `title, col_key, url`
- sample:
  ```json
  { "title": "ああっ女神さまっ", "col_key": "あ", "url": "https://www.nicovideo.jp/series/109288" }
  ```
- `url` がシリーズ（`/series/<id>`）。snapshot の各話とシリーズ束ねの突き合わせに使える。

### C-2: 今季番組表 `programlist.json`
`GET https://site.nicovideo.jp/danime/static/data/programlist.json` → **75 件**

- keys: `workweek, worktime, title, series, imgpagh, fast`
- sample:
  ```json
  { "workweek": "oth", "worktime": "06:00", "title": "あんた私のことを好きだったの？",
    "series": 559658, "imgpagh": "https://resource.video.nimg.jp/series/tmb/1/2632720/559658.1777000221", "fast": "" }
  ```
- ⚠ 画像キーは **`imgpagh`**（`imgpath` ではない・綴り注意）。`series` は数値 id。

---

## 制約・要対応の総括

| 項目 | 実証で判明 | 対応 |
|------|-----------|------|
| `channelId` filter | 不可（取得のみ） | クライアント側 `==2632720` 絞り込み |
| `startTime` filter | TZ 必須（無し→400） | ISO8601＋`+09:00` を厳守。期間ウィンドウ分割にも使用 |
| `genre` 粒度 | 粗い（一律「アニメ」） | ジャンル/近ジャンル・リコメンドは `tags`/`categoryTags` 主軸 |
| 急上昇（時系列） | API は返さない | `viewCounter` 日次差分を自前蓄積（phase2） |
| 個人化（履歴） | API に無い | 視聴履歴を集める別プロジェクト依存・本ビューアのスコープ外（将来） |
| 全件上限 | `_offset`≤100000 / `_limit`≤100 | `startTime` 期間ウィンドウ＋ページング |
| `programlist` 画像キー | `imgpagh`（綴り） | その綴りで参照 |

---

# 検証（2回目）: ランキング・時間窓メトリクスの支店スコープ取得可否

> 実施日 2026-06-15。UA 付き・低頻度・非営利。月間/週間/急上昇ランキングを「dアニメ支店」スコープで**直接取れるか**の切り分け。

## 1. snapshot API: 全 fields と時間窓メトリクスの有無

`fields` に既知の全項目を要求 → **返却された 16 フィールド**（item0）:

```
categoryTags, channelId, commentCounter, contentId, description, genre,
lastCommentTime, lengthSeconds, likeCounter, mylistCounter, startTime,
tags, thumbnailUrl, title, userId, viewCounter
```

- **時間窓メトリクスは存在しない。** `viewCounter` は**累計のみ**（「直近7日の再生数」等の期間内カウントは無い）。
  `lastCommentTime`（最終コメント時刻）はあるが「最近活発」止まりで再生数の伸びではない。
- **sort 可能フィールド（実証・各 `status=200`、top が変化）**:
  `-viewCounter` / `-mylistCounter` / `-commentCounter` / `-likeCounter` / `-lastCommentTime`（＋既出 `-startTime`）。
  いずれも**絶対値/累計**。**期間内デルタでの sort は不可**。

## 2. ランキング系 API/RSS の現行エンドポイント

| 試行 | 結果 |
|------|------|
| 旧 RSS `nicovideo.jp/ranking/genre/anime?...&rss=2.0` | **廃止扱い**。`Content-Type: text/html` で React SPA の HTML を返す（RSS ではない）。XML としては実質使えない |
| 旧 `nvapi …/v1/ranking/teiban/<genre>` | **404/400**（このパスは無効） |
| **現行 `nvapi.nicovideo.jp/v1/ranking/genre/<key>?term=<term>`** | **OK（200・100件）**。要ヘッダ `X-Frontend-Id: 6`／`X-Frontend-Version: 0` |
| `term` 値 | **`hour` / `24h` / `week` / `month` / `total` すべて 200**（毎時・24時間・週間・月間・全期間）。「急上昇」専用 term は無い |
| `pageSize`/`page` パラメータ | `pageSize` を付けると **400 INVALID_PARAMETER**（無効パラメータ。付けない） |
| ジャンルキー一覧 `nvapi …/v1/genres` | OK。`anime=アニメ`, `game=ゲーム`, `music_sound=…` 等。アニメのキーは **`anime`** |

ランキング item の構造（実物・`genre/anime?term=24h` top）:

```
id=so46418087  title=黄泉のツガイ 第十一話「兄と弟」
owner: type=channel  id=ch2650080  name=黄泉のツガイ
count: {"view":65317,"comment":9508,"mylist":137,"like":1625}
（tags フィールドは ranking item に無い）
```

## 3. 支店スコープに絞れるか

| 方法 | 結果 |
|------|------|
| (a) `channelId=2632720` で絞る | **不可**。ranking item の `owner.id` は**作品ごとの個別チャンネル**（`ch2650080`「黄泉のツガイ」等）。`genre/anime` の **top100 に 支店(2632720) は 0 件**（`term=24h`/`month` とも）。ranking に channel フィルタ引数も無い |
| (b) タグ "dアニメストア" でランキング | **不可**。`genre/anime?term=week&tag=dアニメストア` は **404**。tag 絞り込みのランキングは現行エンドポイントに無い |
| (c) どの粒度まで絞れるか | ジャンル（`anime` 等の固定キー）止まり。**チャンネル／タグ単位の絞り込みは不可** |

> 要点: 公開ランキング(`genre/anime`)は**ニコニコの通常アニメchの母集団**で、**dアニメ支店(2632720)は事実上現れない**。
> 支店だけの月間/週間/急上昇ランキングは**この API からは直接取得できない**。

## 4. 結論表（種別 × 取得可否）

| 種別 | API で直接・支店スコープ取得 | 必要な対応 |
|------|------------------------------|-----------|
| **総合（累計再生数）** | △ 半分可 | snapshot を `-viewCounter`＋`channelId==2632720` 絞りで **累計ランキング**は作れる（＝全期間 cumulative）。公開 ranking API では支店スコープ不可 |
| **新着** | ○ 可 | snapshot `-startTime`＋支店絞りで取得可（既出）。ランキング API 不要 |
| **週間** | ✗ 直接不可 | snapshot に期間内メトリクス無し／ranking API は支店スコープ不可 → **`viewCounter` を日次蓄積し 7日デルタを自前計算** |
| **月間** | ✗ 直接不可 | 同上 → **30日デルタを自前計算**（公開 ranking の month は支店に絞れない） |
| **急上昇（伸び率）** | ✗ 直接不可 | 専用 term も無い → **日次 `viewCounter` 履歴のデルタ／伸び率を自前算出**（snapshot・ranking いずれからも直接は不可） |

**最終結論**: 「dアニメ支店スコープの**週間・月間・急上昇**ランキング」は、snapshot/公開ランキング API の**どちらからも直接は取得できない**。
実現するには **`viewCounter`（累計）を日次でスナップショット蓄積し、期間デルタ（週/月）・伸び率（急上昇）を自前計算**する必要がある（既存の「将来機能＝自前蓄積」方針と一致）。
**総合（累計）と新着のみ snapshot から支店スコープで直接構築可能**。
