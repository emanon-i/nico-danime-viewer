import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractCredits } from '../../scripts/etl/credits.mjs'

// ゴールデン回帰コーパス（C26）: `extractCredits` は順序非可換な多段パイプライン＋実在文字列を
// 焼き込んだ denylist を持つため、「残 N 件のノイズ根治」を入れるたびに過去ケースが静かに回帰し
// 得た。このテストは実データ由来の凍結入力に対する現行出力を golden として固定し、credits.mjs の
// 変更が **どの実ケースの出力をどう変えるか** をコミット時点で可視化する。
//
// 失敗したときの対応:
//   - 意図した改善なら `node scripts/dev/credits-corpus.mjs --update` で golden を再生成し、
//     差分（どのシリーズのタグがどう変わったか）をレビューしてからコミットする。
//   - 意図しない回帰なら credits.mjs 側を直す。

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/credits-corpus.json'), 'utf8'))

// golden に固定する部分（scripts/dev/credits-corpus.mjs の pinned と一致させる）。
const pinned = (r) => ({ structured: r.structured, copyrightRaw: r.copyrightRaw, tags: r.tags })

describe('credits.mjs — ゴールデン回帰コーパス（実データ held-out）', () => {
  it('コーパスが空でない（fixture の取り違え・破損ガード）', () => {
    expect(Array.isArray(FIXTURE.cases)).toBe(true)
    expect(FIXTURE.cases.length).toBeGreaterThan(100)
    expect(FIXTURE.cases.length).toBe(FIXTURE.count)
  })

  it.each(FIXTURE.cases.map((c) => [`${c.seriesId} ${c.title}`, c]))(
    '現行出力が golden と一致: %s',
    (_label, c) => {
      expect(pinned(extractCredits(c.input))).toEqual(c.expected)
    }
  )
})
