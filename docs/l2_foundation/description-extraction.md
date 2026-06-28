# description-extraction.md — 自動タグ抽出機能 仕様（新設計・1カテゴリ統合 + recurrence）

> Tri-SSD L2 基盤ドキュメント。**本書は「動画説明文からの自動タグ抽出機能」の仕様書（正本）**。
> 各シリーズの動画説明文から **演者・スタッフ・制作会社・原作者などの関係者名**を抽出し、
> **1 カテゴリの発見タグ列**として詳細画面に表示・人物/会社クリックで横断フィルタできるようにする。
> 機能の振る舞い（ユーザー可視仕様）＋内部の抽出・正規化・recurrence 判定・誤検知防止・検証基準を、
> 実コードと 1:1（盛らず実装どおり。関数名・正規表現・しきい値はコードで確認済み。`file:line` は
> [付録](#付録-実装インデックス)に集約）で記す。
> フィールド定義の正本は [`data-inventory.md`](data-inventory.md)、源→Store→projection の流れは
> [`dataflow.md`](dataflow.md)、画面仕様は [`screens.md`](screens.md)。

---

## 目次

1. [機能概要](#1-機能概要)
2. [評価軸（なぜこの設計か）](#2-評価軸なぜこの設計か)
3. [入力 — 何をパースするか](#3-入力--何をパースするか)
4. [元データの実態（事実）](#4-元データの実態事実)
5. [抽出パイプライン](#5-抽出パイプライン)
6. [正規化（canonical key）](#6-正規化canonical-key)
7. [recurrence ゲート（発見価値の判定）](#7-recurrence-ゲート発見価値の判定)
8. [誤検知をどう防ぐか](#8-誤検知をどう防ぐか)
9. [データモデルと配線](#9-データモデルと配線)
10. [カバレッジ実測](#10-カバレッジ実測)
11. [検証基準](#11-検証基準)
12. [既知の制約](#12-既知の制約)
13. [付録: 実装インデックス](#付録-実装インデックス)

---

## 1. 機能概要

### 1.1 この機能は何か

**動画説明文からの自動タグ抽出機能**である。ニコニコ各シリーズの説明文（description）は、あらすじだけでなく
**キャスト・スタッフ・制作会社・著作権表記**を 1 本の文字列に詰め込んで配信される。この機能はその文字列を
機械的に解析して **関係者の名前（声優・監督・脚本・音楽・原作者・制作会社など）を抽出**し、
**演者/制作を区別しない 1 列の発見タグ**として作品詳細画面に表示する。各タグは正規化キーを持ち、
クリックすると**同じ人物/会社が関わる他作品の一覧へ横断フィルタ**できる。

公式に構造化されたクレジット API は存在せず、説明文という非定型テキストが唯一の情報源であるため、
**テキスト解析による自動抽出**という形をとる。

### 1.2 ユーザーから見た振る舞い

機能の外形仕様（実装は `web/src/features/detail/detail.ts` `buildCredits` / `web/src/features/list/filter.ts`）:

| 振る舞い                        | 仕様                                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **詳細画面に「演者/制作」1 行** | 声優・スタッフ人名・制作会社・原作者を **1 カテゴリに統合**したタグ列を表示。**名前のみ**（役名・役割ラベルは出さない）。                      |
| **クリックで横断フィルタ**      | 各タグはクリックで `?credit=<canonical key>` へ遷移。一覧は `work.credits`（key 配列）にその key を含む作品だけに絞る（完全一致）。            |
| **クリック可能 vs 淡色**        | **他作品に繋がるタグ（recurrence≥閾値）だけクリック可能**。1 作品でしか確認できなかったタグ（singleton）は**非クリックの淡色**で参考表示する。 |
| **重複除去**                    | 同一 canonical key は 1 つにまとめる（表記ゆれも吸収）。                                                                                       |
| **長い名前は省略**              | 20 文字超のチップは末尾省略＋全文ツールチップ。                                                                                                |
| **自動抽出の注記 (i)**          | 見出しに (i)。濃い＝横断可、淡い＝この作品のみ、自動抽出ゆえ誤り・抜けがある旨を明示（`CREDIT_NOTE`）。                                        |

### 1.3 旧設計との違い（なぜ作り直したか）

旧版は cast/staff/studios/copyright を **2 カテゴリに分類**して精度100%（precision）を北極星にしていた。
だが発見用途（同じ人で他作品を探す）では **cast/staff の区別は無意味**で、分類の脆さ（混在段落で声優が
staff に倒れる等）と、表記ゆれ・連結値・copyright 埋没で**「正しいが他作品に繋がらない死にタグ」**を量産していた。
本設計は北極星を **linkage recall（同一人物が 1 実体に集約され、他作品に繋がる率）** に置き換える:

- **1 カテゴリ統合**: バケツ（cast/staff）を捨て、全関係者を 1 列に。混在段落バグが消える。
- **canonical key 正規化**: `諏訪部 順一` と `諏訪部順一` を 1 実体に集約（§6）。
- **recurrence ゲート**: 「他作品に再登場するか」でクリック可否を決める（§7）。発見の価値関数そのもの。
- **soft provenance**: `source`(castLike/staffLike/studio/copyright/themeSong)・`role` は内部保持のみ
  （抽出可否の gate には使わない・将来の序列/facet 用）。

---

## 2. 評価軸（なぜこの設計か）

ユーザーの動機は「**同じ制作スタジオ・監督・脚本・声優などで他のアニメ等を探す**」。よって抽出物は
「**人物/会社の横断発見タグ**」として役立つかで評価する。役名・「誰が何役か」はどうでもよく、
**名前がクリックして他作品に飛べるか**が価値。この軸から 3 つの設計判断が出る:

1. **分類より正規化** — cast/staff のラベルは join に無関係。重要なのは表記ゆれを潰して同一実体に集約すること。
2. **precision より linkage recall** — 「忠実だが一致しない blob」より「やや雑でも飛べるタグ」。連結値は分割し、
   copyright に埋もれた制作実体は救出する。precision は singleton を落とす recurrence が裏で担保する。
3. **recurrence が価値関数** — 「1 作品しかヒットしないタグ＝発見に無価値」は同義反復。これを直接実装する。

---

## 3. 入力 — 何をパースするか

抽出処理（`extractCredits`）に渡すのは、**各シリーズの「1話目（最古話）」の説明文 1 本だけ**である
（`store.mjs` `_buildSeriesJson` / `credit-index.mjs` `buildCreditIndex`）。

- シリーズ全話ではなく `chronoSort` 昇順の先頭＝最古話 1 件のみ。関係者はシリーズ内でほぼ一定なので 1話目で十分で、
  あらすじ（`descriptionFirst`）と同じ話を源にすることで源不整合を避け、全話パースのコストも省く。
- その 1 本は**源優先マージ（`chooseDescription`）の勝者**（①構造 `<br>` → ②源 `snapshot>nvapi>rss` → ③長さ）。
- **入力形式の非依存**: `extractCredits` は生 HTML（`<br>` 付き・fetch 直後）でも、stored の stripHtml 済み
  （`<br>`→`\n\n` 化済み・`data/series/*.json`）でも読める。構造判定は **`<br>` または `\n\n` の有無**
  （`isStructuredCredits`）。旧版は `<br>` の存在に依存していたため毎時 partial で credits を再計算できなかったが、
  本版は `\n\n` でも読めるので **毎時でも recurrence を全カタログから再計算できる**（carry-forward 不要）。

---

## 4. 元データの実態（事実）

### 4.1 構造化版とフラット版

| 書式           | 由来             | 中身                                                                      | 扱い                                 |
| -------------- | ---------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| **構造化版**   | snapshot / nvapi | あらすじ・キャスト・スタッフ・© を `<br><br>`（stored は `\n\n`）で区切る | 段落に割って抽出                     |
| **フラット版** | チャンネル RSS   | 全要素を区切り無しで連結（`<br>`/`\n\n` 無し）                            | **分解しない**（境界不明＝誤検知源） |

構造化版がほぼ全話（`\n` を持つ description が 99.5%）。フラットは新着回転窓のみ。

### 4.2 クレジット段落の形

構造化版を空行で段落に割ると、典型は次の要素が並ぶ。

```
（あらすじのプロ―ズ）

役名:声優A／役名:声優B …            ← cast ブロック
原作:○○／監督:△△／制作:□□ …       ← staff ブロック
©○○製作委員会                       ← copyright（制作実体が紛れることがある）
so… ←前話 ／ 次話→ so…               ← 話リンク
```

クレジット行は **全角 `／` でエントリを並べ、各エントリは `役:値`（コロン区切り）**。
この「`／` 並び＋コロン区切り」が分解の足がかり。半角 `:`・全角 `：` 両対応。

### 4.3 種別ごとの書き方の違い（が、種別専用パーサは持たない）

- **アニメ・映画**: `役名:声優` がきれい。よく取れる。
- **舞台（2.5次元）**: `出演:キャラ名 役：俳優名` 形式 → **`役：` の後ろの俳優名だけ救出**（§5.3）。
- **ライブ**: 曲順 setlist（`01:曲名`）は role が数値で落とし、アーティスト/作曲人名は拾う。
- **混在段落**: 映画等で `出演:声優…／原作:…／制作:…` が 1 段落に同居する（おしりたんてい型）。
  **per-segment 分類**（§5.2）で声優も制作も取りこぼさず拾う（旧版はブロックごと staff に倒れていた）。

---

## 5. 抽出パイプライン

`extractCredits(rawHtml)` は次の段で動く（すべて `scripts/etl/credits.mjs`）。返すのは
`{ structured, tags: [{display,key,source,role}], synopsis, copyrightRaw }`。recurrence は**まだ付けない**（§7）。

### 5.1 構造判定 → 段落分割

`stripHtml` で正規化（`<br>`/`</p>` 等→`\n`、実体参照デコード、連続改行畳み込み）→ `\n{2,}` で段落配列に割る。
`isStructuredCredits` が false（フラット）なら**一切分解せず** synopsis に温存。

### 5.2 段落分類（per-segment）

各段落を判定する。**ブロックを丸ごと cast/staff に振り分けるのではなく、`／` で割った各セグメントを
個別に分類する**のが要点（混在段落対策）。

1. **話リンク / info**（`←前話`/`次話→`/`動画投稿`等）→ 捨てる。
2. **copyright**（`©`/`製作委員会` 等を含む段落）→ 生文字列を `copyrightRaw` に温存しつつ、
   **`役:値` 構造があれば再パースして制作実体（原作者/監督/制作会社）を救出**（§5.4）。
3. **プロ―ズ段落**（`hasProsePeriod`＝文末の `。` を持つ）→ あらすじ/各話概要なので**抽出しない**
   （`第1話：…／第2話：…` の誤検知防止）。混在クレジットは文末を持たないので通る。
4. **その他のコロン段落** → `parseBlock` で `／` 分割 → 各セグメントを `役:値`（最初のコロン）に割り、
   `entryToTags` で role を見て振り分ける。割れないセグメントは**そのセグメントだけスキップ**（lossless）。

### 5.3 セグメント → タグ（`entryToTags`）

各 `役:値` セグメントの **value 側だけ**をタグ化する（role＝役名/役割は内部保持のみ）。role を見て:

- **studio role**（`制作`/`製作`/`アニメーション制作`等・`STUDIO_ROLE_RE`）→ value は制作会社。`source=studio`。
- **staff role**（`STAFF_KEYS` の語: 原作/監督/脚本/音楽/作画監督/演出…）→ value は人名。`source=staffLike`。
- **song role**（`主題歌`/`ED`/`劇中歌`等・`SONG_ROLE_RE`）→ **曲名（`「」『』`）を捨て、`作詞/作曲/編曲/歌：人名`
  を二次パースして救出**（`extractSongNames`）。`source=themeSong`。劇伴 `音楽=○○` は song 扱いせず人名で取る。
- **`役：` を含む value**（2.5次元舞台「キャラ 役：俳優」）→ **俳優名だけ**を救出。
- それ以外（混在ブロックの声優等）→ value は人名。`source=castLike`。

value は **所属括弧分離 → 連結分割 → 正規化**（§6）を経てタグ化される。

### 5.4 救出される代表ケース（旧版で落ちていたもの）

- **copyright 強奪の解消**: 響け！ユーフォニアムの `…／監督:石原立也／…／製作:『響け！』製作委員会` は
  旧版だと「製作委員会」を含むため段落丸ごと copyright に飲まれ staff=0 だった。新版は再パースで
  **石原立也・山田尚子・京都アニメーション**を救出（委員会名はノイズで落ちる）。
- **混在段落**: おしりたんてい映画の声優（三瓶由布子…）と監督・制作会社・主題歌作曲を per-segment で全部拾う。
- **連結値**: `原作:奈須きのこ・TYPE-MOON` → 2 タグ。`キャラクターデザイン:須藤友徳・田畑壽之・碇谷敦` → 3 タグ。
- **2.5次元舞台**: `出演:小野田坂道 役：糠信泰州、…` → 俳優名 `糠信泰州…`。

---

## 6. 正規化（canonical key）

各 value を**表示名（display）と canonical key**の 2 層にする。**フィルタは key 完全一致**、表示は display。
これが「同一人物を違う表記でも 1 クリックに集約」の核心。

| 処理                 | 関数                   | 例                                                                                                                                     |
| -------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 所属括弧の分離       | `splitAffiliation`     | `米山和仁（劇団ホチキス）` → 人物 `米山和仁` ＋ 会社 `劇団ホチキス`                                                                    |
| 出版社注記の除去     | `splitAffiliation`     | `岸本斉史（集英社「週刊少年ジャンプ」連載）` → `岸本斉史`（注記は捨てる）                                                              |
| 作品名/注記の除去    | `cleanDisplay`         | `渡辺航「弱虫ペダル」` → `渡辺航`、末尾 `他`/`※`/`著` も除去                                                                           |
| 連結値の分割         | `splitConnected`       | 中黒 `・`・読点 `、`・カンマ `,`・`/` で分割（括弧外のみ）                                                                             |
| 中黒の保護           | `splitConnected`       | Western 名 `リリー・フランキー`（全カタカナ）・頭文字名 `M・A・O`（全 1 字）は割らない                                                 |
| 連結保護（denylist） | `JOINED_NAME_DENYLIST` | `Wake Up, Girls!` 等の区切りを含む固有名は割らない                                                                                     |
| canonical key 生成   | `normalizePersonKey`   | NFKC（`ＭＡＰＰＡ`→`mappa`）＋内部空白除去（`諏訪部 順一`→`諏訪部順一`）＋法人格除去（`株式会社トレノバ`→`トレノバ`）＋ latin 小文字化 |

**順序の鉄則**: 分割（連結）は括弧外のセパレータのみで行い、所属分離は分割後の各片に適用する
（`今野康之（スワラ・プロ）` の括弧内 `・` で割らないため）。

---

## 7. recurrence ゲート（発見価値の判定）

抽出後、**全カタログ横断で canonical key の出現シリーズ数を数え**（`countRecurrence`）、
**クリック可能（発見タグ）＝ recurrence ≥ 閾値（`RECURRENCE_THRESHOLD`・既定 2・env `CREDIT_RECURRENCE_THRESHOLD`
で上書き可）**とする。索引は `credit-index.mjs` `buildCreditIndex(store)` が組む。

- **必ず「正規化してから数える」**: 生文字列で数えると `諏訪部 順一` と `諏訪部順一` が別 key で両方 singleton
  落ちする。canonical key で数えるから集約される。
- **削除でなくゲート**: singleton（=1）は**削除しない**。series JSON には残し UI で**非クリックの淡色**表示
  （catalog 成長で ≥2 になれば自動昇格）。これで long-tail の実在クリエイター（この支店に 1 作品しかない監督等）を
  殺さず、ノイズ（曲名・製作委員会名・年号 copyright・プロ―ズ片）だけ沈める。これらは構造上ほぼ一意なので自然に落ちる。
- **works.json は recurrent key のみ**保持（`worksCreditKeys`）。singleton はクリック対象でないので持たせない（肥大回避）。

recurrence ゲートは§8 の構造ガードがすり抜けた誤抽出（プロ―ズ断片＝一意）を独立に掃除する**安全網**でもある。

---

## 8. 誤検知をどう防ぐか

precision は「構造ガード（保守的に弾く）＋ recurrence（singleton を落とす）」の二重で守る。

| #   | 防ぐ誤検知                       | どう防ぐか                                                                                                                             |
| --- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | フラット RSS の連結文字列        | `<br>`/`\n\n` 構造が無ければ**一切分解せず** synopsis（`isStructuredCredits`）                                                         |
| ②   | 各話概要・あらすじ（`第1話：…`） | 段落が**プロ―ズ文末 `。` を持てば抽出しない**（`hasProsePeriod`。閉じ括弧前の 。は除外）＋ role が `第N話`/`#3`（`EPISODE_MARKER_RE`） |
| ③   | setlist 曲順（`01:曲名`）        | role が数値/記号のみなら不採用（`NUMERIC_ROLE_RE`）                                                                                    |
| ④   | 製作委員会名・年号 copyright     | `isCommittee`（製作委員会/パートナーズ/プロジェクト）・`©…20xx` は生値で弾く（`isPlausibleName`/`push`）                               |
| ⑤   | 放送局・役割語・汎用語           | 放送局（`BROADCASTER_RE`）・`他`/`ナレーション`/`作曲`/`歌` 等の役割語（`VALUE_STOPWORDS`）を弾く                                      |
| ⑥   | 壊れたセグメント・プロ―ズ value  | `役:値` に割れないセグメントはスキップ・value に文末/長すぎ（>40）なら不採用（`isPlausibleName`）                                      |
| ⑦   | 頭文字片・1 文字キー             | 正規化後 1 文字の key は不採用（`M・A・O` は割らないので 1 名で残る）                                                                  |

種別専用パーサは持たない。舞台/ライブのアニメ規則不適合は②③⑥で自然に吸収される。

---

## 9. データモデルと配線

```
1話目 description → extractCredits（§5）→ tags[{display,key,source,role}]
        ↓ buildCreditIndex（全カタログ・§7）
   { perSeries: sid→tags, recurrence: key→count }
        ├→ series JSON  credits: CreditTag[]  （seriesCredits・name/key/recurrent/count/source/role）
        └→ works.json   credits: string[]     （worksCreditKeys・recurrent な key のみ）
                                   ↓ web
   詳細画面 buildCredits（recurrent=クリック可 / singleton=淡色）→ クリック `?credit=<key>`
   一覧 filter（state.credit を work.credits[key] に完全一致）
```

- **series JSON** `credits`: `{name, key, recurrent, count, source, role}` の配列。recurrent 優先 → count 降順で並ぶ。
- **works.json** `credits`: recurrent な canonical key の配列（`?credit=` 照合用）。
- **web 型**: `CreditTag`（`web/src/data/types.ts`）。詳細は `SeriesDetail.credits: CreditTag[]`、
  一覧フィルタは `Work.credits: string[]`（key）。URL は `?credit=<key>`（`router.ts`）。
- **後方互換**: 旧 JSON（`credits: string[]`）は web 側 `normalizeCreditTags` が recurrent 扱いの `CreditTag` に正規化。

---

## 10. カバレッジ実測

**測定方法**: ローカル全 6,601 シリーズ（epCount>0）の 1話目 stored description（本番と同一ソース）に
`extractCredits` を適用し、全カタログで recurrence を数え、**「≥1 個のクリック可能タグ（recurrence≥2）が
取れるシリーズ率」**を測った（`scratch/measure-coverage.mjs` / `scratch/genre-coverage.mjs`、2026-06-29 実測）。

| 指標                                | 値                 |
| ----------------------------------- | ------------------ |
| 全シリーズ（epCount>0）             | 6,601              |
| **≥1 クリック可能タグ（要件≥70%）** | **6,436（97.5%）** |
| distinct canonical keys             | 30,048             |
| recurrent keys（≥2）                | 14,311             |
| クリック可能タグ数 中央値           | 18                 |

**種別別**（title/tags ヒューリスティック分類・率は方向性）:

| 種別   | n     | ≥1 クリック可能 | クリック可能タグ中央値 |
| ------ | ----- | --------------- | ---------------------- |
| アニメ | 4,579 | **97.7%**       | 18                     |
| 映画   | 979   | **97.5%**       | 20                     |
| 舞台   | 439   | **98.6%**       | 13                     |
| ライブ | 604   | **95.2%**       | 13                     |

要件「クリック可能タグ≥1 が 7 割以上」を全種別で大きく満たす。取りこぼし（~2.5%）は主に
**出演がグループ名のみのライブ**（`出演:JAM Project` 等＝singleton）など。singleton 表示は別途残る。

---

## 11. 検証基準

### 11.1 自動テスト

- **`tests/etl/credits.test.mjs`**: エンジンの単体テスト（統合・正規化・連結分割・`M・A・O` 保護・所属分離・
  出版社注記除去・混在段落・copyright 救出・主題歌二次パース・2.5次元 `役：`・声の出演・ノイズ除外・
  プロ―ズ非抽出・フラット非分解・dedup・`countRecurrence`）。
- **`tests/web/detail.test.ts`**: 1 行統合表示・recurrent はクリック可（`?credit=<key>`）・singleton は非クリック span・重複除去。
- `pnpm test`（562）/ `pnpm typecheck` / `pnpm lint` / `pnpm build` 全通過。

### 11.2 ノイズ監査（recurrent キーの目視）

全カタログの recurrent(≥2) キー 14,311 を「括弧残り・記号・プロ―ズ片・1 文字・役割語」で機械監査し、
疑い 7 件まで圧縮（`scratch/noise-audit.mjs`）。残りは実在の長い社名（`Planet Kids Entertainment` 等）と
stylized name（`いわみみか。`）など実害なし。

### 11.3 人手スポットチェック

代表＋ランダム 15 件（アニメ/映画/舞台/ライブ混在）を `scratch/credit-dump.md` にダンプし、
入力説明文・クリック可能タグ（recurrence 付き）・singleton 表示分を目視。響け（京アニ/石原立也救出）・
おしりたんてい（混在段落の声優+制作+主題歌作曲）・UBW（奈須きのこ/TYPE-MOON 分割・諏訪部順一 集約）で
発見用途に適した抽出を確認。

> **検証の射程（正直な限界）**: 構造的不変条件と recurrence は「他作品に繋がるか」を客観で担保するが、
> **「名前らしく見えるが事実は別人/誤記」「役名と俳優の取り違え」までは突合していない**。
> recurrence は「事実の正しさ」ではなく「再登場性」の代理指標である。

---

## 12. 既知の制約

- **出演がグループ名のみ**（ライブ）: `出演:JAM Project` のような単独グループ名は singleton になりがちで
  クリック可能タグにならないことがある（メンバー個別が書かれていれば拾う）。
- **区切り無しの連名**: `阿部智佳子（タバック）今井修治` のように区切りの無い 2 名は分割不能で singleton。
- **役割ラベル（role）/ source**: 内部保持のみ・UI 非表示（曖昧な役名の露出回避・将来 facet 用 soft metadata）。
- **横断 facet（声優別/制作別グローバル索引）**: 未実装。ただし recurrence 集計＝`key→作品集合` が事実上その素なので、
  将来の facet 化は本索引にそのまま乗る。
- **事実の正しさ**: §11 の射程どおり、名前単位の事実誤り・取り違えは検証対象外。

---

## 付録: 実装インデックス

### 抽出エンジン（`scripts/etl/credits.mjs`）

| 関数 / 定数           | file:line                        | 役割                                                 |
| --------------------- | -------------------------------- | ---------------------------------------------------- |
| `extractCredits`      | `scripts/etl/credits.mjs:357`    | 抽出本体（段落分割→分類→タグ化）                     |
| `countRecurrence`     | `scripts/etl/credits.mjs:423`    | key→出現シリーズ数の集計                             |
| `normalizePersonKey`  | `scripts/etl/credits.mjs:151`    | canonical key（NFKC/空白除去/法人格/小文字）         |
| `isStructuredCredits` | `scripts/etl/credits.mjs:128`    | 構造判定（`<br>` または `\n\n`）                     |
| `cleanDisplay`        | `scripts/etl/credits.mjs:169`    | 表示名整形（注記/作品名/末尾「他」除去）             |
| `splitAffiliation`    | `scripts/etl/credits.mjs:186`    | 所属括弧分離・出版社注記除去                         |
| `splitConnected`      | `scripts/etl/credits.mjs:216`    | 連結値分割（括弧外・中黒/読点・Western/頭文字保護）  |
| `entryToTags`         | `scripts/etl/credits.mjs:285`    | role でタグ化（studio/staff/song/役：/cast）         |
| `parseBlock`          | `scripts/etl/credits.mjs:335`    | 段落の `役:値` セグメント抽出（per-segment）         |
| `STAFF_KEYS` 他定数   | `scripts/etl/credits.mjs:19-126` | role 語・song/studio/委員会/放送局/stopword/denylist |

### グローバル索引・配線

| 関数 / 定数             | file:line                                | 役割                                             |
| ----------------------- | ---------------------------------------- | ------------------------------------------------ |
| `RECURRENCE_THRESHOLD`  | `scripts/store/credit-index.mjs:13`      | クリック可能の最小 recurrence（既定 2・env 可）  |
| `buildCreditIndex`      | `scripts/store/credit-index.mjs:22`      | store 全体の {perSeries, recurrence}             |
| `seriesCredits`         | `scripts/store/credit-index.mjs:43`      | series JSON 用 CreditTag[]（recurrent/count 付） |
| `worksCreditKeys`       | `scripts/store/credit-index.mjs:66`      | works.json 用 recurrent key 配列                 |
| `_buildSeriesJson`      | `scripts/store/store.mjs:416`            | series JSON へ credits（CreditTag[]）            |
| `exportWorks` / Partial | `scripts/store/project.mjs:115` / `:404` | works.json へ credits（key 配列）                |

### 画面（ユーザー可視）

| 関数 / 定数               | file:line                              | 役割                                         |
| ------------------------- | -------------------------------------- | -------------------------------------------- |
| `CreditTag`               | `web/src/data/types.ts`                | クレジットタグ型（name/key/recurrent/…）     |
| `buildCredits`            | `web/src/features/detail/detail.ts:50` | 1 行統合タグ列の描画（recurrent=クリック可） |
| `normalizeCreditTags`     | `web/src/features/detail/detail.ts:30` | 旧 string[] との後方互換                     |
| 人物フィルタ              | `web/src/features/list/filter.ts:126`  | `?credit=<key>` で `work.credits` を完全一致 |
| `?credit=` ルーティング   | `web/src/features/router.ts`           | URL ↔ state.credit                           |
| `.credit-chip--singleton` | `web/src/style.css`                    | singleton の非クリック淡色チップ             |
