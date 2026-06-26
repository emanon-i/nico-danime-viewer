#!/usr/bin/env node
// ops-health.mjs — nico-danime-viewer 運用ヘルスチェック（読み取り専用）
//
// 「安定して動いているか」を一発で確認する。破壊的操作は一切しない。
//   実行: pnpm ops:health            （人間向けサマリ）
//         pnpm ops:health -- --json   （機械可読 JSON）
//         pnpm ops:health -- --quiet  （FAIL/WARN のみ表示）
//
// 監視対象は「ライブ（ユーザーが見る Pages）」「state ブランチ（データ正本・毎時更新）」
// 「GitHub Actions（daily full / hourly RSS）」の3系統。
//
//   ・ローカル data/*.json は seed フォールバックであり古くて正常 → ここでは見ない。
//   ・真の鮮度は state ブランチ（毎時）と Pages 配信 JSON（daily 反映）にある。
//
// 終了コード: FAIL が1つでもあれば 1、それ以外（PASS/WARN のみ）は 0。
//   → cron / CI から `node scripts/ops-health.mjs || notify` で使える。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileP = promisify(execFile)

// ── 設定 ──────────────────────────────────────────────────────────
const OWNER = 'emanon-i'
const REPO = 'nico-danime-viewer'
const PAGES_BASE = `https://${OWNER}.github.io/${REPO}`

// 鮮度しきい値（分）。WARN を超えたら注意、FAIL を超えたら異常。
const FRESH = {
  hourlyState: { warn: 90, fail: 180 }, // state は毎時更新（60分 + ジッタ余裕）
  hourlyRun: { warn: 90, fail: 180 }, // 直近 hourly run の経過時間
  dailyRun: { warn: 26 * 60, fail: 50 * 60 }, // daily は1日1回（26h で注意 / 50h で異常）
  liveData: { warn: 30 * 60, fail: 50 * 60 }, // Pages 配信 JSON の lastUpdated（daily 反映）
}

// 件数の下限（空 seed 事故・取得崩壊の検出。現状比でかなり余裕を持たせた床）。
const FLOORS = {
  works: 5000, // 実測 6601
  rankingHot: 100, // 実測 200
  rankingPopular: 100, // 実測 200
  tags: 20000, // 実測 42753
  cours: 150, // 実測 202
  kana: 10, // 実測 10（五十音の行グループ＝固定）
  newItems: 1, // 実測 100（新着は0でも事故ではないが、空配列は異常）
}

// ── 出力ユーティリティ ────────────────────────────────────────────
const args = new Set(process.argv.slice(2))
const asJson = args.has('--json')
const quiet = args.has('--quiet')
const results = []
function record(group, level, label, detail) {
  results.push({ group, level, label, detail })
}
const pass = (g, l, d) => record(g, 'PASS', l, d)
const warn = (g, l, d) => record(g, 'WARN', l, d)
const fail = (g, l, d) => record(g, 'FAIL', l, d)

function minutesSince(iso) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return (Date.now() - t) / 60000
}
function fmtAge(min) {
  if (min == null) return '?'
  if (min < 90) return `${Math.round(min)}分前`
  return `${(min / 60).toFixed(1)}時間前`
}
function gradeAge(min, thr) {
  if (min == null) return 'fail'
  if (min > thr.fail) return 'fail'
  if (min > thr.warn) return 'warn'
  return 'pass'
}

// ── gh ヘルパ（無ければ該当チェックを WARN でスキップ）────────────
let ghOk = null
async function gh(argList) {
  const { stdout } = await execFileP('gh', argList, { maxBuffer: 8 * 1024 * 1024 })
  return stdout
}
async function ensureGh() {
  if (ghOk !== null) return ghOk
  try {
    await gh(['auth', 'status'])
    ghOk = true
  } catch {
    ghOk = false
  }
  return ghOk
}

// ── 1) GitHub Actions: daily full / hourly RSS の直近 run ──────────
async function checkActions() {
  const G = 'Actions'
  if (!(await ensureGh())) {
    warn(G, 'gh 利用不可', 'gh CLI 未認証 → Actions チェックをスキップ')
    return
  }
  const jobs = [
    { wf: 'fetch-daily.yml', name: 'daily full', thr: FRESH.dailyRun },
    { wf: 'fetch-hourly.yml', name: 'hourly RSS', thr: FRESH.hourlyRun },
  ]
  for (const j of jobs) {
    try {
      const out = await gh([
        'run',
        'list',
        '--workflow',
        j.wf,
        '-L',
        '1',
        '--json',
        'conclusion,status,createdAt,url,displayTitle',
      ])
      const [run] = JSON.parse(out)
      if (!run) {
        fail(G, `${j.name} run`, '実行履歴が無い')
        continue
      }
      const age = minutesSince(run.createdAt)
      const ageGrade = gradeAge(age, j.thr)
      const detail = `直近 ${fmtAge(age)} / conclusion=${run.conclusion} / ${run.url}`
      if (run.status !== 'completed') {
        warn(G, `${j.name} run`, `実行中(status=${run.status}) ${detail}`)
      } else if (run.conclusion !== 'success') {
        fail(G, `${j.name} run`, `直近が失敗 ${detail}`)
      } else if (ageGrade === 'fail') {
        fail(G, `${j.name} run`, `成功だが古すぎる（cron 停止疑い） ${detail}`)
      } else if (ageGrade === 'warn') {
        warn(G, `${j.name} run`, `成功だがやや古い ${detail}`)
      } else {
        pass(G, `${j.name} run`, detail)
      }
    } catch (e) {
      warn(G, `${j.name} run`, `取得失敗: ${e.message}`)
    }
  }
}

// ── 2) state ブランチ鮮度（毎時更新の心拍）────────────────────────
async function checkStateBranch() {
  const G = 'state branch'
  if (!(await ensureGh())) {
    warn(G, 'gh 利用不可', 'gh CLI 未認証 → state 鮮度チェックをスキップ')
    return
  }
  try {
    const out = await gh([
      'api',
      `repos/${OWNER}/${REPO}/branches/state`,
      '--jq',
      '.commit.commit.committer.date + "\\t" + .commit.commit.message',
    ])
    const [date, ...msg] = out.trim().split('\t')
    const age = minutesSince(date)
    const grade = gradeAge(age, FRESH.hourlyState)
    const detail = `最新コミット ${fmtAge(age)}（${(msg.join('\t') || '').split('\n')[0]}）`
    if (grade === 'fail') fail(G, '更新鮮度', `毎時更新が止まっている疑い ${detail}`)
    else if (grade === 'warn') warn(G, '更新鮮度', `やや遅延 ${detail}`)
    else pass(G, '更新鮮度', detail)
  } catch (e) {
    warn(G, '更新鮮度', `取得失敗: ${e.message}`)
  }
}

// ── 3) ライブ Pages: 到達性・鮮度・件数・hotScore ─────────────────
async function fetchJson(path) {
  const url = `${PAGES_BASE}/${path}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 25000)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': `${REPO}-ops-health/1.0` },
    })
    if (!res.ok) return { ok: false, status: res.status, url }
    return { ok: true, status: res.status, url, data: await res.json() }
  } catch (e) {
    return { ok: false, status: 0, url, error: e.message }
  } finally {
    clearTimeout(timer)
  }
}

async function checkLive() {
  const G = 'live (Pages)'
  // 各 JSON の (件数アクセサ, 下限)。lastUpdated は全ファイル共通。
  const specs = [
    { f: 'works.json', count: (d) => d.works?.length, floor: FLOORS.works, key: 'works' },
    { f: 'tags.json', count: (d) => d.tags?.length, floor: FLOORS.tags, key: 'tags' },
    { f: 'cours.json', count: (d) => d.cours?.length, floor: FLOORS.cours, key: 'cours' },
    {
      f: 'kana.json',
      count: (d) => (Array.isArray(d.kana) ? d.kana.length : Object.keys(d.kana || {}).length),
      floor: FLOORS.kana,
      key: 'kana',
    },
    { f: 'new.json', count: (d) => d.items?.length, floor: FLOORS.newItems, key: 'new items' },
  ]

  // 個別データファイル
  let freshestDaily = null
  for (const s of specs) {
    const r = await fetchJson(`data/${s.f}`)
    if (!r.ok) {
      fail(G, s.f, `配信不可（http=${r.status}${r.error ? ' ' + r.error : ''}）`)
      continue
    }
    const n = s.count(r.data) ?? 0
    const lu = r.data.lastUpdated
    const age = minutesSince(lu)
    if (age != null && (freshestDaily == null || age < freshestDaily)) freshestDaily = age
    if (n < s.floor) {
      fail(G, `${s.f} 件数`, `${s.key}=${n} < 下限 ${s.floor}（空 seed / 取得崩壊の疑い）`)
    } else {
      pass(G, `${s.f} 件数`, `${s.key}=${n}`)
    }
  }

  // ranking.json は件数 + hotScore 健全性（daily の hotScore 再計算が効いている証拠）
  const rr = await fetchJson('data/ranking.json')
  if (!rr.ok) {
    fail(G, 'ranking.json', `配信不可（http=${rr.status}${rr.error ? ' ' + rr.error : ''}）`)
  } else {
    const d = rr.data
    const hot = d.hot?.length ?? 0
    const pop = d.popular?.length ?? 0
    if (hot < FLOORS.rankingHot) fail(G, 'ranking hot 件数', `hot=${hot} < ${FLOORS.rankingHot}`)
    else pass(G, 'ranking hot 件数', `hot=${hot}`)
    if (pop < FLOORS.rankingPopular)
      fail(G, 'ranking popular 件数', `popular=${pop} < ${FLOORS.rankingPopular}`)
    else pass(G, 'ranking popular 件数', `popular=${pop}`)

    // hotScore: 全ゼロ＝再計算が死んでいる／seed のまま固着の疑い
    const scores = (d.hot || []).map((x) => x.hotScore).filter((v) => typeof v === 'number')
    const nonzero = scores.filter((v) => v > 0).length
    if (scores.length === 0) fail(G, 'hotScore', 'hotScore フィールドが無い')
    else if (nonzero === 0) fail(G, 'hotScore', '全件 0（daily 再計算が機能していない疑い）')
    else
      pass(G, 'hotScore', `非ゼロ ${nonzero}/${scores.length}・top=${d.hot[0].hotScore.toFixed(3)}`)

    const age = minutesSince(d.lastUpdated)
    if (age != null && (freshestDaily == null || age < freshestDaily)) freshestDaily = age
  }

  // ライブ鮮度: 最も新しい lastUpdated で判定（daily フル or 新着 hourly デプロイの反映）
  const grade = gradeAge(freshestDaily, FRESH.liveData)
  const detail = `最新 lastUpdated ${fmtAge(freshestDaily)}`
  if (grade === 'fail') fail(G, '配信鮮度', `daily 反映が古すぎる ${detail}`)
  else if (grade === 'warn') warn(G, '配信鮮度', `やや古い ${detail}`)
  else pass(G, '配信鮮度', detail)
}

// ── 実行 ──────────────────────────────────────────────────────────
async function main() {
  await Promise.all([checkActions(), checkStateBranch(), checkLive()])

  const counts = { PASS: 0, WARN: 0, FAIL: 0 }
  for (const r of results) counts[r.level]++
  const overall = counts.FAIL ? 'FAIL' : counts.WARN ? 'WARN' : 'PASS'

  // 並列実行で完了順に積まれるため、表示はグループ順に整える。
  const GROUP_ORDER = ['Actions', 'state branch', 'live (Pages)']
  results.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))

  if (asJson) {
    console.log(
      JSON.stringify({ overall, counts, results, checkedAt: new Date().toISOString() }, null, 2)
    )
  } else {
    const icon = { PASS: '✓', WARN: '!', FAIL: '✗' }
    let lastGroup = ''
    for (const r of results) {
      if (quiet && r.level === 'PASS') continue
      if (r.group !== lastGroup) {
        console.log(`\n■ ${r.group}`)
        lastGroup = r.group
      }
      console.log(`  ${icon[r.level]} [${r.level}] ${r.label} — ${r.detail}`)
    }
    console.log(
      `\n総合: ${overall}  (PASS ${counts.PASS} / WARN ${counts.WARN} / FAIL ${counts.FAIL})`
    )
  }
  process.exit(counts.FAIL ? 1 : 0)
}

main().catch((e) => {
  console.error('ops-health 実行エラー:', e)
  process.exit(2)
})
