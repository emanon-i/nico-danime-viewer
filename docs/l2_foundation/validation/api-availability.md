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

---

# 検証（3回目）: 五十音・ジャンル所在・概要・各話取得元・出所マップ

> 実施日 2026-06-15。UA 付き・低頻度・非営利。

## A. 五十音フィードビリティ（最重要）

### (1) snapshot に読み仮名フィールドはあるか → **無い**
snapshot の全16フィールドに `yomi/kana/読み` 系は**存在しない**（2回目検証で列挙済み。`title` は表記のみ）。

### (2) 五十音インデックスを取れる経路 → **list.json の `col_key` で可能**
`site.nicovideo.jp/danime/static/data/list.json`（**6,698シリーズ**、キーは `title, col_key, url` のみ）。
`col_key` が**読みベースの五十音「行」バケット**。実測分布（欠落 0 件）:

```
は:1255  あ:1088  か:1065  さ:1024  た:815  ま:458  ら:369  な:310  や:256  わ:58   （計6698 / 空0）
```

- 例: `{"title":"ああっ女神さまっ","col_key":"あ","url":".../series/109288"}`。表記が漢字でも読みの行で分類される想定。
- **結論: 五十音ボタン（あ/か/さ/た/な/は/ま/や/ら/わ の10行）での振り分けは list.json `col_key` で直接可能**。シリーズ単位・支店カタログ全件に付与。
- **制約**: 完全な読み（yomi）は無い → **行内の厳密な50音ソートは不可**（`title` 文字列順フォールバック。漢字先頭は音順にならない）。「行」までの粒度なら正確。

## B. ジャンルの所在（1話だけか／全話か）

snapshot は `contentId`・`channelId` とも **filter 不可**（個別話の直接引きは 400）。そこで**支店タグ集合（`q=dアニメストア&targets=tagsExact`＝総数 87,327）に `filters[genre]` を重ねて分布**を取得:

| genre | 件数 |
|-------|------|
| アニメ | **87,281** |
| ラジオ | 17 |
| エンターテイメント | 11 |
| 音楽・サウンド | 1 |
| その他 / ゲーム | 0 |

- **genre は（最古話だけでなく）ほぼ全話に入っている**: 非空 = 87,281+α ≒ **99.95%**（空/その他は数十件のみ）。
- ただし値は**ほぼ一律「アニメ」**＝**サブジャンルの判別には使えない**（1回目検証と一致）。
- 個別サンプル: `ああっ女神さまっ 第1話`(so36422583) も `genre=アニメ`。
- **シリーズのジャンル決定ルール**: genre は実質「アニメ」一色なので**ジャンル別ブラウズの軸には不適**。
  カテゴリ分けは **`tags`/`categoryTags` を主軸**にする（genre は「アニメか否か」程度の補助）。

## C. 概要（あらすじ）= 各話 description は話ごとか → **話ごとの個別あらすじ**

`ぼっち・ざ・ろっく！` の各話 description（実測・抜粋）:

```
#5 飛べない魚 : オリジナルソングも出来上がり、いよいよライブだと意気込む４人。星歌に出演させて…
#8 ぼっち・ざ・ろっく : ライブ当日。台風の影響で呼んでいたはずの家族や友達から続々とキャンセル…
#12 君に朝が降る : バンドを組み様々な人たちに出会い、ひとりでは今まで見えてこなかった景色が… <br…
```

- **各話 description はその話固有のあらすじ**（話ごとに異なる）。**HTML（`<br>` 等）混じり**＝サニタイズ要。
- nvapi series の **series 直下 description は空**のことが多い（`ああっ女神さまっ` は空）。真の「シリーズ概要」源は無い。
- **判定**: 「シリーズ概要＝第1話 description 流用」は**第1話のあらすじを表示することになる**（厳密なシリーズ要約ではない）。
  proxy としては許容可だが「第1話のあらすじ」と明示するのが正直。HTML 除去が前提。

## D. 各話の取得元（シリーズページ）→ **nvapi v2 series が最適**

`https://nvapi.nicovideo.jp/v2/series/<id>`（ヘッダ `X-Frontend-Id: 6`）→ **200**。`data.detail` ＋ `data.items[]`（各話）。

```
detail: id, owner, title, description, decoratedDescriptionHtml, thumbnailUrl, isListed, createdAt, updatedAt
detail.owner.channel.id = "ch2632720" / name "dアニメストア ニコニコ支店"   ← 支店判定に使える
items[].video: id(=contentId so…), title, count.view, registeredAt, thumbnail, shortDescription, duration …
例: series 109288「ああっ女神さまっ」 totalCount=26 / items=26（第1話→第26話の順で返る）
```

- **各話リスト・話順・contentId・再生数が一発で取れる**。**snapshot+list.json の series グルーピングより確実**
  （snapshot は series id を持たず、タイトル検索はノイズ＋低再生話の取りこぼしがあり不適）。
- **owner.channel.id == "ch2632720" でシリーズ単位の支店判定**も可能（list.json は元から支店カタログ）。
- 役割分担: **各話リスト＝nvapi series**、**ジャンル/タグ＝snapshot**、**五十音＝list.json `col_key`**。

## E. 出所マップ（詳細ページ「?」ツールチップ用）

| 表示フィールド | 取得元（1行） |
|----------------|---------------|
| タイトル | list.json `title` ／ nvapi series `detail.title` |
| シリーズ・サムネ | nvapi series `detail.thumbnailUrl` |
| 各話サムネ | snapshot `thumbnailUrl` ／ nvapi item `video.thumbnail` |
| ジャンル | snapshot `genre`（ほぼ「アニメ」一律＝補助のみ） |
| タグ | snapshot `tags` / `categoryTags` |
| シリーズ概要 | **第1話の snapshot `description`**（=第1話あらすじ・HTML除去。真のシリーズ要約源は無し） |
| 各話あらすじ | snapshot `description`（話ごと・HTML混じり） |
| 再生数 | snapshot `viewCounter`（累計） ／ nvapi `count.view` |
| 各話リスト（#/話順/contentId） | **nvapi v2 series `items[]`**（主源） |
| 公式シリーズリンク | nvapi series `id` → `nicovideo.jp/series/<id>` ／ list.json `url` |
| 各話リンク | `nicovideo.jp/watch/<contentId>` |
| 勢いスコア | **計算**（`viewCounter` ÷ 投稿経過日数 等・蓄積なし近似） |
| 読み（五十音バケット） | list.json `col_key`（行レベル。完全 yomi は無し） |
| 支店判定 | snapshot `channelId==2632720` ／ nvapi series `owner.channel.id=="ch2632720"` |

## 結論（要点）

- **五十音（A）**: ✅ **可能**。list.json `col_key` で10行バケットに直接振り分け（読みベース・全件付与・欠落0）。
  ただし完全 yomi が無いため**行内の厳密50音ソートは不可**（title順フォールバック）。
- **ジャンル（B）**: 全話に入るが**ほぼ「アニメ」一色**＝サブジャンル軸に使えない → **tags/categoryTags 主軸**。
- **概要（C）**: 各話 description は**話ごとの個別あらすじ**（HTML混じり）。シリーズ概要の真源は無く、**第1話あらすじを流用**するのが現実解（その旨明示）。
- **各話取得元（D）**: **nvapi v2 series が最適**（話順・contentId・支店判定込み）。snapshot グルーピングより確実。
