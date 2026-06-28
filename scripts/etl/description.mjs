// scripts/etl/description.mjs
// PH-0014 / F-0057: 各話 description の構造分解パーサ。
//
// 方針（誤検知ゼロ最優先）:
//   - 構造版（nvapi: <br> 区切り。isStructuredDescription=true）のみ cast/staff へ分解する。
//   - フラット（RSS: <p> ラッパのみで <br> 無し）は分解せず synopsis フォールバック。
//     フラットは「あらすじ＋クレジットが区切り無しで 1 塊」になりがちで境界を一意化できない
//     （例: シュプール:逢坂良太原作:佐賀崎しげる…）ため、分解＝誤検知になる。
//   - 段落（\n\n 区切り）単位で分類。cast/staff ブロックは「全エントリが role:value で割れる
//     ときだけ」採用し、1 つでも壊れていればブロックごと synopsis に温存（lossless）。
//   - 解釈できなかったものは捨てず synopsis に残し、unclassified にも記録（メトリクスで気づける）。

import { stripHtml, isStructuredDescription } from './series.mjs'

// スタッフ役割マーカー（実データ頻度順＋音楽/主題歌系。これを含む段落 = staff）。
const STAFF_KEYS = [
  '原作',
  '原案',
  '総監督',
  '監督',
  'シリーズ構成',
  '脚本',
  '構成',
  'キャラクターデザイン',
  '総作画監督',
  '作画監督',
  'アニメーションキャラクター',
  'アニメーション制作',
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
  'プロデューサー',
  '主題歌',
  'オープニングテーマ',
  'エンディングテーマ',
  'テーマ曲',
  '挿入歌',
  '作詞',
  '作曲',
  '編曲',
]

const COPYRIGHT_RE = /[©Ⓒ]|\(C\)|\(c\)|製作委員会/
const LINKS_RE = /(←\s*前話|次話\s*→|第一?話\s*→|第1話\s*→)/
const INFO_RE = /(動画投稿|コミュ投稿)/

function hasStaffKeyword(para) {
  return STAFF_KEYS.some((k) => para.includes(k + ':') || para.includes(k + '：'))
}

// 段落を「役:値／役:値…」エントリ配列へ。1 つでも role:value で割れなければ null（＝採用しない）。
function parseEntries(para) {
  const segs = para
    .split('／')
    .map((s) => s.trim())
    .filter(Boolean)
  if (segs.length === 0) return null
  const out = []
  for (const s of segs) {
    const m = s.match(/^([^：:]+)[：:]\s*(.+)$/)
    if (!m) return null // 壊れたセグメントが 1 つでもあればブロックごと不採用（lossless）
    out.push({ role: m[1].trim(), value: m[2].trim() })
  }
  return out
}

// cast 候補か（staff キーワードを含まず、2 件以上の role:value を ／ で並べた段落）。
function looksLikeCast(para) {
  if (hasStaffKeyword(para)) return false
  const segs = para.split('／').filter((s) => s.trim())
  if (segs.length < 2) return false
  return segs.every((s) => /[：:]/.test(s))
}

// 「文の句点」検出: 。が閉じ括弧以外の前に来る＝プロ―ズの文末。
// 『バクマン。』『モーニング娘。』のように作品名・グループ名の 。は閉じ括弧が続くので除外。
function hasProsePeriod(s) {
  return /。(?![）」』）])/.test(s)
}

// クレジットブロックの妥当性（誤検知ゼロ）: 役名/声優名/人名はプロ―ズではなく短い。
// 各話要約「#3：突如…メフィスト。…」や台詞コロンを含む文を cast/staff と誤認しないための砦。
//   - role/value に「文の句点 。」を含む → プロ―ズ → ブロックごと不採用（synopsis へ温存）
//   - value が極端に長い／role が長すぎる → 同上
// role が数値/記号のみ（setlist 番号「01」「Track2」やタイムテーブル）= クレジットでない。
// 正規の役名/役割は数値のみにならないため、弾いても正規データの損失はゼロ（precision 防御）。
// 注: value 側の数値名（イラストレーター「029」/作曲「1869」等）は正規なので弾かない。
const NUMERIC_ROLE_RE = /^[\d\s.:#＃[\]()（）-]+$/
function isPlausibleCreditBlock(entries, maxAvg, maxVal) {
  if (!entries || entries.length === 0) return false
  let sum = 0
  for (const e of entries) {
    const v = e.value ?? ''
    const role = e.role ?? ''
    if (hasProsePeriod(v) || hasProsePeriod(role)) return false // 文＝プロ―ズ
    if (v.length > maxVal || role.length > 50) return false // 極端に長い＝プロ―ズ
    if (NUMERIC_ROLE_RE.test(role)) return false // setlist/番号/時刻 = クレジットでない
    sum += v.length
  }
  return sum / entries.length <= maxAvg
}

// 末尾の話リンク（so…←前話 / 次話→so… / 第一話→so…）を抽出。
function extractEpisodeLinks(para) {
  const links = {}
  const prev = para.match(/(so\d+|\d{6,})\s*←\s*前話/)
  if (prev) links.prev = prev[1]
  const next = para.match(/次話\s*→\s*(so\d+|\d{6,})/)
  if (next) links.next = next[1]
  const first = para.match(/第一?話\s*→\s*(so\d+|\d{6,})|第1話\s*→\s*(so\d+|\d{6,})/)
  if (first) links.first = first[1] || first[2]
  return Object.keys(links).length ? links : null
}

function isStudioRole(role) {
  return role.includes('アニメーション制作') || role === '制作' || role === '製作'
}

/**
 * 生 description（HTML）を構造分解する。
 * @param {string|null|undefined} rawHtml
 * @returns {{
 *   structured: boolean,
 *   synopsis: string|null,
 *   cast: Array<{role:string, actors:string[]}>,
 *   staff: Array<{role:string, names:string[]}>,
 *   studios: string[],
 *   copyright: string|null,
 *   episodeLinks: {prev?:string,next?:string,first?:string}|null,
 *   unclassified: string[],
 * }}
 */
export function parseDescription(rawHtml) {
  const empty = {
    structured: false,
    synopsis: null,
    cast: [],
    staff: [],
    studios: [],
    copyright: null,
    episodeLinks: null,
    unclassified: [],
  }
  const text = stripHtml(rawHtml)
  if (!text) return empty

  const structured = isStructuredDescription(rawHtml)
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)

  // フラット（非構造）: 分解しない。info 段落だけ落として残りを synopsis に温存。
  if (!structured) {
    const keep = paragraphs.filter((p) => !(INFO_RE.test(p) && p.length < 120))
    return { ...empty, structured: false, synopsis: keep.join('\n\n') || text }
  }

  const cast = []
  const staff = []
  const studios = []
  const synopsisParas = []
  const unclassified = []
  let copyright = null
  let episodeLinks = null

  for (const para of paragraphs) {
    // 1) 話リンク / info
    if (LINKS_RE.test(para) || (INFO_RE.test(para) && para.length < 160)) {
      const l = extractEpisodeLinks(para)
      if (l) episodeLinks = { ...(episodeLinks ?? {}), ...l }
      continue // info/リンクは synopsis に出さない
    }
    // 2) copyright
    if (COPYRIGHT_RE.test(para) || /^原作／/.test(para)) {
      copyright = copyright ? `${copyright}\n${para}` : para
      continue
    }
    // 3) staff（役割キーワード＋コロン）
    if (hasStaffKeyword(para)) {
      const entries = parseEntries(para)
      // 社名・複数人で値がやや長くなるため staff は緩め（平均30/最大120）。
      if (entries && isPlausibleCreditBlock(entries, 30, 120)) {
        for (const e of entries) {
          staff.push({ role: e.role, names: [e.value] })
          if (isStudioRole(e.role)) studios.push(e.value)
        }
        continue
      }
      // 割れない/プロ―ズ疑い → 温存
      unclassified.push(para)
      synopsisParas.push(para)
      continue
    }
    // 4) cast（役名:声優／… が 2 件以上・staff キーワード無し）
    if (looksLikeCast(para)) {
      const entries = parseEntries(para)
      // 声優名は短い。各話要約の「#3：文／#4：文」を弾くため cast は厳しめ（平均22/最大100）。
      if (entries && isPlausibleCreditBlock(entries, 22, 100)) {
        for (const e of entries) cast.push({ role: e.role, actors: [e.value] })
        continue
      }
      unclassified.push(para)
      synopsisParas.push(para)
      continue
    }
    // 5) それ以外 = synopsis（プロ―ズ）
    synopsisParas.push(para)
  }

  // studios 重複排除（順序保持）
  const studiosDedup = [...new Set(studios)]

  return {
    structured: true,
    synopsis: synopsisParas.join('\n\n') || null,
    cast,
    staff,
    studios: studiosDedup,
    copyright,
    episodeLinks,
    unclassified,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// extractCredits — 「他作品に繋がる名前タグ」を 1 列に統合して抽出（新設計）。
//
// 動機: ユーザーは「同じ声優・監督・脚本・音楽・制作スタジオ・原作者などで他作品を
//   探す」ために使う。cast/staff/studios/copyright の分類は発見用途では不要なので
//   捨て、**関係者の名前を 1 つの dedup したリスト**にまとめる。役名・役割ラベルは
//   出さない（名前だけがタグ）。precision は parseDescription のガードを土台に保ちつつ、
//   分類を捨てた分シンプルにし、copyright マイニングで recall を上げる。
// ──────────────────────────────────────────────────────────────────────────

// 連結値の分割モード（測定で決定。doc 8.x 参照）:
//   'none' = 分割しない / 'safe' = 読点 、 と , のみ / 'all' = 中黒 ・ も分割。
// 'safe' を既定とする: `高橋ナツコ、成田 順` のような明確な複数人は分割でき、
// `ジョージ・R・R・マーティン` のような外国人名の中黒を壊さない（測定で precision 最良）。
export const CREDIT_SPLIT_MODE = 'safe'

// 主題歌系 role: value は「曲タイトル」か「アーティスト名」のどちらか。
// 曲タイトル（『…』「…」）は単作品＝発見に繋がらないので捨て、アーティスト名（他作品でも
// 再登場）は残す。作詞/作曲/編曲 は人名なので別扱い不要（そのまま名前として取る）。
const THEME_ROLE_RE = /主題歌|テーマ|挿入歌|ＯＰ|ＥＤ/

// 末尾の所属括弧を除去: `米山和仁（劇団ホチキス）`→`米山和仁`、`Aimer(DefSTAR RECORDS)`→`Aimer`。
// 全角/半角の対応括弧が末尾にあるときだけ落とす（名前途中の括弧 `(株)` 等は触らない）。
function stripAffiliation(s) {
  let prev
  let out = s.trim()
  // 末尾括弧が入れ子・連続することがあるので無くなるまで剥がす。
  do {
    prev = out
    out = out.replace(/[（(][^（）()]*[）)]\s*$/, '').trim()
  } while (out !== prev)
  return out
}

// 主題歌 value から曲タイトル（引用符内）を除去し、残った文字列（アーティスト）を返す。
function stripSongTitles(v) {
  return v
    .replace(/[「『“"][^」』”"]*[」』”"]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// 連結値を人名/社名へ分割する（モード依存）。copyright マイニングは常に 'all'（集英社・MAPPA）。
function splitNames(s, mode) {
  if (mode === 'none') return [s]
  const re = mode === 'all' ? /[、，,・]/ : /[、，,]/
  return s
    .split(re)
    .map((x) => x.trim())
    .filter(Boolean)
}

// 発見に繋がらないノイズ名か（true=捨てる）。
//   - 空 / 製作委員会名（単作品で無価値）/ © 記号・年（©2017 等）
//   - 数値・記号のみ（曲順番号・空括弧）/ 文（句点を含むプロ―ズ）/ 極端に長い（曲名・あらすじ片）
const YEAR_ONLY_RE = /^[©Ⓒ\s]*\d{4}(?:[-–~〜]\d{2,4})?年?$/
const SYMBOL_ONLY_RE = /^[\d\s.,、，:：#＃[\]()（）/／・\-–—~〜'"`’”+&!！?？]+$/
function isNoiseName(s) {
  const t = (s ?? '').trim()
  if (!t) return true
  if (/製作委員会|制作委員会|パートナーズ|partners/i.test(t)) return true
  if (YEAR_ONLY_RE.test(t)) return true
  if (SYMBOL_ONLY_RE.test(t)) return true
  if (hasProsePeriod(t)) return true
  if ([...t].length > 30) return true
  return false
}

// 1 つの生 value を「掃除済みの名前配列」へ。
// **所属除去を分割より先に**行うのが要点: `水無月すう(…連載、角川コミックス・エース刊)` のように
// 括弧内に区切り（、・）を含む所属注記があるとき、先に分割すると括弧が壊れて garbage になる。
// 末尾括弧を丸ごと落としてから分割すれば内部の区切りに触れず安全（測定で precision 改善を確認）。
function cleanValueToNames(value, { theme = false, mode = CREDIT_SPLIT_MODE } = {}) {
  let v = (value ?? '').trim()
  if (!v) return []
  if (theme) {
    v = stripSongTitles(v)
    if (!v) return [] // 曲タイトルだけだった＝発見に無価値
  }
  v = stripAffiliation(v)
  const out = []
  for (const piece of splitNames(v, mode)) {
    const name = stripAffiliation(piece) // 分割後の各片にも末尾括弧が残りうるので再度
    if (!isNoiseName(name)) out.push(name)
  }
  return out
}

// copyright 行から制作実体（人名・社名）をマイニングする。
//   `©カラー／EVA製作委員会`→[カラー]、`©藤本タツキ／集英社・MAPPA`→[藤本タツキ,集英社,MAPPA]、
//   `原作:谷口悟朗、…J.C.STAFF／脚本・演出:…`→[谷口悟朗, J.C.STAFF, …]。
//   ノイズ（©記号・年・製作委員会名）は isNoiseName で落とす。
function mineCopyright(copyright) {
  if (!copyright) return []
  const out = []
  for (const line of copyright.split('\n')) {
    // 区切り（全角／・半角/・読点・中黒）でトークン化。copyright は中黒も分割対象（集英社・MAPPA）。
    for (let tok of line.split(/[／/、，,・]/)) {
      tok = tok
        .replace(/[©Ⓒ]|\([Cc]\)|[Ⓡ™]/g, '') // ©/(C)/®/™
        .replace(/All Rights Reserved\.?/gi, '')
        .replace(/^[\s.。…・,，、:：'"“”‐\-–—]+/, '') // 行頭の記号・年残り前の飾り
        .replace(/^\s*\d{4}(?:[-–~〜]\d{2,4})?\s*/, '') // 先頭の年（©2016 ...）
        .replace(/^[^：:]{1,14}[：:]\s*/, (m) => (/[A-Za-z]/.test(m) ? m : '')) // 行頭の役ラベル（原作:）を除去（英字 URL 風は残す）
        .trim()
      tok = stripAffiliation(tok)
      if (!isNoiseName(tok)) out.push(tok)
    }
  }
  return out
}

/**
 * 生 description（HTML）から「他作品に繋がる名前タグ」を 1 列に統合して抽出する（新設計）。
 * cast の声優名・staff の人名/社名（主題歌は曲名を除きアーティストを残す）・studios・
 * copyright マイニング由来の制作実体を、所属括弧除去・分割・ノイズ落とし・dedup した配列で返す。
 * @param {string|null|undefined} rawHtml
 * @param {('none'|'safe'|'all')} [mode] - 連結値の分割モード（既定 CREDIT_SPLIT_MODE）。測定用に注入可。
 * @returns {string[]}  順序保持・重複除去済みの名前タグ列
 */
export function extractCredits(rawHtml, mode = CREDIT_SPLIT_MODE) {
  const p = parseDescription(rawHtml)
  const names = []
  for (const c of p.cast) {
    for (const a of c.actors ?? []) names.push(...cleanValueToNames(a, { mode }))
  }
  for (const s of p.staff) {
    const theme = THEME_ROLE_RE.test(s.role ?? '')
    for (const n of s.names ?? []) names.push(...cleanValueToNames(n, { theme, mode }))
  }
  for (const st of p.studios) names.push(...cleanValueToNames(st, { mode }))
  names.push(...mineCopyright(p.copyright))
  // dedup（順序保持）
  const seen = new Set()
  const out = []
  for (const n of names) {
    if (n && !seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  return out
}

/**
 * 複数 description のパース結果メトリクスを集計（F-0059 ＝ログ/回帰検出用）。
 * @param {Iterable<string|null>} rawDescriptions
 */
export function summarizeDescriptionParse(rawDescriptions) {
  const m = {
    total: 0,
    structured: 0,
    flatFallback: 0,
    withCast: 0,
    withStaff: 0,
    withStudios: 0,
    withCopyright: 0,
    withCredits: 0,
    unclassifiedParagraphs: 0,
    parsedRatePct: 0,
  }
  for (const raw of rawDescriptions) {
    m.total++
    const r = parseDescription(raw)
    if (r.structured) m.structured++
    else m.flatFallback++
    if (r.cast.length) m.withCast++
    if (r.staff.length) m.withStaff++
    if (r.studios.length) m.withStudios++
    if (r.copyright) m.withCopyright++
    if (extractCredits(raw).length) m.withCredits++ // 新設計の統合カバレッジ（≥1名）
    m.unclassifiedParagraphs += r.unclassified.length
  }
  m.parsedRatePct = m.total ? Math.round((1000 * (m.structured - 0)) / m.total) / 10 : 0
  return m
}
