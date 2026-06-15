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

---

# 検証（4回目）: データ可用性マトリクス（全表示項目監査）

> 実施日 2026-06-15。UA 付き・低頻度・非営利。3画面（トップ/一覧/詳細）で出したい全項目の「取れる vs 出せる」を実測。
> カバレッジは**支店サンプル 100件 × 2軸**（`-viewCounter`＝人気順／`-startTime`＝新着順、各 channelId==2632720 該当 100/100）。

## カバレッジ実測（サンプル断片）

```
[人気順100] 全フィールド 非空/>0 = 100%
[新着順100] title/description/thumbnailUrl/tags/categoryTags/genre/viewCounter/lengthSeconds/startTime = 100%
            commentCounter>0 = 46%   likeCounter>0 = 51%   mylistCounter>0 = 40%   ← 投稿直後は希薄
```

→ **新着話は viewCounter 以外のエンゲージ指標（コメント/いいね/マイリスト）が 4〜5 割しか値を持たない**（投稿直後で0）。
人気作・既出話では 100%。likeは機能導入(2020)以降。

## マトリクス（行＝表示項目）

| 表示項目 | 取得元 | 取得可否 | カバレッジ（実測） | 信頼度・注意 | 算出方法 |
|----------|--------|:---:|------------------|-------------|---------|
| タイトル | list.json `title` / nvapi `detail.title` / snapshot `title` | ○ | 100% | 表記のみ（読み無し） | — |
| **読み（五十音）** | list.json `col_key` | △ | 行バケット 100%（6,698件・欠落0） | **行（あ〜わ10）粒度のみ正確。完全 yomi 無し→行内厳密ソート不可** | — |
| サムネ | snapshot `thumbnailUrl`（各話）/ nvapi `detail.thumbnailUrl`（シリーズ） | ○ | 100% | — | — |
| ジャンル | snapshot `genre` | △ | 非空 99.95%（87,281/87,327）だが**「アニメ」一色** | サブジャンル判別不可 → **tags 主軸** | — |
| タグ | snapshot `tags` | ○ | 100% | スペース区切り・表記揺れ有り | — |
| categoryTags | snapshot `categoryTags` | ○ | 100% | tags の補助 | — |
| 概要（あらすじ） | 各話 snapshot `description`（シリーズは**第1話を流用**） | △ | 各話 100% ／ シリーズ概要の真源**無し** | **HTML 混じり（要除去）**。流用＝「第1話あらすじ」と明示 | — |
| 各話リスト・話数順 | **nvapi v2 series `items[]`** | ○ | シリーズ単位で全話・順序付き | snapshot+list.json 集約より確実 | — |
| 各話再生数 | snapshot `viewCounter` / nvapi `count.view` | ○ | 100%（>0） | **累計のみ**（期間内なし） | — |
| シリーズ合算/代表再生数 | 計算（各話 `viewCounter` 合算 or 代表話） | ○(計算) | — | 合算は各話の網羅取得が前提（nvapi series 推奨） | Σ各話 viewCounter |
| 投稿日 | snapshot `startTime` | ○ | 100% | ISO8601＋TZ。**ニコ投稿日＝放送日と異なる場合あり** | — |
| コメント数 | snapshot `commentCounter` | ○取得 / △有用 | 人気100% / **新着46%** | 新着話は 0 が多い | — |
| いいね | snapshot `likeCounter` | ○取得 / △有用 | 人気100% / **新着51%** | like は2020〜・新着話 0 多い | — |
| マイリスト | snapshot `mylistCounter` | ○取得 / △有用 | 人気100% / **新着40%** | 新着話 0 多い | — |
| 尺 | snapshot `lengthSeconds` | ○ | 100%（>0） | 秒 | — |
| 公式シリーズURL | list.json `url` / nvapi series `id` | ○ | 100% | `nicovideo.jp/series/<id>` | — |
| 公式watchURL | snapshot `contentId` | ○ | 100% | `nicovideo.jp/watch/<contentId>`（`so…`） | — |
| 勢いスコア | 計算 | ○(計算) | — | 蓄積なし近似。**新着は comment/like/mylist 疎→view 主体に** | viewCounter ÷ 投稿経過日数 等（formula は L3） |
| クール判定 | snapshot `startTime`（現行季）/ programlist・period（過去季） | △ | 現行季 ◎ / **過去季 ✗** | **back-catalog は startTime＝バルク投稿日で放送季と無関係** | startTime→年・季（現行のみ） |
| 新着シリーズ判定 | 計算（series 内 `startTime` 最小） | ○(計算) | — | nvapi series で各話網羅が前提 | min(各話 startTime) |
| 最新話判定 | 計算（`startTime` 最大） | ○(計算) | — | — | max(各話 startTime) |

## クール判定の根拠（実データ）

- `ぼっち・ざ・ろっく！` 各話 `startTime` = 2022-11〜12 → **2022秋**（放送季と一致＝現行季の同時配信は startTime で判定可）。
- `ああっ女神さまっ` 全26話 `startTime` = **2020-03-13 で一律**（バルク投稿）→ 原作放送(2005〜)と無関係。
  **→ 過去作（back-catalog）は startTime からクールを判定できない。** 過去季は `anime.nicovideo.jp/period/<年>-<季>-danime.html` ／ programlist 補助が必要、無ければ「クール不明」。

## 落とし所（画面に載せる項目の正当化）

| 項目 | 判断 |
|------|------|
| 読み（五十音） | **採用＝行バケット（col_key）**。「あ〜わ」ボタンのみ。**行内の厳密50音ソートは諦め**（title順）。 |
| ジャンル別ブラウズ | **genre を軸に使わない**。タグ/categoryTags ベースに置換。 |
| シリーズ概要 | **第1話 description を HTML 除去して表示**＋「第1話のあらすじ」表記。別途のシリーズ要約は出さない。 |
| コメント/いいね/マイリスト | **新着では出さない or 0 を隠す**。勢いスコアの主因にしない（view 主体）。詳細・人気作では補助表示可。 |
| クール（過去季） | startTime で出せるのは現行季のみ。過去季は period/programlist で補完、不明は「クール不明」で正直に。 |
| 各話リスト | **nvapi v2 series を主源**に（snapshot 集約は代替）。 |

## 5点の結論（実データ）

1. **五十音**: ✅ list.json `col_key` で**行バケット振り分け可能**（全6,698件・欠落0）。読み(yomi)は無く**行内厳密ソートは不可**（公式の細かい50音 yomi 経路は確認できず＝行粒度で割り切る）。
2. **ジャンル**: 全話に在るが**99.95%「アニメ」**＝サブジャンル不可。**決定ルール: genre は「アニメ判定」程度に留め、分類は tags 主軸**。
3. **概要**: description は**各話固有のあらすじ**（HTML混じり）。シリーズ概要の真源は無く、**「第1話あらすじ流用（明示）」が妥当**。
4. **各話取得元**: **nvapi v2 `series/<id>` が最も信頼できる**（全話・話順・contentId・owner.channel で支店判定）。snapshot+list.json 集約より優位。
5. **クール判定**: **現行季のみ startTime で機械判定可**。**過去作はバルク投稿日のため不可** → period/programlist 補助 or 「不明」。

---

# 検証（5回目）: 読み(yomi)・サブジャンルタグ・クール源

> 実施日 2026-06-15。UA 付き・低頻度・非営利。3つの仮説（読み／サブジャンル／クール源）を実データで確認。

## A. 読み(yomi)＝本物の五十音は取れるか → ✗ 取れない

- `list.json` 全 **6,698 件**のキー和集合 = **`col_key, title, url` のみ**。読み系（yomi/kana/ruby/furigana/phonetic）は**1件も無い**。
- `col_key` は**読みベースの行**で、**接頭辞を除いた核タイトルの読み**で分類されている（実例）:
  ```
  col_key=あ | 劇場版アイカツ！           （「劇場版」を除き アイカツ→あ）
  col_key=あ | WEBアニメ アイカツオンパレード！（「WEBアニメ」を除き あ）
  ```
  → **行（あ〜わ）は正確**だが、**個々の完全な読み（あ/い/う…の細かい順）は持たない**。
- dアニメ トップが参照する他の静的 JSON（`archiveExclusive.json` / `exclusiveAndFastest.json` / `theme1-6.json`）も
  `title / href / src / alt / icon / endDate` のみで**読み無し**。`programlist.json` にも読み無し。
- **結論 A: ✗ per-title の読みは公開データに存在しない。** よって「五十音順」は**行内の厳密 50 音順へ格上げできない**
  （現状の「行バケット＋行内タイトル文字列順フォールバック」を維持）。col_key が接頭辞除去済みの読み行である点のみ正確。

## B. サブジャンルは第1話の tags に入るか → ○ `_dアニメ*` 接尾辞タグに在る

`genre` / `categoryTags` は「アニメ」一色（再確認）。一方 **第1話 `tags` に curated カテゴリタグ**（接尾辞 `_dアニメ` / `_dアニメストア`）が入る:

```
ぼっち#1   : 日常/ほのぼの_dアニメ  ドラマ/青春_dアニメ  きらら_dアニメストア  CloverWorks_dアニメ
宝石の国#1 : sf/ファンタジー_dアニメ  アクション/バトル_dアニメ  鬱アニメ_dアニメ  アフタヌーン_dアニメ  宝石の国_dアニメストア
ゆるキャン#1: 日常/ほのぼの_dアニメ  アウトドア/キャンプ/釣り_dアニメ  飯テロ_dアニメ  きらら_dアニメストア
```

- ジャンル/テーマ系は `_dアニメ`、作品名/レーベル系は `_dアニメストア` に付く傾向。**日常/ほのぼの・SF/ファンタジー・アクション/バトル・ドラマ/青春**等、サブジャンル軸に使える。
- **第1話のみか**: ep1 に主要カテゴリが揃う。ep2 以降にも追加が出る（ゆるキャン ep2 = `部活/サークル/同好会_dアニメ`）＝分布する。
  → **シリーズ代表は第1話 tags 採用で実用十分**（必要なら全話 union）。
- **表記ゆれ**: ①接尾辞 2 種 `_dアニメ` / `_dアニメストア` ②大小（`sf` 小文字 vs 一般 `SF`） ③スラッシュ結合の複合ラベル（`日常/ほのぼの`, `sf/ファンタジー`, `アウトドア/キャンプ/釣り`）。
- **正規化方針案**: 接尾辞 `_dアニメ(ストア)?` 除去 → `/` 分割 → 大小・全半角を正規化（sf→SF 等） → エイリアス表で同義吸収。
  レーベル/スタジオ（きらら・CloverWorks・アフタヌーン）や作品固有タグはサブジャンルから除外 or 別カテゴリへ。
- **結論 B: ○ サブジャンルは第1話 tags の `_dアニメ*` タグから取得可能。** genre 欄でなく**この curated タグ群をタグ/ジャンル軸の主データに格上げ可能**（要正規化）。

## C. クールは programlist で取れるか → ○ 正解は period ページ

- `programlist.json` キー = `workweek / worktime / title / series / imgpagh / fast`。**season/cour フィールド無し**。
  `programlist.html`（4,971 byte）も「2026年春」表記＝**今季のみ**の番組表。→ programlist は**現行季の番組表**用途。
- **period ページが正解**: `anime.nicovideo.jp/period/<年>-<季>-danime.html`
  ```
  2026-spring-danime : HTTP 200 / detail リンク 325 / <title>「2026春アニメ dアニメストア(ニコニコ支店)配信作品一覧…」
  2022-autumn-danime : HTTP 200 / detail リンク 298 / <title>「2022秋アニメ dアニメストア(ニコニコ支店)配信作品一覧…」
  ```
  **年-季が明示・支店スコープ明示・過去季も取得可**。
- 形式は HTML（サーバーレンダ）。作品リンクは `/detail/<slug>`（`/series/<id>` ではない）→ **series id への対応付けはタイトル突き合わせが必要**（△）。
- **結論 C: ○ クール帰属の取得は可（過去季・支店明示含む）／△ series id 紐付けはタイトル一致で吸収。**
  クール源は **period HTML を推奨**（startTime 推定より正確）。**変更検知アサート必須**（`<title>` に「<年><季>アニメ dアニメストア(ニコニコ支店)」を含む・`/detail/` 件数が下限以上）。

## 5回目 総括（格上げ可否）

| 項目 | 結論 |
|------|------|
| **A 読み(yomi) → 厳密五十音順** | **✗ 不可**（公開データに読み無し）。col_key の行＋行内 title 順フォールバックを維持 |
| **B サブジャンル（第1話 `_dアニメ*` タグ）** | **○ 取得可・格上げ可**（要正規化: 接尾辞除去／スラッシュ分割／大小・エイリアス吸収） |
| **C クール（period HTML）** | **○ 取得可**（過去季含む・支店明示）／**△** series id 紐付けはタイトル一致。**変更検知必須** |
