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
function isPlausibleCreditBlock(entries, maxAvg, maxVal) {
  if (!entries || entries.length === 0) return false
  let sum = 0
  for (const e of entries) {
    const v = e.value ?? ''
    const role = e.role ?? ''
    if (hasProsePeriod(v) || hasProsePeriod(role)) return false // 文＝プロ―ズ
    if (v.length > maxVal || role.length > 50) return false // 極端に長い＝プロ―ズ
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
    m.unclassifiedParagraphs += r.unclassified.length
  }
  m.parsedRatePct = m.total ? Math.round((1000 * (m.structured - 0)) / m.total) / 10 : 0
  return m
}
