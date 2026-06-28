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
])

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
// 値のエントリ区切り（全角スペース U+3000 ＝舞台/ライブの名前区切り・読点・カンマ）。
// 半角スペースは姓名内（木村 了）なので分割しない。
const ENTRY_SEP_RE = /[\u3000、，,]/
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

// 表示用に value を軽く整える（注記/作品名/末尾「他」除去・前後空白）。canonical はこの結果から導く。
function cleanDisplay(name) {
  let s = (name ?? '').trim()
  s = s.replace(/^[©Ⓒⓒ®™\s]+/u, '') // 行頭の ©/®（©Frontwing → Frontwing）
  s = s.replace(/^[（(](?:CV|Cv|cv|ＣＶ)[）)]\s*/u, '') // 声優マーカー (CV) 接頭（(CV)宮野 真守 → 宮野 真守）
  // 最初の括弧/引用符以降（作品名・掲載誌・注記）を落とす。所属会社は splitAffiliation で分離済み。
  s = s.replace(/[「『（(【＜<｢《].*$/u, '')
  // 対応開きが別片に行った閉じ括弧以降（「作品名」より / ｣連載 の断片）も落とす。
  s = s.replace(/[」』｣》＞］].*$/u, '')
  s = s.replace(/\s*※.*$/u, '') // ※注記
  s = s.replace(/\s+著.*$/u, '') // 「○○ 著『…』」
  s = s.replace(/\s*[…‥]+$/u, '') // 末尾の…（and more… 等）
  s = s.replace(/[\s、,]*(?:他|ほか)(?:多数)?[。\s]*$/u, '') // 末尾「他」「ほか。」
  s = s.replace(/(\D)\s*(?:19|20)\d{2}$/u, '$1') // 末尾の年（アンサンブル 2014→アンサンブル・1869 等は非数字前置のみ）
  s = s.replace(/^[・,，、/／\s]+/, '').replace(/[・,，、/／\s」』）)】＞>｣》\]｝}]+$/, '')
  return s.trim()
}

// 出版社/掲載誌の注記（人物の所属会社ではない）。これが括弧内なら捨てて名前だけ残す。
const PUBLISHER_ANNOTATION_RE =
  /(連載|掲載|所載|刊|文庫|コミック|新聞|放送|より|月刊|週刊|集英社|講談社|小学館|角川|KADOKAWA|新潮社|白泉社|秋田書店|双葉社|一迅社|スクウェア|ジャンプ|マガジン|サンデー|チャンピオン|電撃|ガンガン|\d{4})/i

// value 末尾の括弧を分離: 「米山和仁（劇団ホチキス）」→ {name:'米山和仁', org:'劇団ホチキス'}。
// 出版社注記（「集英社…連載」等）は所属会社でないので括弧ごと捨てて名前だけ残す（岸本斉史）。
function splitAffiliation(value) {
  const m = value.match(/^(.+?)[（(]([^（）()]{1,40})[）)]\s*$/)
  if (!m) return { name: value, org: null }
  const name = m[1].trim()
  const inner = m[2].trim()
  if (!name) return { name: value, org: null }
  if (PUBLISHER_ANNOTATION_RE.test(inner)) return { name, org: null } // 注記は捨ててクリーン名
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
function splitJapaneseNameList(s) {
  return s
    .split(JP_NAME_SPACE_RE)
    .map((x) => x.trim())
    .filter(Boolean)
}

// 中黒/読点/カンマで連結された複数名を分割する（発見用途）。Western 単一名・括弧内は割らない。
function splitConnected(value) {
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
      if (allKatakana || allSingleChar) out.push(p)
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
  return COMMITTEE_RE.test(value)
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
  if (/^[\d\s.,，、:：#＃[\]()（）・/／'"?？!！~～ー-]+$/.test(v)) return false // 数値/記号のみ
  if (isCommittee(v)) return false
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
  const tags = []
  const push = (display, source) => {
    // 委員会/年号 copyright は cleanDisplay が括弧/曲名で切る前に生値で弾く
    //（「アニメ「X」製作委員会」→ 切ると「アニメ」が残ってしまうため）。
    if (isCommittee(display) || (COPYRIGHT_MARK_RE.test(display) && /\d{4}/.test(display))) return
    const disp = cleanDisplay(display)
    if (!disp) return
    if (!isPlausibleName(disp)) return
    const key = normalizePersonKey(disp)
    if (!key || [...key].length <= 1) return // 1 文字キー（頭文字片）はタグにしない
    if (VALUE_STOPWORDS.has(key)) return // 正規化後が役割語/汎用語（ほか。→ほか 等）
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
        for (const part of splitConnected(name)) push(part, 'themeSong')
      }
    }
    return tags
  }

  const source = isStudio ? 'studio' : isStaff ? 'staffLike' : blockSource

  // 値を全角スペース(U+3000)/読点でエントリ分割（舞台・ライブの「A[全]B[全]C」名前リスト）。
  // 全角スペース＝名前区切り、半角スペース＝姓名内（木村[半]了）＝データ規約で確認済み（ENTRY_SEP_RE）。
  for (const entry of splitOutsideParens(value, ENTRY_SEP_RE)) {
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
    if (!p) continue
    // 日本語の半角スペース区切り名前リスト（関根優那 高橋りな 寒竹優衣…）を分割。
    // **日本語の文字どうしの間の半角スペースだけ**で割る＝ラテン社名の内部スペース
    //（Planet Kids Entertainment / VACAR ENTERTAINMENT）は絶対に割らない。括弧があるもの
    //（所属・連載注記）と 2 名以下（「木村 了」＝姓名）は割らない＝3 名以上のリストのみ。
    const cand = /[（(]/.test(p) ? [p] : splitJapaneseNameList(p)
    const subs = cand.length >= 3 ? cand : [p]
    for (const sub of subs) {
      // 先に所属括弧を分離（中黒分割より前）。これで「真島ヒロ・上田敦夫（講談社連載）」は注記を
      // 落としてから中黒分割でき（→真島ヒロ/上田敦夫）、「今野康之（スワラ・プロ）」は括弧内を割らない。
      const { name, org } = splitAffiliation(sub)
      for (const part of splitConnected(name)) push(part, source)
      if (org) for (const o of splitConnected(org)) push(o, 'studio') // 所属/括弧内メンバーも分割
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
      // copyright ブロックも role:value を再パースして制作実体（原作者/監督/制作会社）を救出。
      copyrightRaw = copyrightRaw ? `${copyrightRaw}\n${block}` : block
      if (hasColonSeg) allTags.push(...parseBlock(block, 'copyright'))
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
