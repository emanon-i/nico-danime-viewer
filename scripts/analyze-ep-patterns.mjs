/**
 * analyze-ep-patterns.mjs
 * 全エピソードタイトルをパターン分類して網羅表を出力する
 * 実行: node scripts/analyze-ep-patterns.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../data')
const SERIES_DIR = path.join(DATA_DIR, 'series')

// ---------- パターン定義 ----------
// 各パターン: { id, label, re }
// re: エピソードタイトルに対してマッチするか判定。
//     マッチ成功 → groups[1] がシリーズ名候補（またはlabel専用処理）
const NUM_KAN = '[〇一二三四五六七八九十百千万拾参參壱弐零\\d]+'
const UNIT_ALL = '[話巻幕夜回章輪部]'

const PATTERNS = [
  // ---- U+3000 あり・話数トークン ----
  { id: 'P01', label: '第N話(算用)', re: /^(.+?)\u3000第\d+[話巻幕夜回章輪部]/ },
  { id: 'P02', label: '#N/#全角N', re: /^(.+?)\u3000[#＃]\d+/ },
  { id: 'P03', label: 'Episode/episode/EPISODE N', re: /^(.+?)\u3000episode\s*\d+/i },
  { id: 'P04', label: 'EP N / Ep.N', re: /^(.+?)\u3000[Ee][Pp][\s.]*\d+/ },
  { id: 'P05', label: '数字のみ(N[U+3000]or末尾)', re: /^(.+?)\u3000\d+(?:\u3000|$)/ },
  { id: 'P06', label: '第N話(漢数字)', re: new RegExp(`^(.+?)\u3000第${NUM_KAN}${UNIT_ALL}`) },
  { id: 'P07', label: '本編[U+3000 or 末尾]', re: /^(.+?)\u3000本編(?:\u3000|$)/ },
  // ---- U+3000 あり・話数トークン無し ----
  { id: 'P08', label: 'U+3000あり・話数なし・完全二重化(mid-sep)', re: null }, // 特別処理
  { id: 'P09', label: 'U+3000あり・話数なし・endsWith二重化', re: null }, // 特別処理
  { id: 'P10', label: 'U+3000あり・話数なし・その他（list.json照合等）', re: null }, // 残余
  // ---- U+3000 なし ----
  { id: 'P11', label: 'U+3000なし（1話完結・list.json確定）', re: null },
  // ---- まとめ動画 ----
  { id: 'P12', label: 'まとめ動画(第N話～第M話等)', re: /第\d+[話話](?:～|〜|~|-)第?\d+/ },
]

function classifyEpTitle(t) {
  if (!t) return 'P11' // 空は U+3000 なし扱い

  // まとめ動画: 範囲表記（U+3000 の有無問わず）
  if (/第\d+[話話](?:～|〜|~|-)第?\d+/.test(t)) return 'P12'
  if (/第\d+[話話](?:～|〜|~|-)(?:最終話|最終|END)/.test(t)) return 'P12'

  const hasU3 = t.includes('\u3000')

  if (!hasU3) return 'P11'

  // P01: 第N話(算用) ※最初に
  if (/^(.+?)\u3000第\d+[話巻幕夜回章輪部]/.test(t)) return 'P01'
  // P02: #N
  if (/^(.+?)\u3000[#＃]\d+/.test(t)) return 'P02'
  // P03: Episode/EPISODE N
  if (/^(.+?)\u3000episode\s*\d+/i.test(t)) return 'P03'
  // P04: EP N
  if (/^(.+?)\u3000[Ee][Pp][\s.]*\d+/.test(t)) return 'P04'
  // P05: 数字のみ
  if (/^(.+?)\u3000\d+(?:\u3000|$)/.test(t)) return 'P05'
  // P06: 第N話(漢数字)
  if (new RegExp(`^(.+?)\u3000第${NUM_KAN}${UNIT_ALL}`).test(t)) return 'P06'
  // P07: 本編
  if (/^(.+?)\u3000本編(?:\u3000|$)/.test(t)) return 'P07'

  // ---- 残余: 話数トークンなし ----
  // P08: 完全二重化（中点がU+3000または半角スペース）
  if (t.length % 2 === 1) {
    const mid = (t.length - 1) / 2
    const c = t[mid]
    if ((c === '\u3000' || c === ' ') && t.slice(0, mid) === t.slice(mid + 1)) return 'P08'
  }
  // P09: 最初のU+3000前テキストが末尾に繰り返す（A\u3000...\u3000A 型）
  const u3 = t.indexOf('\u3000')
  if (u3 >= 4) {
    const fp = t.slice(0, u3)
    if (t.endsWith(fp)) {
      const be = t[t.length - fp.length - 1]
      if (be === '\u3000' || be === ' ') return 'P09'
    }
  }
  // P10: U+3000あり・何も当たらない
  return 'P10'
}

// ---------- メイン ----------
async function main() {
  const files = await fs.readdir(SERIES_DIR)
  const jsonFiles = files.filter((f) => f.endsWith('.json'))

  // パターン別: { count, examples: [{seriesId, seriesTitle, epTitle}] }
  const buckets = {}
  for (const p of PATTERNS) {
    buckets[p.id] = { label: p.label, count: 0, examples: [] }
  }

  let totalEp = 0
  for (const file of jsonFiles) {
    const s = JSON.parse(await fs.readFile(path.join(SERIES_DIR, file), 'utf-8'))
    const eps = s.episodes || []
    for (const ep of eps) {
      totalEp++
      const pid = classifyEpTitle(ep.title)
      buckets[pid].count++
      if (buckets[pid].examples.length < 3) {
        buckets[pid].examples.push({
          seriesId: s.seriesId,
          seriesTitle: s.title,
          epTitle: ep.title,
        })
      }
    }
  }

  console.log(`\n=== エピソードタイトルパターン分類（全${totalEp}件）===\n`)
  console.log(`${'ID'.padEnd(5)} ${'件数'.padEnd(8)} ${'%'.padEnd(6)} パターン`)
  console.log('-'.repeat(80))
  for (const p of PATTERNS) {
    const b = buckets[p.id]
    const pct = ((b.count / totalEp) * 100).toFixed(2)
    console.log(`${p.id.padEnd(5)} ${String(b.count).padEnd(8)} ${pct.padEnd(6)} ${p.label}`)
  }

  // 詳細: 各パターンの実例
  console.log('\n=== 各パターン 実例（最大3件）===')
  for (const p of PATTERNS) {
    const b = buckets[p.id]
    if (b.count === 0) {
      console.log(`\n[${p.id}] ${p.label}: 0件 (スキップ)`)
      continue
    }
    console.log(`\n[${p.id}] ${p.label} (${b.count}件)`)
    for (const ex of b.examples) {
      console.log(`  series[${ex.seriesId}] "${ex.seriesTitle}"`)
      console.log(`    ep: "${ex.epTitle}"`)
    }
  }

  // P10 全件リスト（件数が多い場合は上位50件）
  console.log('\n=== P10 全件リスト（U+3000あり・話数なし・未分類）===')
  const p10all = []
  for (const file of jsonFiles) {
    const s = JSON.parse(await fs.readFile(path.join(SERIES_DIR, file), 'utf-8'))
    for (const ep of s.episodes || []) {
      if (classifyEpTitle(ep.title) === 'P10') {
        p10all.push({ seriesId: s.seriesId, seriesTitle: s.title, epTitle: ep.title })
      }
    }
  }
  console.log(`P10件数: ${p10all.length}`)
  p10all.slice(0, 100).forEach((x) => {
    console.log(`  [${x.seriesId}] "${x.seriesTitle}" ep: "${x.epTitle}"`)
  })

  // P11 サンプル
  console.log('\n=== P11 サンプル（U+3000なし 30件）===')
  const p11all = []
  for (const file of jsonFiles) {
    const s = JSON.parse(await fs.readFile(path.join(SERIES_DIR, file), 'utf-8'))
    for (const ep of s.episodes || []) {
      if (classifyEpTitle(ep.title) === 'P11') {
        p11all.push({ seriesId: s.seriesId, seriesTitle: s.title, epTitle: ep.title })
      }
    }
  }
  console.log(`P11件数: ${p11all.length}`)
  p11all.slice(0, 30).forEach((x) => {
    console.log(`  [${x.seriesId}] "${x.seriesTitle}" ep: "${x.epTitle}"`)
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
