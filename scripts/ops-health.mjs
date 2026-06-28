#!/usr/bin/env node
// ops-health.mjs — nico-danime-viewer 運用ヘルスチェック（読み取り専用）
//
// 「安定して動いているか」を一発で確認する。破壊的操作は一切しない。
//   実行: pnpm ops:health            （人間向けサマリ）
//         pnpm ops:health -- --json   （機械可読 JSON）
//         pnpm ops:health -- --quiet  （FAIL/WARN のみ表示）
//         pnpm ops:health -- --ci     （データ正しさ FAIL のみ exit1＝通知用）
//
// 監視対象は「ライブ（Pages）」「state ブランチ（毎時更新）」「GitHub Actions」に加え、
// 「structure（構造健全性）」「user-visible（U1〜U4 ＝ユーザー可視整合性）」の各ティア。
//
//   ・ローカル data/*.json は seed フォールバックであり古くて正常 → ここでは見ない。
//   ・各 record は ci フラグを持つ: ci=true＝データの正しさ（--ci で通知対象）、
//     ci=false＝鮮度/cron 稼働シグナル（やや遅い程度では通知しない）。
//
// 終了コード:
//   通常 → FAIL が1つでもあれば 1。
//   --ci → データ正しさ(ci=true)の FAIL のみ 1（鮮度 WARN/FAIL では落とさない）。
//   → scheduled workflow から `pnpm ops:health --ci` で失敗時のみ GitHub 標準通知が飛ぶ。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileP = promisify(execFile)

// ── 設定 ──────────────────────────────────────────────────────────
const OWNER = 'emanon-i'
const REPO = 'nico-danime-viewer'
const PAGES_BASE = `https://${OWNER}.github.io/${REPO}`

// 鮮度しきい値（分）。WARN を超えたら注意、FAIL を超えたら異常。
// hourly は GitHub の schedule イベントが低負荷リポジトリで間引かれ、実態は数時間おき。
// 90分/180分では平常運転でも誤検知するため warn 3h / fail 8h に緩和（実態整合・通知過多回避）。
const FRESH = {
  hourlyState: { warn: 3 * 60, fail: 8 * 60 }, // state 毎時更新（schedule 間引き考慮）
  hourlyRun: { warn: 3 * 60, fail: 8 * 60 }, // 直近 hourly run の経過時間
  dailyRun: { warn: 26 * 60, fail: 50 * 60 }, // daily は1日1回（26h で注意 / 50h で異常）
  liveData: { warn: 30 * 60, fail: 50 * 60 }, // Pages 配信 JSON の lastUpdated（daily 反映）
}

// ユーザー可視整合性ティアのしきい値（分）。これらは FAIL=データ実害 → --ci で通知対象。
const UV = {
  newLag: 24 * 60, // 新着反映ラグ: works.latestAt 最大 − new.json pubDate 最大
  ingestStall: 36 * 60, // 取り込みストール: now − works.latestAt 最大
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

// タイトル衛生: 制御文字（C0 制御文字と DEL）を検出。生バイトを避け明示エスケープで定義。
// eslint-disable-next-line no-control-regex
const CTRL_CHAR_RE = /[\u0000-\u001f\u007f]/

// ── 構造健全性 / ユーザー可視ティアで再利用するライブデータ（checkLive が一度だけ取得して共有）──
let liveWorks = null // works.json の data（{ works: [...] }）
let liveRanking = null // ranking.json の data（{ hot, popular, ... }）
let liveNew = null // new.json の data（{ items: [...] }）

// ── 出力ユーティリティ ────────────────────────────────────────────
// 各 record は ci フラグを持つ。ci=true ＝「データの正しさ」＝ --ci で exit1（通知）対象。
// ci=false ＝ 鮮度/cron 稼働など運用シグナル（やや遅い程度では通知しない）。
const args = new Set(process.argv.slice(2))
const asJson = args.has('--json')
const quiet = args.has('--quiet')
const ciMode = args.has('--ci')
const results = []
function record(group, level, label, detail, ci = true) {
  results.push({ group, level, label, detail, ci })
}
const pass = (g, l, d, ci = true) => record(g, 'PASS', l, d, ci)
const warn = (g, l, d, ci = true) => record(g, 'WARN', l, d, ci)
const fail = (g, l, d, ci = true) => record(g, 'FAIL', l, d, ci)

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
    warn(G, 'gh 利用不可', 'gh CLI 未認証 → Actions チェックをスキップ', false)
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
      // Actions は「cron が回っているか」の運用シグナル（ci=false: 鮮度で通知はしない）。
      if (!run) {
        fail(G, `${j.name} run`, '実行履歴が無い', false)
        continue
      }
      const age = minutesSince(run.createdAt)
      const ageGrade = gradeAge(age, j.thr)
      const detail = `直近 ${fmtAge(age)} / conclusion=${run.conclusion} / ${run.url}`
      if (run.status !== 'completed') {
        warn(G, `${j.name} run`, `実行中(status=${run.status}) ${detail}`, false)
      } else if (run.conclusion !== 'success') {
        fail(G, `${j.name} run`, `直近が失敗 ${detail}`, false)
      } else if (ageGrade === 'fail') {
        fail(G, `${j.name} run`, `成功だが古すぎる（cron 停止疑い） ${detail}`, false)
      } else if (ageGrade === 'warn') {
        warn(G, `${j.name} run`, `成功だがやや古い ${detail}`, false)
      } else {
        pass(G, `${j.name} run`, detail, false)
      }
    } catch (e) {
      warn(G, `${j.name} run`, `取得失敗: ${e.message}`, false)
    }
  }
}

// ── 2) state ブランチ鮮度（毎時更新の心拍）────────────────────────
async function checkStateBranch() {
  const G = 'state branch'
  if (!(await ensureGh())) {
    warn(G, 'gh 利用不可', 'gh CLI 未認証 → state 鮮度チェックをスキップ', false)
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
    // 鮮度シグナル（ci=false）。
    if (grade === 'fail') fail(G, '更新鮮度', `毎時更新が止まっている疑い ${detail}`, false)
    else if (grade === 'warn') warn(G, '更新鮮度', `やや遅延 ${detail}`, false)
    else pass(G, '更新鮮度', detail, false)
  } catch (e) {
    warn(G, '更新鮮度', `取得失敗: ${e.message}`, false)
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
    if (s.f === 'works.json') liveWorks = r.data // 構造/ユーザー可視ティアで再利用
    if (s.f === 'new.json') liveNew = r.data // U1 新着反映ラグで再利用
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
    liveRanking = d // 構造健全性ブロックで再利用
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

  // ライブ鮮度: 最も新しい lastUpdated で判定（鮮度シグナル ci=false）。
  const grade = gradeAge(freshestDaily, FRESH.liveData)
  const detail = `最新 lastUpdated ${fmtAge(freshestDaily)}`
  if (grade === 'fail') fail(G, '配信鮮度', `daily 反映が古すぎる ${detail}`, false)
  else if (grade === 'warn') warn(G, '配信鮮度', `やや古い ${detail}`, false)
  else pass(G, '配信鮮度', detail, false)
}

// ── 4) 構造健全性（live データの中身の整合性。回帰検出器）─────────
// checkLive が取得済みの works / ranking を再利用（追加 fetch なし）。
// 床は「実測で全項目グリーン」。違反が1件でも出たら退行とみなす。
function checkStructure() {
  const G = 'structure (整合性)'
  if (!liveWorks || !Array.isArray(liveWorks.works)) {
    warn(G, 'スキップ', 'works.json 未取得のため構造検査を実行できず')
    return
  }
  const works = liveWorks.works
  const n = works.length

  // (a) seriesId 重複（一意であるべき主キー）
  const seen = new Set()
  const dups = new Set()
  for (const w of works) {
    if (seen.has(w.seriesId)) dups.add(w.seriesId)
    seen.add(w.seriesId)
  }
  if (dups.size > 0)
    fail(G, 'seriesId 重複', `${dups.size} 件の重複キー（例: ${[...dups].slice(0, 3).join(', ')}）`)
  else pass(G, 'seriesId 重複', `重複なし（${n} 件すべて一意）`)

  // (b) ranking → works 参照整合（孤児＝works に存在しない seriesId）
  if (liveRanking) {
    const orphanHot = (liveRanking.hot || []).filter((x) => !seen.has(x.seriesId))
    const orphanPop = (liveRanking.popular || []).filter((x) => !seen.has(x.seriesId))
    const total = orphanHot.length + orphanPop.length
    if (total > 0)
      fail(
        G,
        'ranking 参照整合',
        `孤児 ${total} 件（hot ${orphanHot.length} / popular ${orphanPop.length}）`
      )
    else pass(G, 'ranking 参照整合', '孤児なし（hot/popular の全 seriesId が works に存在）')

    // (c) 順位の単調性（popular=totalViews 降順 / hot=hotScore 降順）
    const viol = (arr, key) => {
      let bad = 0
      for (let i = 1; i < arr.length; i++) if (arr[i][key] > arr[i - 1][key]) bad++
      return bad
    }
    const vPop = viol(liveRanking.popular || [], 'totalViews')
    const vHot = viol(liveRanking.hot || [], 'hotScore')
    if (vPop + vHot > 0) fail(G, '順位の単調性', `降順違反 popular ${vPop} / hot ${vHot}`)
    else pass(G, '順位の単調性', 'popular=totalViews 降順・hot=hotScore 降順とも違反なし')
  } else {
    warn(G, 'ranking 参照整合/単調性', 'ranking.json 未取得のためスキップ')
  }

  // (d) 値域チェック
  //   - totalViews: 全作品で数値かつ ≥0（負・非数は破損）
  const tvBad = works.filter((w) => !(typeof w.totalViews === 'number' && w.totalViews >= 0))
  if (tvBad.length > 0)
    fail(G, '値域 totalViews', `${tvBad.length} 件が負/非数（例: ${tvBad[0].seriesId}）`)
  else pass(G, '値域 totalViews', `全 ${n} 件が数値かつ ≥0`)

  //   - episodeCount / thumbnail: 配信中作品(isAvailable!==false)のみ対象。
  //     空シェル(isAvailable:false・各話/サムネ無し)は仕様上の正常状態なので除外。
  const avail = works.filter((w) => w.isAvailable !== false)
  const epBad = avail.filter((w) => !(typeof w.episodeCount === 'number' && w.episodeCount >= 1))
  if (epBad.length > 0)
    fail(
      G,
      '値域 episodeCount',
      `配信中で episodeCount<1 が ${epBad.length} 件（例: ${epBad[0].seriesId} ${epBad[0].title}）`
    )
  else pass(G, '値域 episodeCount', `配信中 ${avail.length} 件すべて episodeCount≥1`)

  const thBad = avail.filter(
    (w) => !(typeof w.thumbnailUrl === 'string' && /^https?:\/\//.test(w.thumbnailUrl))
  )
  if (thBad.length > 0)
    fail(
      G,
      '値域 サムネ URL',
      `配信中でサムネ非http(s)/欠落が ${thBad.length} 件（例: ${thBad[0].seriesId} ${thBad[0].title}）`
    )
  else pass(G, '値域 サムネ URL', `配信中 ${avail.length} 件すべて http(s) サムネ`)

  // (e) タイトル衛生（空・制御文字・前後空白＝いずれも破損シグナル。全作品対象）
  const tEmpty = works.filter(
    (w) => !(typeof w.title === 'string' && w.title.trim().length > 0)
  ).length
  const tCtrl = works.filter(
    (w) => typeof w.title === 'string' && CTRL_CHAR_RE.test(w.title)
  ).length
  const tWs = works.filter((w) => typeof w.title === 'string' && w.title !== w.title.trim()).length
  if (tEmpty + tCtrl + tWs > 0)
    fail(G, 'タイトル衛生', `空 ${tEmpty} / 制御文字 ${tCtrl} / 前後空白 ${tWs}`)
  else pass(G, 'タイトル衛生', '空・制御文字・前後空白なし')
}

// ── state ブランチの生ファイル取得（gh 非依存・公開 raw HTTP）──────
async function fetchState(statePath) {
  const url = `https://raw.githubusercontent.com/${OWNER}/${REPO}/state/${statePath}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 25000)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': `${REPO}-ops-health/1.0` },
    })
    if (!res.ok) return { ok: false, status: res.status }
    return { ok: true, data: await res.json() }
  } catch (e) {
    return { ok: false, status: 0, error: e.message }
  } finally {
    clearTimeout(timer)
  }
}

// ── 5) ユーザー可視整合性ティア（実害 = --ci で通知対象）─────────────
// U1 新着反映ラグ / U2 取り込みストール / U3 取りこぼし / U4 dangling。
async function checkUserVisible() {
  const G = 'user-visible (整合性)'
  if (!liveWorks || !Array.isArray(liveWorks.works)) {
    warn(G, 'スキップ', 'works.json 未取得のため検査不可', false)
    return
  }
  const works = liveWorks.works
  const maxIso = (arr, f) => {
    let mx = null
    for (const x of arr) {
      const t = Date.parse(f(x))
      if (!Number.isNaN(t) && (mx == null || t > mx)) mx = t
    }
    return mx
  }
  const worksLatest = maxIso(works, (w) => w.latestAt) // 本体データの最新エピソード時刻

  // U1: 新着反映ラグ（works.latestAt 最大 − new.json pubDate 最大）。
  if (liveNew && Array.isArray(liveNew.items) && worksLatest != null) {
    const newMax = maxIso(liveNew.items, (x) => x.pubDate)
    if (newMax == null) {
      warn(G, 'U1 新着反映ラグ', 'new.json に有効な pubDate なし')
    } else {
      const lagMin = (worksLatest - newMax) / 60000
      const detail = `works最新 − new最新 = ${(lagMin / 60).toFixed(1)}h`
      if (lagMin > UV.newLag)
        fail(G, 'U1 新着反映ラグ', `新着リストが本体に追随せず ${detail}（>${UV.newLag / 60}h）`)
      else pass(G, 'U1 新着反映ラグ', detail)
    }
  } else {
    warn(G, 'U1 新着反映ラグ', 'new.json/works 不足で判定不可')
  }

  // U2: 取り込みストール（now − works.latestAt 最大）。新規エピソードが長時間落ちてこない。
  if (worksLatest != null) {
    const ageMin = (Date.now() - worksLatest) / 60000
    const detail = `works.latestAt 最大 ${fmtAge(ageMin)}`
    if (ageMin > UV.ingestStall)
      fail(G, 'U2 取り込みストール', `新規エピソードが ${detail}（>${UV.ingestStall / 60}h）`)
    else pass(G, 'U2 取り込みストール', detail)
  }

  // U3/U4: state の series-index（contentId→seriesId）を実体集合プロキシに使う。
  const idx = await fetchState('state/series-index.json')
  if (!idx.ok || !idx.data || typeof idx.data !== 'object') {
    warn(G, 'U3/U4 参照整合', `series-index 取得不可（http=${idx.status ?? '?'}）→ スキップ`, false)
  } else {
    const idxVals = new Set(Object.values(idx.data).map((v) => String(v))) // ep を持つ seriesId 集合
    const worksIds = new Set(works.map((w) => String(w.seriesId)))

    // U3 取りこぼし（mode2）: series-index にあるのに works に無い series。
    const leaked = [...idxVals].filter((id) => !worksIds.has(id))
    if (leaked.length > 0)
      fail(
        G,
        'U3 取りこぼし',
        `series-index にあるが works に無い: ${leaked.length} 件（例 ${leaked.slice(0, 5).join(', ')}）`
      )
    else pass(G, 'U3 取りこぼし', `source(series-index) ⊆ works（取りこぼしなし）`)

    // U4 dangling（mode3）: 参照 seriesId が series 実体に無い。空シェル(配信中でない/0話)は除外。
    const refs = new Set()
    for (const w of works)
      if (w.isAvailable !== false && (w.episodeCount ?? 0) >= 1) refs.add(String(w.seriesId))
    for (const x of liveRanking?.hot ?? []) refs.add(String(x.seriesId))
    for (const x of liveRanking?.popular ?? []) refs.add(String(x.seriesId))
    const dangling = [...refs].filter((id) => !idxVals.has(id))
    if (dangling.length > 0)
      fail(
        G,
        'U4 dangling',
        `参照 seriesId が series 実体に無い: ${dangling.length} 件（例 ${dangling.slice(0, 5).join(', ')}）`
      )
    else pass(G, 'U4 dangling', `works/ranking の全 seriesId が series 実体に存在`)
  }
}

// ── 実行 ──────────────────────────────────────────────────────────
async function main() {
  await Promise.all([checkActions(), checkStateBranch(), checkLive()])
  checkStructure() // live データ取得後に同期実行（追加 fetch なし）
  await checkUserVisible() // liveWorks/liveRanking/liveNew + state series-index

  const counts = { PASS: 0, WARN: 0, FAIL: 0 }
  for (const r of results) counts[r.level]++
  const overall = counts.FAIL ? 'FAIL' : counts.WARN ? 'WARN' : 'PASS'
  // --ci: 「データ正しさ（ci=true）」の FAIL のみを exit1 対象にする（鮮度 WARN/FAIL では通知しない）。
  const ciFail = results.some((r) => r.level === 'FAIL' && r.ci)

  // 並列実行で完了順に積まれるため、表示はグループ順に整える。
  const GROUP_ORDER = [
    'Actions',
    'state branch',
    'live (Pages)',
    'structure (整合性)',
    'user-visible (整合性)',
  ]
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
      `\n総合: ${overall}  (PASS ${counts.PASS} / WARN ${counts.WARN} / FAIL ${counts.FAIL})` +
        (ciMode ? `  [--ci: データ正しさ FAIL=${ciFail ? 'あり→exit1' : 'なし→exit0'}]` : '')
    )
  }
  // 通常: FAIL が1つでも exit1。--ci: データ正しさ(ci=true)の FAIL のみ exit1（鮮度では通知しない）。
  process.exit((ciMode ? ciFail : counts.FAIL > 0) ? 1 : 0)
}

main().catch((e) => {
  console.error('ops-health 実行エラー:', e)
  process.exit(2)
})
