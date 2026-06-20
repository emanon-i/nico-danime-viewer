#!/usr/bin/env node
// Fix-C: state/rss.json で誤って rss_only に分類された watchId を unresolved に戻す
//
// 背景: PH-0010〜0013 実装直後の hourly run（2026-06-20 14:26 UTC）で
//       GitHub Actions IP が niconico watch ページをソフトブロック。
//       contentId=null のレスポンスを「本物の非シリーズ」と誤判定し、
//       SANDA・転スラ4期 等の本物の新話 17件を rss_only に分類した。
//       Fix-B で bot block → unresolved 維持に修正済み。
//       本スクリプトはその 17件を unresolved にリセットし、次回 hourly で再試行させる。
//
// 実行:
//   node scripts/fix-c-reset-rss-status.mjs [path/to/rss.json]
//   デフォルトは data/state/rss.json

import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

// 2026-06-20 14:26 UTC の hourly で誤 rss_only 化された watchId 一覧
const MISCLASSIFIED_WATCH_IDS = new Set([
  '1780973763', // SANDA
  '1780973526', // SANDA
  '1780973344',
  '1780973765',
  '1780973644',
  '1780973646',
  '1780973824',
  '1780973528',
  '1780973884',
  '1780973524',
  '1780973767',
  '1780973769',
  '1781833803',
  '1781833863',
  '1781832251',
  '1781833263',
  '1781834703', // 転生したらスライムだった件 第4期
])

const rssPath = resolve(process.argv[2] ?? 'data/state/rss.json')

let data
try {
  data = JSON.parse(readFileSync(rssPath, 'utf-8'))
} catch (e) {
  console.error('rss.json が読めません:', rssPath, e.message)
  process.exit(1)
}

let resetCount = 0
let skipped = 0

for (const item of data.items ?? []) {
  if (MISCLASSIFIED_WATCH_IDS.has(item.watchId)) {
    if (item.resolutionStatus === 'rss_only') {
      console.log(`reset: ${item.watchId} rss_only → unresolved  (title: ${item.title ?? '?'})`)
      item.resolutionStatus = 'unresolved'
      item.resolvedContentId = null
      resetCount++
    } else {
      console.log(`skip:  ${item.watchId} status=${item.resolutionStatus} (変更不要)`)
      skipped++
    }
  }
}

if (resetCount === 0) {
  console.log('リセット対象なし（既に修正済みか、state が更新されている）')
  process.exit(0)
}

writeFileSync(rssPath, JSON.stringify(data, null, 2), 'utf-8')
console.log(`\n✅ ${resetCount} 件を unresolved にリセット（${skipped} 件は変更不要でスキップ）`)
console.log(`書き込み先: ${rssPath}`)
