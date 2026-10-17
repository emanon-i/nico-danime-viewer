// credits 抽出のゴールデン回帰コーパス生成／更新ツール。
//
// 背景（C26）: `scripts/etl/credits.mjs` の `extractCredits` は順序非可換な多段
// 文字列パイプラインで、実在文字列を焼き込んだ denylist / 魔法定数を持つ。これまで
// held-out な回帰コーパスが無かったため、「残 N 件のノイズ根治」を入れるたびに過去
// ケースが静かに回帰し得た（works.json を 7 回も再生成している履歴がその証跡）。
//
// このツールは実データ（`data/works.json` の `descriptionFirst`）から多様性重視の
// 層化サンプルを 1 度だけ抽出して **入力を凍結** し、現行の抽出結果を golden として
// 固定する。以降 credits.mjs を変更したら `--update` で expected だけ再生成すれば、
// git diff に「どの実ケースの出力がどう変わったか」が最小差分で現れる。
//
// 使い方:
//   node scripts/dev/credits-corpus.mjs --seed    # data/works.json から新規抽出（入力も再選定）
//   node scripts/dev/credits-corpus.mjs --update   # 既存 fixture の入力を据え置き expected だけ再計算（既定）
//
// 入力の選定は決定的（seriesId 昇順 + 等間隔）。`--seed` は works.json の内容が変われば
// 選定も変わるため、通常の運用（credits.mjs 変更後）は入力を据え置く `--update` を使う。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractCredits } from '../etl/credits.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../..')
const FIXTURE_PATH = resolve(REPO_ROOT, 'tests/etl/fixtures/credits-corpus.json')
const WORKS_PATH = resolve(REPO_ROOT, 'data/works.json')

// バケット（出力タグ数）ごとの採択件数。edge（0・1-3 件）を厚めに取り、
// ノイズ混入／取りこぼしが起きやすい領域を回帰ネットで優先的に覆う。
const BUCKET_QUOTA = { 0: 30, '1-3': 30, '4-7': 25, '8-15': 30, '16+': 35 }
const TOP_BY_COUNT = 5 // 16+ バケットは最大キャスト（ノイズ高リスク）を強制採択

/** @param {number} n */
function bucketOf(n) {
  if (n === 0) return '0'
  if (n <= 3) return '1-3'
  if (n <= 7) return '4-7'
  if (n <= 15) return '8-15'
  return '16+'
}

/** extractCredits の返り値から golden に固定する部分だけ取り出す（synopsis は入力から導出可能なので省く）。 */
function pinned(result) {
  return { structured: result.structured, copyrightRaw: result.copyrightRaw, tags: result.tags }
}

/** 配列から count 件を等間隔で決定的に選ぶ（端含む・重複除去）。 */
function evenlySpaced(arr, count) {
  if (arr.length <= count) return arr.slice()
  const picked = []
  const seen = new Set()
  for (let i = 0; i < count; i++) {
    const idx = Math.round((i * (arr.length - 1)) / (count - 1))
    if (!seen.has(idx)) {
      seen.add(idx)
      picked.push(arr[idx])
    }
  }
  return picked
}

function seed() {
  const { works } = JSON.parse(readFileSync(WORKS_PATH, 'utf8'))
  const byBucket = new Map()
  for (const w of works) {
    const input = w.descriptionFirst
    if (!input) continue
    const result = extractCredits(input)
    const entry = { seriesId: w.seriesId, title: w.title, input, _n: result.tags.length }
    const b = bucketOf(result.tags.length)
    if (!byBucket.has(b)) byBucket.set(b, [])
    byBucket.get(b).push(entry)
  }

  const selected = []
  for (const [bucket, quota] of Object.entries(BUCKET_QUOTA)) {
    const pool = (byBucket.get(bucket) ?? []).slice().sort((a, b) => a.seriesId - b.seriesId)
    if (bucket === '16+') {
      const top = pool
        .slice()
        .sort((a, b) => b._n - a._n)
        .slice(0, TOP_BY_COUNT)
      const topIds = new Set(top.map((e) => e.seriesId))
      const rest = pool.filter((e) => !topIds.has(e.seriesId))
      selected.push(...top, ...evenlySpaced(rest, Math.max(0, quota - top.length)))
    } else {
      selected.push(...evenlySpaced(pool, quota))
    }
  }

  const cases = selected
    .sort((a, b) => a.seriesId - b.seriesId)
    .map((e) => ({
      seriesId: e.seriesId,
      title: e.title,
      input: e.input,
      expected: pinned(extractCredits(e.input)),
    }))
  write(cases)
  console.log(`[seed] data/works.json から ${cases.length} 件を凍結しました → ${rel(FIXTURE_PATH)}`)
}

function update() {
  const doc = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
  let changed = 0
  for (const c of doc.cases) {
    const next = pinned(extractCredits(c.input))
    if (JSON.stringify(next) !== JSON.stringify(c.expected)) changed++
    c.expected = next
  }
  write(doc.cases)
  console.log(
    `[update] ${doc.cases.length} 件の expected を再計算（${changed} 件が変化）→ ${rel(FIXTURE_PATH)}`
  )
}

function write(cases) {
  mkdirSync(dirname(FIXTURE_PATH), { recursive: true })
  const doc = {
    note:
      'credits 抽出のゴールデン回帰コーパス。input は凍結・実データ（data/works.json の ' +
      'descriptionFirst）由来。credits.mjs を変更したら `node scripts/dev/credits-corpus.mjs ' +
      '--update` で expected を再生成し、差分を確認すること。新規採択は `--seed`。',
    generatedBy: 'scripts/dev/credits-corpus.mjs',
    count: cases.length,
    cases,
  }
  writeFileSync(FIXTURE_PATH, JSON.stringify(doc, null, 2) + '\n')
}

function rel(p) {
  return p.replace(REPO_ROOT + '/', '')
}

const mode = process.argv.includes('--seed') ? 'seed' : 'update'
if (mode === 'seed') seed()
else update()
