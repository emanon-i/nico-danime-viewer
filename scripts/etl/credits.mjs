// scripts/etl/credits.mjs
// 発見タグ抽出（再設計版・1カテゴリ統合 + 正規化 + recurrence 前提）。
//
// 旧 description.mjs は「cast/staff の 2 カテゴリに分類して精度100」を狙ったが、本モジュールは
// 発見用途（同じ人物/会社で他作品を探す）に合わせて方針を変える:
//   - cast/staff のバケツ分けをやめ、**全関係者（声優+スタッフ+制作会社+copyright由来）を 1 本の
//     名前タグ列**にまとめる（混在段落バグ＝主題歌混入で声優が staff 化、を per-segment 分類で解消）。
//   - 各タグに canonical key（正規化）を付け、表記ゆれ（諏訪部 順一 ↔ 諏訪部順一）を 1 実体に集約。
//   - **noise（曲名・◯◯製作委員会・©/年号・役名・汎用語）は抽出ルールで落とす**。出すタグは
//     全て「クリックする価値のある実在の人物/会社名」にする（recurrence でクリック可否を変えない）。
//   - source（castLike/staffLike/studio/copyright/themeSong）・role は **soft metadata** として
//     内部保持（抽出可否の gate には使わない・将来の序列/facet 用）。
//   - countRecurrence は将来の序列/facet 用ユーティリティ（本パイプラインの表示/クリックには不使用）。
//
// 入力は「各シリーズ1話目」の説明文 1 本（生 HTML でも stripHtml 済みの \n\n 形でも可）。
// 構造判定は <br>（生）または \n\n（stripHtml 済み）の有無。フラット（区切り無し）は分解しない。

import { stripHtml } from './series.mjs'

// ── スタッフ役割マーカー（この語を role に含む = スタッフ人名/制作会社の行）─────────────
const STAFF_KEYS = [
  '原作',
  '原案',
  '総監督',
  '監督',
  'シリーズ構成',
  '脚本',
  '構成',
  'キャラクターデザイン',
  'キャラクター原案',
  '総作画監督',
  '作画監督',
  '作画',
  '原画',
  'アニメーションキャラクター',
  'アニメーション制作',
  'アニメーション',
  '制作',
  '製作',
  '音楽',
  '音響監督',
  '音響効果',
  '音響',
  '美術監督',
  '美術設定',
  '美術',
  '色彩設計',
  '撮影監督',
  '撮影',
  '編集',
  '企画',
  '監修',
  'デザインワークス',
  '演出',
  '絵コンテ',
  'プロデューサー',
  '作詞',
  '作曲',
  '編曲',
  '振付',
  '振り付け',
]

// 役割語（人名/社名ではなく「ラベル」）。value 側に漏れた役割語をタグにしないための語幹集合。
// STAFF_KEYS と重複するが、こちらは「単体/連結で role ラベルだけ」を判定する正規表現用（長い語を先に）。
const ROLE_BASE =
  'キャラクターデザイン|キャラクター原案|メカニックデザイン|メインアニメーター|アニメーション制作|アニメーション|総作画監督|作画監督|音響監督|音響効果|美術監督|美術設定|撮影監督|色彩設計|振り付け|シリーズ構成|シリーズ演出|キャラクター|プロデューサー|ディレクター|スーパーバイザー|デザインワークス|メカニック|プロップ|シナリオ|総監督|助監督|絵コンテ|総作画|シリーズ|コンテ|作画|原画|監督|構成|脚本|演出|原作|原案|脚色|漫画|設定|制作|製作|企画|監修|編集|撮影|音響|音楽|美術|作詞|作曲|編曲|振付|演奏|歌唱'
// 文字列全体が役割ラベル（語幹の連結・末尾「など/等/ほか」許容）か。タグの最終防波堤＆末尾注記除去に使う。
const ROLE_LABEL_RE = new RegExp(`^(?:${ROLE_BASE})+(?:など|等|ほか)?$`)
// 名前末尾にくっついた役割注記（空白区切り）を落とす。`奥田 陽介 作画監督`→`奥田 陽介`、`竹内良輔 漫画`→`竹内良輔`。
const TRAILING_ROLE_RE = new RegExp(`[\\s\\u3000]+(?:${ROLE_BASE})+(?:など|等)?$`)
function stripTrailingRole(s) {
  let prev
  let out = s
  // 連続適用（`X 漫画 構成` のような多重末尾も剥がす）。
  do {
    prev = out
    out = out.replace(TRAILING_ROLE_RE, '').trim()
  } while (out !== prev && out)
  return out
}
function isRoleLabel(key) {
  return ROLE_LABEL_RE.test(key)
}
// 先頭の役割語（制作/製作/企画/監修/協力 とその連結）。`制作協力ENGI`→`ENGI`・`製作竜の子…`→`竜の子…`（#1b）。
// 完全な役割語のみ照合＝姓（協・監 等の単字）は剥がさない。
const LEADING_ROLE_RE =
  /^(?:アニメーション制作協力|アニメーション制作|制作協力|製作協力|企画製作|企画制作|制作|製作|監修|協力)+/u
// 末尾の部署ラベル（実制作会社名ではない）。`TOブックス企画製作部`→`TOブックス`（#1b）。
// 注: `編集室`/`編集部` は実在の編集スタジオ名（森田編集室・瀬山編集室）を壊すため含めない。
const DEPT_SUFFIX_RE = /(?:企画製作部|企画制作部|製作部|制作部)$/u
// 委員会代理の generic プロジェクト（作品名＋プロジェクト/Project の製作委員会相当）。末尾一致のみ＝
// `プロジェクトラブライブ！`（先頭）や `project No.9`（末尾が No.9）は守る。copyright/studio 経路だけで落とす
// （JAM Project 等の themeSong/cast は対象外）（#1c）。
const GENERIC_PROJECT_RE = /(?:プロジェクト|project)$/iu
// 括弧内が「代表作の役職注記」（…作画監督 / …アニメパート演出 等）かの判定用。**明確に制作役割の語**だけ。
// 企画/制作/製作/音楽/設定/美術/撮影/編集 は社名にも現れる（◯◯企画・◯◯制作）ため除外＝実在社名を守る。
const ANNOTATION_ROLE_RE =
  /(総作画監督|作画監督|キャラクターデザイン|キャラクター原案|シリーズ構成|絵コンテ|演出|構成|脚本|作画|原画|監督|脚色|作詞|作曲|編曲|振付)/

// 制作会社（studio）として扱う role（value = 会社名）。
const STUDIO_ROLE_RE = /(アニメーション制作|制作|製作|制作会社|アニメーション制作協力)/
// 主題歌系 role（value から曲名を捨て、作詞/作曲/編曲/歌 の人名だけ救出する）。
const SONG_ROLE_RE =
  /(主題歌|オープニングテーマ|エンディングテーマ|テーマ曲|テーマソング|挿入歌|劇中歌|ＯＰ|ED|OP|ＥＤ|エンディング|オープニング|主題曲|エンディング曲|オープニング曲)/
// 出演（声優/俳優）系 role。これで始まる「出演:A／B／C」は役名なしでも俳優名が並ぶ（舞台）。
const PERFORM_ROLE_RE = /(出演|声の出演|キャスト|cast|声優)/i
const COPYRIGHT_MARK_RE = /[©Ⓒ]|\(C\)|\(c\)|ⓒ/
const COMMITTEE_RE = /(委員会|パートナーズ|partners)/i // 製作/制作/選考/実行委員会 等を一括
const LINKS_RE = /(←\s*前話|次話\s*→|第一?話\s*→|第1話\s*→|前話\s*→|→\s*so\d)/
const INFO_RE =
  /(動画投稿|コミュ投稿|公式(?:サイト|HP|ツイ)|ご視聴|配信(?:期間|開始|スケジュール)|本編(?:は|を)|チャンネル(?:登録|会員))/

// value としてタグ化しない非実体（役割語・汎用語・記号）。
const VALUE_STOPWORDS = new Set([
  '他',
  'ほか',
  'ナレーション',
  'ナレーター',
  'ナレータ',
  '声の出演',
  '出演',
  'キャスト',
  'スタッフ',
  'その他',
  '原作',
  '監督',
  '不明',
  'ほか多数',
  '他多数',
  'and more',
  'more',
  'その他大勢',
  '名',
  '代表作',
  '原作担当',
  '作画担当',
  'プロジェクト',
  '番組スタッフ',
  '制作スタッフ',
  'スタッフ一同',
  '出演者',
  'ゲスト',
  'ゲスト出演',
  '特別出演',
  '友情出演',
  'op',
  'ed',
  'ＯＰ',
  'ＥＤ',
  'cv',
  // 役割語が value 側に漏れたもの（劇中歌「曲」作曲：… の取りこぼし対策）
  '作詞',
  '作曲',
  '編曲',
  '歌',
  'うた',
  '歌唱',
  '演奏',
  '音楽',
  '主題歌',
  '挿入歌',
  '劇中歌',
  'オープニング',
  'エンディング',
  '脚本',
  '演出',
  '振付',
  // 主題歌ラベル（value/song 経路に label だけ漏れたもの。曲名は元々落とす方針・人名は作詞作曲経路で取る）
  'オープニングテーマ',
  'エンディングテーマ',
  'テーマソング',
  'テーマ曲',
  'イメージソング',
  'キャラクターソング',
])

// 主題歌ラベル（value 内に埋め込まれて run-on になるもの）。エントリ区切りに置換して分離する。
// 例: 音楽:「Dolce Triade オープニングテーマ｢…｣OKINO」→ Dolce Triade / OKINO に割る。
const THEME_LABEL_RE =
  /(オープニングテーマ|エンディングテーマ|テーマソング|テーマ曲|イメージソング|キャラクターソング|挿入歌|劇中歌|主題歌)/g

// 出版注記（雑誌名/レーベル/連載表記）= 著者でも出版社でもない publication note。タグにしない。
//   - 月刊/週刊/季刊/別冊… 接頭の雑誌名（月刊Gファンタジー・週刊少年マガジン）
//   - ◯◯文庫（角川文庫・電撃文庫・富士見ファンタジア文庫）= レーベル名
//   - 連載/掲載/所載 を含む run-on 注記（一迅社月刊ZERO-SUM連載中 等）
// 注: `◯◯刊`/`◯◯連載` の末尾注記は cleanDisplay で剥がして実出版社（集英社・KADOKAWA・双葉社…）に
// 寄せてから、この RE で残った雑誌/レーベル/run-on だけを落とす（実在出版社は守る）。
const PUBLICATION_NOTE_RE = /(?:月刊|週刊|隔週刊|隔月刊|季刊|別冊|連載|掲載|所載)|文庫$/u
// 末尾の出版注記（◯◯刊・◯◯連載中・◯◯掲載・◯◯所載）。実出版社名を残して注記だけ剥がす。
const TRAILING_PUB_NOTE_RE = /[\s\u3000]*(?:連載中|連載|掲載中|掲載|所載)[\s\u3000]*$/u

// 著作権年号（1900-2099・`年`接尾・範囲表記 1990年－1994年 に対応）。先頭/末尾/埋め込みで実体から剥がす。
const YEAR_TOKEN = String.raw`(?:19|20)\d{2}\s*年?`
const YEAR_RANGE = `${YEAR_TOKEN}(?:\\s*[-–—~〜－‐]\\s*(?:(?:19|20)?\\d{1,4})?\\s*年?)?`
const LEADING_YEAR_RE = new RegExp(`^${YEAR_RANGE}[\\s\u3000]*`, 'u') // 2020 SANRIO→SANRIO / 1990年－1994年 ぴえろ→ぴえろ
const TRAILING_YEAR_RANGE_RE = new RegExp(
  `[\\s\u3000]*${YEAR_TOKEN}\\s*[-–—~〜－‐]\\s*\\d{0,4}\\s*年?\\s*$`,
  'u'
) // …1981- / Corporation1988－
const EMBEDDED_YEAR_RE = new RegExp(`[\\s\u3000]+${YEAR_RANGE}[\\s\u3000]*`, 'gu') // … 1993 … → 区切り

// 放送局・配給など「作品横断だが制作クリエイティブでない」高頻度ノイズ（発見タグから外す）。
const BROADCASTER_RE =
  /^(テレビ東京|フジテレビ(?:ジョン)?|日本テレビ(?:放送網)?|テレビ朝日|TBS(?:テレビ)?|テレビ大阪|読売テレビ|毎日放送|中部日本放送|ＴＢＳ|ＮＨＫ|NHK(?:エンタープライズ)?|BS\w*|ＢＳ\w*|ＡＴ-?Ｘ|AT-?X)$/i

// 連結値を割らない既知固有名（中黒/読点を含む 1 名）。誤分割防止のホワイトガード。
const JOINED_NAME_DENYLIST = new Set(
  [
    'Wake Up, Girls!',
    'Wake Up,Girls！',
    'Wake Up, Girls！',
    'May’n',
    'fripSide',
    'ClariS',
    'やなぎなぎ',
  ].map((s) => s.normalize('NFKC').toLowerCase())
)

/**
 * 構造化（分解可能）な description か。生 <br> または stripHtml 済みの \n\n（≥2 ブロック）を持つ。
 * フラット（RSS・区切り無し）は false。
 */
export function isStructuredCredits(rawHtml) {
  if (typeof rawHtml !== 'string' || !rawHtml) return false
  if (/<br\s*\/?>|&lt;\s*br/i.test(rawHtml)) return true
  return /\n\s*\n/.test(stripHtml(rawHtml))
}

// プロ―ズ（文章）か。判定は **「。の直後が日本語文字＝文の継続」** のときだけ。
//   - 多文あらすじ（文1。文2…）＝`。`＋かな/漢字 → プロ―ズ。
//   - 語尾が 。 の芸名/作品名（『バクマン。』『ななもり。』）＝`。`の後が 』 )／ など非日本語 → プロ―ズ扱いしない。
//   - `！`/`?` はタイトル・グループ名（Happy Around! / MyGO!!!!! / アイカツ！/ 響け！）に多用される
//     ためプロ―ズ信号に使わない＝クレジット段落を誤って丸ごと捨てない。
function hasProsePeriod(s) {
  return /。[一-龯々〆ぁ-んァ-ヶー]/.test(s)
}

// role が数値/記号のみ（setlist 番号「01」「M1」「Track2」やタイムテーブル）= クレジットでない。
const NUMERIC_ROLE_RE = /^[\dＭMＴT#＃[\]()（）.\s:：・-]+$/i
// 値のエントリ区切り（読点・カンマのみ）。
// 空白（全角 U+3000 / 半角）は姓名内（「兵頭」+全角空白+「秀明」/ 木村 了）にも使われるため **ここでは割らない**。
// 名前リスト（舞台/ライブの全角空白区切り A B C）の空白分割は splitPeople が
// 「単一スペース＝姓名・3名以上＝リスト」で判定する（全角/半角の不整合を解消）。
const ENTRY_SEP_RE = /[、，,]/
// 各話概要マーカー role（「第1話」「#3」「Track5」「ENCORE」等）。クレジットでない。
const EPISODE_MARKER_RE =
  /^(第?\s*\d+\s*話|#?\d+話?|episode\s*\d+|ep\.?\s*\d+|encore|track\s*\d+|m\d+)$/i

/**
 * 人物/会社名 1 個を canonical key へ正規化する。タグにしない場合は '' を返す。
 *   - NFKC（全半角・互換統一: ＭＡＰＰＡ→mappa、高木 洋→高木洋）
 *   - 内部空白除去（諏訪部 順一 ↔ 諏訪部順一）。中黒・は保持（Western 名 ジョン・カビラ）。
 *   - 末尾 他/ほか・前後記号・法人格（株式会社/有限会社/(株)）除去。
 *   - latin は小文字化（MAPPA↔mappa）。
 */
export function normalizePersonKey(name) {
  let s = (name ?? '').normalize('NFKC').trim()
  if (!s) return ''
  // 末尾の「他/ほか」「、他」など
  s = s.replace(/[\s、,]*(?:他|ほか)(?:多数)?$/u, '').trim()
  // 法人格
  s = s.replace(/(?:株式会社|有限会社|合同会社|（株）|\(株\)|（有）|\(有\))/g, '').trim()
  // 前後の記号・空白
  s = s
    .replace(/^[\s・,，、.。/／\-—–:：「」『』()（）]+/, '')
    .replace(/[\s・,，、.。/／\-—–:：「」『』()（）]+$/, '')
  // 内部空白（半角/全角・\s が U+3000 も含む）除去。中黒は残す。
  s = s.replace(/\s+/g, '')
  s = s.toLowerCase()
  return s
}

// 引用符タイトル（作品名/曲名）を深さ対応で除去する。ネスト（「名湯『異世界の湯』開拓記…」）にも対応。
// 括弧（…）/() は所属会社なので **触らない**（splitAffiliation に残す）。
const QUOTE_OPEN = '「『＜《｢“'
const QUOTE_CLOSE = '」』＞》｣”'
function stripQuotedTitles(s) {
  let out = ''
  let depth = 0
  let dq = false // 直線ダブルクオート " はトグル
  for (const ch of s) {
    if (ch === '"') {
      dq = !dq
      continue
    }
    if (dq) continue
    if (QUOTE_OPEN.includes(ch)) {
      if (depth === 0) out += ' ' // タイトル跡に空白を残す（奥田 陽介『…』作画監督→奥田 陽介 作画監督）
      depth++
      continue
    }
    if (QUOTE_CLOSE.includes(ch)) {
      if (depth > 0) depth--
      continue
    }
    if (depth === 0) out += ch
  }
  return out.replace(/\s{2,}/g, ' ').trim()
}

// 副題（名前『…』～サブタイトル～ の ～以降）を除去。`～`/`〜` は実在名（富永 み～な・メ～テレ・
// L'Arc～en～Ciel・キャイ～ン）に多用されるため、**`～` 以降に漢字を含み 4 文字以上**＝副題のときだけ落とす。
// 先頭（`～` の前）が 2 文字以上の名前のときのみ作用＝かな芸名（ち～む・そ～とめ）は守る。
function stripSubtitleTilde(s) {
  const i = s.search(/[～〜]/u)
  if (i <= 0) return s
  const head = s.slice(0, i).trim()
  const tail = s.slice(i + 1)
  if ([...head].length >= 2 && [...tail].length >= 4 && /[一-龯]/u.test(tail)) return head
  return s
}

// 表示用に value を軽く整える（注記/作品名/末尾「他」除去・前後空白）。canonical はこの結果から導く。
function cleanDisplay(name) {
  let s = (name ?? '').trim()
  s = s.replace(/^[©Ⓒⓒ®™\s]+/u, '') // 行頭の ©/®（©Frontwing → Frontwing）
  // 孤立した法人格接頭・英語クレジット boilerplate 接頭を剥がして実名を回収する
  //（LTD. TIGER PICTURE ENTERTAINMENT→TIGER…・Inc. developed by QualiArts→QualiArts）。
  s = s.replace(/^(?:co|ltd|inc|llc|corp|k\.?k)\.?[\s,]+/i, '')
  s = s.replace(
    /^(?:developed|published|presented|distributed|licensed|produced|created)\s+by\s+/i,
    ''
  )
  s = s.replace(/^[（(](?:CV|Cv|cv|ＣＶ)[）)]\s*/u, '') // 声優マーカー (CV) 接頭（(CV)宮野 真守 → 宮野 真守）
  // バランスした角括弧/隅付き括弧の注記（[mf文庫jシリーズ] 等のレーベル/代表作）を先に除去。
  s = s.replace(/【[^】]*】|［[^］]*］|\[[^\]]*\]/gu, ' ').trim()
  // 行頭に残った未対応の開き角括弧は外す（[Alexandros → Alexandros）。
  s = s.replace(/^[[［]/u, '')
  // 最初の括弧/引用符（角括弧含む）以降（作品名・掲載誌・レーベル注記）を落とす。所属会社は splitAffiliation で分離済み。
  s = s.replace(/[「『（(【＜<｢《[［].*$/u, '')
  // 対応開きが別片に行った閉じ括弧以降（「作品名」より / ｣連載 / ]NET / 松岡由貴)からそう… の断片）も落とす。
  // 丸括弧 ）/) も含める＝この時点で残る丸括弧は splitAffiliation が処理し損ねた孤立片＝注記/プロ―ズ。
  s = s.replace(/[」』｣》＞］\]）)].*$/u, '')
  s = s.replace(/\s*※.*$/u, '') // ※注記
  s = s.replace(/\s+著.*$/u, '') // 「○○ 著『…』」
  s = s.replace(/\s*[…‥]+$/u, '') // 末尾の…（and more… 等）
  s = s.replace(/[\s、,]*(?:他|ほか)(?:多数)?[。\s]*$/u, '') // 末尾「他」「ほか。」
  // 著作権年号（先頭/末尾・範囲表記含む）を剥がす。©2020 SANRIO→SANRIO / Benesse Corporation1988-→Benesse Corporation。
  s = s.replace(LEADING_YEAR_RE, '') // 先頭の年（2020 SANRIO→SANRIO・1990年－1994年 ぴえろ→ぴえろ）
  s = s.replace(TRAILING_YEAR_RANGE_RE, '') // 末尾の年範囲（…1981- / …1998-2025 / Corporation1988－）
  s = s.replace(/(\D)\s*(?:19|20)\d{2}\s*年?$/u, '$1') // 末尾の単年（アンサンブル 2014→アンサンブル・1869 等は非数字前置のみ）
  s = s.replace(/^[・,，、/／\s]+/, '').replace(/[・,，、/／\s」』）)】＞>｣》\]｝}]+$/, '')
  // 名前末尾にくっついた役割注記（`奥田 陽介 作画監督`／`竹内良輔 漫画`）を分離。
  s = stripTrailingRole(s.trim())
  // 先頭の役割語（制作協力ENGI→ENGI）・末尾の部署（TOブックス企画製作部→TOブックス）を剥がす（#1b）。
  s = s.replace(LEADING_ROLE_RE, '').trim()
  s = s.replace(DEPT_SUFFIX_RE, '').trim()
  // 出版注記の末尾（集英社刊 → 集英社・講談社 連載 → 講談社）を剥がして実出版社名に寄せる。
  s = s.replace(TRAILING_PUB_NOTE_RE, '').trim()
  s = s.replace(/刊$/u, '').trim() // 末尾「刊」（集英社刊・双葉社刊）。雑誌/レーベルは PUBLICATION_NOTE_RE で別途落とす。
  // 引用符無しで名前に続いた副題（茨木野～奈落で鍛えた…～）を除去。
  s = stripSubtitleTilde(s.trim())
  return s.trim()
}

// 出版社/掲載誌の注記（人物の所属会社ではない）。これが括弧内なら捨てて名前だけ残す。
const PUBLISHER_ANNOTATION_RE =
  /(連載|掲載|所載|刊|文庫|コミック|新聞|放送|より|月刊|週刊|集英社|講談社|小学館|角川|KADOKAWA|新潮社|白泉社|秋田書店|双葉社|一迅社|スクウェア|ジャンプ|マガジン|サンデー|チャンピオン|電撃|ガンガン|\d{4})/i

// 原作系 role（括弧内は所属会社でなく出版社/掲載誌の注記なので捨てる）。role ベースで判定する
// ことで、出版社の固有名リスト（PUBLISHER_ANNOTATION_RE の社名部）に依存せず構造的に注記を落とす。
const ORIGINAL_WORK_ROLE_RE = /(原作|原案|原著|^著$|漫画|キャラクター原案|企画原案|脚色|連載)/

// value 末尾の括弧を分離: 「米山和仁（劇団ホチキス）」→ {name:'米山和仁', org:'劇団ホチキス'}。
// dropParen=true（原作系 role）なら括弧内は出版社注記とみなし常に捨てる（岸本斉史（集英社…連載）→岸本斉史）。
// それ以外は所属会社として org に出すが、PUBLISHER_ANNOTATION_RE に当たる注記だけはフォールバックで捨てる。
// 名前直後の括弧が「ふりがな/読み」か。全ひらがな（中黒/長音/空白のみ可）かつ
// 「空白を含む（姓 名の読み）」または「長さ6以上」のとき読み仮名とみなす（高村 佳偉人(たかむら かいと)）。
// 短い全ひらがな（スタジオ「ぴえろ」等）は所属会社の可能性があるので残す＝誤って実名を消さない。
function isFuriganaReading(inner) {
  if (!/^[ぁ-んゝゞ・ー\s]+$/u.test(inner)) return false
  const compact = inner.replace(/\s+/g, '')
  return /\s/.test(inner) || [...compact].length >= 6
}

function splitAffiliation(value, dropParen = false) {
  const m = value.match(/^(.+?)[（(]([^（）()]{1,40})[）)]\s*$/)
  if (!m) return { name: value, org: null }
  const name = m[1].trim()
  const inner = m[2].trim()
  if (!name) return { name: value, org: null }
  // ふりがな（読み）は名前でも所属でもない → 捨てて漢字名だけ残す（読み仮名の二重採用を防ぐ）。
  if (isFuriganaReading(inner)) return { name, org: null }
  // 代表作の役職注記（「作品」アニメパート演出 等。引用符は除去済みで役割語が残る）も所属でない → 捨てる。
  if (ANNOTATION_ROLE_RE.test(inner)) return { name, org: null }
  if (dropParen || PUBLISHER_ANNOTATION_RE.test(inner)) return { name, org: null } // 注記は捨ててクリーン名
  return { name, org: inner } // 所属会社
}

// 括弧（（）/()）の外にあるセパレータ文字位置だけで分割する（括弧内の・/、は名前/所属の一部）。
function splitOutsideParens(value, sepRe) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of value) {
    if (ch === '（' || ch === '(') depth++
    else if (ch === '）' || ch === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && sepRe.test(ch)) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

// 日本語人名どうしの間の半角スペースだけで分割する（舞台 出演:関根優那 高橋りな 寒竹優衣…）。
// 「日本語文字＋半角スペース＋日本語文字」の境界のみ分割＝ラテン社名の内部スペース
//（Planet Kids Entertainment）は割らない。姓名内の「木村 了」も呼び出し側の ≥3 ゲートで保護。
const JP_CHAR = '一-龯々〆ヵヶぁ-んァ-ヶーゝゞ'
const JP_NAME_SPACE_RE = new RegExp(`(?<=[${JP_CHAR}]) +(?=[${JP_CHAR}])`)

// 純漢字（姓名内に空白を持たない完全な氏名片）か。`\p{sc=Han}` で 髙﨑廣 等の異体字も拾う。
const PURE_KANJI_RE = /^[\p{sc=Han}々〆ヶヵ]+$/u
// 半角スペース 2 分割が「2 人」か「1 人の姓 名」かの判定（#3）。
// 両トークンが純漢字かつ各 4 文字以上 ＝ それぞれが完結した氏名（三好智樹 橋本智広）＝ 2 人。
// 4 文字未満（井上 喜久子＝2+3 / 佐々木 研太郎＝3+3）は姓 名の可能性が残るため割らない（誤分割回避）。
// 4 文字姓は実在ほぼ皆無＝「姓 名」が 4+4 になることはなく、誤って 1 人を 2 タグ化しない安全側の閾値。
function isTwoFullNames(a, b) {
  return PURE_KANJI_RE.test(a) && PURE_KANJI_RE.test(b) && [...a].length >= 4 && [...b].length >= 4
}

// 値（括弧無し）を人名リストに分割する。データ規約と整合する空白の扱い:
//   - 全角空白 U+3000 ＝主に「人物間」区切り（舞台/ライブの全角空白区切りリスト）。
//   - 半角空白 ＝主に「姓 名」区切り（兵頭 秀明 / 佐野 岳）。
// ただし全角空白でも 1 人（姓名）に使う不整合があるため、
// **単一スペース（2 分割）は姓名扱い・3 名以上のみリスト**に統一する（全角/半角を同じ規則で扱う）。
function splitPeople(p) {
  const fp = p
    .split(/\u3000+/)
    .map((s) => s.trim())
    .filter(Boolean)
  let units
  if (fp.length >= 3) {
    units = fp // 3 名以上の全角空白リスト＝人物間区切り
  } else if (fp.length === 2 && fp.some((x) => JP_NAME_SPACE_RE.test(x))) {
    units = fp // 片方が半角姓名（佐野 岳）を含む 2 要素＝全角は人物間区切り
  } else {
    units = [p.replace(/\u3000+/g, ' ')] // 全角空白でも 2 分割は姓名（1 人）。全角空白は半角化して下流へ
  }
  const out = []
  for (const u of units) {
    const hp = u
      .split(JP_NAME_SPACE_RE)
      .map((s) => s.trim())
      .filter(Boolean)
    if (hp.length >= 3)
      out.push(...hp) // 半角空白の 3 名以上リスト（関根優那 高橋りな 寒竹優衣）
    else if (hp.length === 2 && isTwoFullNames(hp[0], hp[1]))
      out.push(...hp) // 純漢字 4+4 の半角空白 2 トークン＝2 人（三好智樹 橋本智広）
    else out.push(u) // それ以外の 2 要素以下は姓名（木村 了）＝分割しない（normalizePersonKey が空白除去）
  }
  return out.length ? out : [p]
}

// 中黒/読点/カンマで連結された複数名を分割する（発見用途）。Western 単一名・括弧内は割らない。
// protectLatin: クレジット role 値（制作:HALF H・P STUDIO 等）では純ラテン社名の中黒を割らない（#2）。
// © 行（mineCopyright）では中黒が別権利者の区切り（©ATLUS・TMS / ©SCEI・IPA）なので保護しない＝割る。
function splitConnected(value, protectLatin = false) {
  const denyKey = value.normalize('NFKC').toLowerCase()
  if (JOINED_NAME_DENYLIST.has(denyKey)) return [value]
  // まず読点/カンマ/スラッシュ/×（括弧外のみ・ほぼ確実に複数人/社区切り。WIT STUDIO×CloverWorks）。
  const parts = splitOutsideParens(value, /[、，,/／×✕]/)
  // 各 part を中黒で分割（括弧外のみ・全 part が純カタカナ = Western 1 名なら割らない）。
  const out = []
  for (const p of parts) {
    if (/・/.test(p) && !/[（(]/.test(p)) {
      const segs = p
        .split('・')
        .map((s) => s.trim())
        .filter(Boolean)
      const allKatakana = segs.length > 0 && segs.every((s) => /^[゠-ヿー]+$/.test(s))
      // 頭文字を中黒で繋いだ 1 名（声優「M・A・O」/ 屋号「P・R・O」）は割らない。
      const allSingleChar = segs.length > 0 && segs.every((s) => [...s].length === 1)
      // 純ラテン社名（HALF H・P STUDIO）は 1 名＝割らない。日本語/かな混じり（奈須きのこ・TYPE-MOON、
      // School Days製作委員会）は片側が非ラテンなので保護しない＝割る（#2: 誤統合・委員会丸ごと消滅を回避）。
      const allLatin =
        protectLatin &&
        segs.length > 0 &&
        segs.every((s) => /[A-Za-z]/.test(s) && !/[ぁ-んァ-ヶ一-龯々〆ー]/u.test(s))
      if (allKatakana || allSingleChar || allLatin) out.push(p)
      else out.push(...segs)
    } else {
      out.push(p)
    }
  }
  return out.length ? out : [value]
}

// 製作委員会系のみを committee として落とす。「JAM Project」「project No.9」「プロジェクトラブライブ！」
// のような実在のグループ/スタジオ/フランチャイズ名は **落とさない**（generic な project/プロジェクト
// 接尾では弾かない＝実名の取りこぼし回避）。
function isCommittee(value) {
  // 原文に空白混入（こまねこフィルムパー トナーズ）があっても判定できるよう空白を無視して照合する（#5）。
  return COMMITTEE_RE.test(value) || COMMITTEE_RE.test(value.replace(/[\s\u3000]+/g, ''))
}

// 話数レンジ/ハッシュ断片か（#1〜20・第61話～第97話・27～50話・Vol.2～3）。
// 注意: `～`/`〜` は実在名（富永 み～な・メ～テレ・L'Arc～en～Ciel・キャイ～ン）にも多用されるため、
// **数字＋話/巻/Vol を伴うレンジ**と **ハッシュ接頭** のみを弾く（裸の `～` では弾かない）。
function isEpisodeFragment(v) {
  if (/^[#＃♯]/u.test(v)) return true // ハッシュ接頭（#1〜20 / #コンパス… / #3以降）
  if (/[\d０-９一二三四五六七八九十百〇零]\s*話/u.test(v)) return true // ◯話（1～4話 / 第61話～第97話 / 第一話～第十話）
  if (/既刊|[\d０-９]+\s*巻|全\s*[\d０-９]+\s*巻/u.test(v)) return true // 既刊1〜5 / 全12巻
  if (/^第?\s*[\d０-９]+\s*[～〜~－—–-]/u.test(v)) return true // 第1～ / 1～（話省略レンジ）
  if (/^vol\.?\s*[\d０-９]/iu.test(v)) return true // Vol.2～3
  return false
}

// value がタグ化に値する人物/会社名か（緩め。noise の最終防波堤。全タグ表示なので名前以外は弾く）。
function isPlausibleName(value) {
  const v = value.trim()
  if (v.length === 0 || v.length > 40) return false
  if (VALUE_STOPWORDS.has(v)) return false
  if (VALUE_STOPWORDS.has(v.normalize('NFKC'))) return false
  if (hasProsePeriod(v)) return false
  if (/(です|ます|なります|表記|について)/.test(v)) return false // 注記文（※…が正式表記です 等）＝名前でない
  if (/(CC-BY|contributors|改変|ライセンス|all rights|reserved)/i.test(v)) return false // ライセンス/権利表記片
  if (/[:：;；]/.test(v)) return false // コロン/セミコロン残り＝役割ラベル/区切りの取り残し（名前でない）
  if (/(under license|used under|all rights|reserved)/i.test(v)) return false // 英語著作権 boilerplate 断片
  if (/^[\d\s.,，、:：#＃[\]()（）・/／'"?？!！~～ー-]+$/.test(v)) return false // 数値/記号のみ
  if (isEpisodeFragment(v)) return false // 話数レンジ/ハッシュ断片
  if (isCommittee(v)) return false
  if (PUBLICATION_NOTE_RE.test(v)) return false // 雑誌/レーベル/連載注記（月刊◯◯・◯◯文庫・◯◯連載）
  if (BROADCASTER_RE.test(v.normalize('NFKC'))) return false
  // 年号入り copyright 文字列
  if (COPYRIGHT_MARK_RE.test(v) && /\d{4}/.test(v)) return false
  return true
}

// 主題歌系 value から曲名（「」『』）・レーベル括弧を捨て、作詞/作曲/編曲/歌 の人名を救出。
function extractSongNames(value) {
  const names = []
  // 「曲名」『曲名』"曲名" を除去
  let v = value.replace(/[「『"][^」』"]*[」』"]/g, ' ')
  // 入れ子 role: 作詞：x 作曲：y 編曲：z 歌：w
  const reNested = /(作詞|作曲|編曲|歌|うた|演奏|歌唱)\s*[:：]\s*([^／/、,，\s（）()]+)/g
  let m
  let hadNested = false
  while ((m = reNested.exec(v)) !== null) {
    hadNested = true
    names.push(m[2])
  }
  if (!hadNested) {
    // 曲名除去後の残り（先頭アーティスト名）。レーベル括弧を落とす。
    v = v.replace(/[（(][^（）()]*[）)]/g, ' ')
    for (const seg of v.split(/[／/、,，]/)) {
      const t = seg.trim()
      if (t) names.push(t)
    }
  }
  return names
}

/**
 * 1 セグメント（role:value）を人物/会社タグ群へ変換する。
 * @returns {Array<{display:string, key:string, source:string, role:string}>}
 */
function entryToTags(role, value, blockSource) {
  // 読点の幅統一を **分割の前に** 行う（半角読点 ､ U+FF64 → 、）。これをしないと ､ が分割集合
  // から漏れ、後段の NFKC（normalizePersonKey）で 、 化して「池尻裕､名嘉真法久」が 1 キーに
  // 結合残存する（#4 根治）。全角読点/カンマは ENTRY_SEP_RE が既に拾う。
  value = (value ?? '').replace(/､/g, '、')
  // 主題歌ラベル（音楽:「… オープニングテーマ｢曲｣OKINO …」）と空白で囲まれた埋め込み年号
  //（製作:竜の子プロダクション 1993 日本コロムビア）をエントリ区切りに置換して分離する（#4 / #1c）。
  value = value.replace(THEME_LABEL_RE, '、').replace(EMBEDDED_YEAR_RE, '、')
  const tags = []
  const push = (display, source) => {
    // 委員会/年号 copyright は cleanDisplay が括弧/曲名で切る前に生値で弾く
    //（「アニメ「X」製作委員会」→ 切ると「アニメ」が残ってしまうため）。
    if (isCommittee(display) || (COPYRIGHT_MARK_RE.test(display) && /\d{4}/.test(display))) return
    const disp = cleanDisplay(display)
    if (!disp) return
    if (!isPlausibleName(disp)) return
    // 委員会代理の generic ◯◯プロジェクト（製作/制作・copyright 経路のみ）を落とす（#1c）。
    if (
      (source === 'copyright' || source === 'studio') &&
      GENERIC_PROJECT_RE.test(disp.replace(/[\s\u3000]+/g, ''))
    )
      return
    const key = normalizePersonKey(disp)
    if (!key || [...key].length <= 1) return // 1 文字キー（頭文字片）はタグにしない
    if (VALUE_STOPWORDS.has(key)) return // 正規化後が役割語/汎用語（ほか。→ほか 等）
    if (isRoleLabel(key)) return // 役割ラベルだけ（作画監督/シリーズ構成/キャラクターデザイン 等）＝人名でない
    tags.push({ display: disp, key, source, role })
  }

  const isStaff = STAFF_KEYS.some((k) => role.includes(k))
  const isStudio = STUDIO_ROLE_RE.test(role)
  const isSong = SONG_ROLE_RE.test(role) && !/音楽$/.test(role) // 「音楽」は劇伴作曲＝人名なので song 扱いしない

  if (isSong) {
    for (const n of extractSongNames(value)) {
      // `；`/`／`/読点で区切り、各片は「役割：名前」なら最後のコロン以降＝名前を採る
      //（アーティスト：佐咲紗花→佐咲紗花、編曲：YANAGIMAN；→YANAGIMAN）。
      for (let seg of n.split(/[；;／/、,]/)) {
        const cm = seg.match(/[:：]([^:：]*)$/)
        if (cm) seg = cm[1]
        const { name } = splitAffiliation(seg.trim())
        for (const part of splitConnected(name, true)) push(part, 'themeSong')
      }
    }
    return tags
  }

  const source = isStudio ? 'studio' : isStaff ? 'staffLike' : blockSource
  const dropParen = ORIGINAL_WORK_ROLE_RE.test(role) // 原作系 role の括弧は出版社注記＝捨てる（構造的）

  // **エントリ分割の前に**引用符タイトル（『…、…』）を除去する。これをしないと作品名内の読点で
  // 誤分割され、タイトル断片（鑑定スキルで成り上がる〜…）が人名タグ化する。括弧（…）は所属なので残す。
  const noTitles = stripQuotedTitles(value)

  // 値を読点/カンマでエントリ分割（空白は splitPeople が姓名/リストを判定するのでここでは割らない）。
  for (const entry of splitOutsideParens(noTitles, ENTRY_SEP_RE)) {
    // 製作委員会名（A・B製作委員会 等）は `・` 分割で断片化する前に、エントリ単位で丸ごと捨てる。
    if (isCommittee(entry)) continue
    // 「【ユニット】キャラ（/別名）役：俳優」形式 → 最後のコロン以降＝実在名を採る（役名/ユニット名は捨てる）。
    let p = entry.replace(/【[^】]*】/g, ' ')
    const cm = p.match(/[:：]([^:：]*)$/)
    if (cm) p = cm[1]
    p = p.replace(/役\s*$/, '').trim()
    // 引用符タイトル（作品/曲名）はスペース分割の前に除去する。英字タイトル
    //（『FAIRY TAIL 100 YEARS QUEST』）が半角スペース分割で TAIL/YEARS/QUEST に砕けるのを防ぐ。
    // 括弧（…）は所属会社なので splitAffiliation に残す（ここでは触らない）。
    p = p
      .replace(/[「『＜《｢"][^」』＞》｣"]*[」』＞》｣"]/g, ' ')
      .replace(/[「『＜《｢"].*$/u, ' ')
      .trim()
    // タイトル除去で末尾に残った役割注記（奥田 陽介『…』作画監督 → 奥田 陽介 作画監督）を分離。
    p = stripTrailingRole(p)
    if (!p) continue
    // 空白区切りの人名リスト/姓名を splitPeople で判定（全角/半角を統一規則で）。
    // 括弧があるもの（所属・連載・ふりがな注記）は丸ごと splitAffiliation に渡す＝空白で割らない。
    const subs = /[（(]/.test(p) ? [p] : splitPeople(p)
    for (const sub of subs) {
      // 先に所属括弧を分離（中黒分割より前）。これで「真島ヒロ・上田敦夫（講談社連載）」は注記を
      // 落としてから中黒分割でき（→真島ヒロ/上田敦夫）、「今野康之（スワラ・プロ）」は括弧内を割らない。
      const { name, org } = splitAffiliation(sub, dropParen)
      for (const part of splitConnected(name, true)) push(part, source)
      if (org) for (const o of splitConnected(org, true)) push(o, 'studio') // 所属/括弧内メンバーも分割
    }
  }
  return tags
}

// 段落（ブロック）が「クレジット行か」を粗く判定し、role:value セグメントを取り出す。
// blockSource: castLike（出演/役名行）/ staffLike / copyright。
function parseBlock(block, blockSource) {
  const tags = []
  const segs = block
    .split('／')
    .map((s) => s.trim())
    .filter(Boolean)
  // 役名なし出演リスト「出演:俳優A／俳優B／俳優C」対応: 出演/声の出演/キャスト で始まったら、
  // 以降のコロン無しセグメント（俳優名が直接並ぶ）も俳優名として採る。別の役割（コロン付き）が
  // 来たら解除。アニメの「役名:声優／役名:声優」は各セグに役名(コロン)があるので誤発火しない。
  let performMode = false
  for (const seg of segs) {
    const m = seg.match(/^([^：:]{1,40})[：:]\s*(.+)$/)
    if (!m) {
      // コロン無し＝出演リストの続き（役名なしパターン）なら俳優名として採用
      if (performMode) tags.push(...entryToTags('出演', seg, blockSource))
      continue
    }
    const role = m[1].trim()
    const value = m[2].trim()
    if (NUMERIC_ROLE_RE.test(role)) continue // setlist 番号
    if (EPISODE_MARKER_RE.test(role)) continue // 各話概要「第1話：…」「#3：…」
    if (value.length === 0) continue
    performMode = PERFORM_ROLE_RE.test(role) // 出演系で開始・他役割で解除
    tags.push(...entryToTags(role, value, blockSource))
  }
  return tags
}

// 著作権（©）行から制作実体（著者・出版社・制作会社）をマイニングする（#3 = recall 要件）。
// role:value を持たない `©藤本タツキ／集英社・MAPPA` `©カラー／EVA製作委員会` は parseBlock では
// 拾えず空になるため、ここで © 直後の著者名・／後の社名を救出する。年号・◯◯製作委員会・記号は除外。
// 英語法人格サフィックス（CO., LTD. / Inc. / LLC / Corp.）。連結分割の前に末尾から剥がす＝
// 「SANRIO CO., LTD.」が読点分割で「SANRIO CO.」「LTD.」に砕けるのを防ぎ「SANRIO」に寄せる。
const CORP_SUFFIX_RE =
  /[\s,，、]*(?:co\.?\s*,?\s*ltd\.?|company\s*,?\s*limited|corporation|corp\.?|incorporated|inc\.?|l\.?l\.?c\.?|ltd\.?|co\.|k\.?\s*k\.?)\.?\s*$/i
function stripCorpSuffix(s) {
  let prev
  let out = s.trim()
  do {
    prev = out
    out = out.replace(CORP_SUFFIX_RE, '').trim()
  } while (out !== prev && out)
  return out
}
// 裸の法人格サフィックスだけのキー（ltd/inc/co/llc/corp/kk）はタグにしない（安全網）。
const BARE_CORP_RE = /^(?:co|ltd|inc|llc|corp|kk|coltd)$/i

// 空白で囲まれた役割語（`MilkyCartoon 原作 Naomi Iwata` の 原作）= 実体間の区切り。区切りに置換して割る。
const EMBEDDED_ROLE_SEP_RE =
  /[\s\u3000]+(?:原作|原案|原著|監督|総監督|脚本|構成|シリーズ構成|作画|作画監督|演出|音楽|キャラクターデザイン|キャラクター原案)[\s\u3000]+/gu

function mineCopyright(block) {
  const tags = []
  const pushName = (display) => {
    if (isCommittee(display)) return
    const disp = stripCorpSuffix(cleanDisplay(display))
    if (!disp) return
    if (!isPlausibleName(disp)) return
    if (GENERIC_PROJECT_RE.test(disp.replace(/[\s\u3000]+/g, ''))) return // generic ◯◯プロジェクト（委員会代理）
    const key = normalizePersonKey(disp)
    if (!key || [...key].length <= 1) return
    if (VALUE_STOPWORDS.has(key) || isRoleLabel(key) || BARE_CORP_RE.test(key)) return
    tags.push({ display: disp, key, source: 'copyright', role: 'copyright' })
  }
  for (let line of block.split('\n')) {
    line = stripQuotedTitles(line)
      .replace(/[©Ⓒⓒ]|\([Cc]\)|[®™]/g, ' ') // © (C) ® ™
      .replace(/all rights reserved\.?/gi, ' ')
      .replace(/､/g, '、')
    // 主区切り＝スラッシュ（©著者／出版社・制作会社）。各トークンの先頭年号と法人格を落として連結分割。
    for (let tok of line.split(/[／/]/)) {
      tok = tok
        .replace(/^[\s.。・,，、:：'"“”‐–—-]+/u, '') // 行頭の飾り
        .replace(LEADING_YEAR_RE, '') // 先頭の年（©2016 … / 1990年－1994年）
        .trim()
      tok = tok.replace(LEADING_ROLE_RE, '').trim() // 先頭の役割語（制作協力ENGI→ENGI）
      tok = tok.replace(DEPT_SUFFIX_RE, '').trim() // 末尾の部署（…企画製作部→…）
      tok = tok
        .replace(EMBEDDED_YEAR_RE, '／') // 埋め込み年号で実体を区切る（…1993…→区切り）
        .replace(EMBEDDED_ROLE_SEP_RE, '／') // 埋め込み役割語（… 原作 …）で実体を区切る
      tok = stripCorpSuffix(tok) // CO., LTD. を分割前に剥がす（SANRIO CO., LTD.→SANRIO）
      if (!tok) continue
      for (const part of splitConnected(tok)) pushName(part)
    }
  }
  return tags
}

/**
 * 生 description → 発見タグ列（per-series・recurrence 適用前）。
 * @param {string|null|undefined} rawHtml
 * @returns {{ structured:boolean, tags:Array<{display:string,key:string,source:string,role:string}>,
 *            synopsis:string|null, copyrightRaw:string|null }}
 */
export function extractCredits(rawHtml) {
  const text = stripHtml(rawHtml)
  if (!text) return { structured: false, tags: [], synopsis: null, copyrightRaw: null }

  const structured = isStructuredCredits(rawHtml)
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)

  if (!structured) {
    // フラット（区切り無し）は分解しない＝誤検知源。synopsis のみ温存。
    return { structured: false, tags: [], synopsis: text, copyrightRaw: null }
  }

  const allTags = []
  const synopsisParas = []
  let copyrightRaw = null

  for (const block of blocks) {
    // 1) 話リンク / info は捨てる
    if (LINKS_RE.test(block) || (INFO_RE.test(block) && block.length < 160)) continue

    const hasColonSeg = /[：:]/.test(block) && /[^：:]+[：:].+/.test(block)
    const isCopyright = COPYRIGHT_MARK_RE.test(block) || COMMITTEE_RE.test(block)

    if (isCopyright) {
      // copyright ブロックから制作実体（原作者/監督/制作会社）を救出。
      // role:value があれば parseBlock、無ければ mineCopyright（©著者／社名）で拾う（#3 recall）。
      copyrightRaw = copyrightRaw ? `${copyrightRaw}\n${block}` : block
      if (hasColonSeg) allTags.push(...parseBlock(block, 'copyright'))
      else allTags.push(...mineCopyright(block))
      continue
    }

    if (hasColonSeg) {
      // 各話概要/あらすじが「／」とコロンを含みクレジット様に見える段落はプロ―ズなので抽出しない
      //（hasProsePeriod の文末でプロ―ズ判定 → synopsis 温存）。混在クレジット（おしりたんてい型）は
      // 文末を持たないので通る。
      if (hasProsePeriod(block)) {
        synopsisParas.push(block)
        continue
      }
      // 出演/役名/スタッフ混在ブロックを per-segment 分類（entryToTags が role で振り分け）。
      allTags.push(...parseBlock(block, 'castLike'))
      continue
    }

    // それ以外 = プロ―ズ（あらすじ）
    synopsisParas.push(block)
  }

  // series 内 dedup（key 単位・最初の display/source/role を優先）
  const byKey = new Map()
  for (const t of allTags) {
    if (!byKey.has(t.key)) byKey.set(t.key, t)
  }

  return {
    structured: true,
    tags: [...byKey.values()],
    synopsis: synopsisParas.join('\n\n') || null,
    copyrightRaw,
  }
}

/**
 * 複数シリーズの per-series タグから recurrence（key→出現シリーズ数）を数える。
 * @param {Iterable<Array<{key:string}>>} perSeriesTagLists
 * @returns {Map<string, number>}
 */
export function countRecurrence(perSeriesTagLists) {
  const count = new Map()
  for (const tags of perSeriesTagLists) {
    const keys = new Set(tags.map((t) => t.key))
    for (const k of keys) count.set(k, (count.get(k) ?? 0) + 1)
  }
  return count
}

/**
 * credit 抽出メトリクスを集計する（運用ログ用・フォーマットドリフト検知）。
 * 実体 extractCredits を通すので、**実保存形式（HTML strip 済みの \n\n / ／）でも正しく**数える
 * （旧 description.mjs の <br> 限定判定とは異なり 0% に張り付かない）。
 * @param {Iterable<string|null|undefined>} rawDescriptions - 各シリーズ1話目の description（生 or strip 済み）
 * @returns {{ total:number, structured:number, flat:number, withCredits:number,
 *             totalTags:number, structuredPct:number, creditCoveragePct:number, avgTagsPerSeries:number }}
 */
export function summarizeCreditExtraction(rawDescriptions) {
  const m = { total: 0, structured: 0, flat: 0, withCredits: 0, totalTags: 0 }
  for (const raw of rawDescriptions) {
    m.total++
    const r = extractCredits(raw)
    if (r.structured) m.structured++
    else m.flat++
    if (r.tags.length) m.withCredits++
    m.totalTags += r.tags.length
  }
  const pct = (n) => (m.total ? Math.round((1000 * n) / m.total) / 10 : 0)
  return {
    ...m,
    structuredPct: pct(m.structured),
    creditCoveragePct: pct(m.withCredits),
    avgTagsPerSeries: m.total ? Math.round((100 * m.totalTags) / m.total) / 100 : 0,
  }
}
