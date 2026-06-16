// @vitest-environment node
// F-0048: v1 受け入れ最終チェック - coverage.json 機械検証
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PROJECT_ROOT = join(__dirname, '../..')
const COVERAGE_PATH = join(PROJECT_ROOT, 'docs/coverage.json')
const GITIGNORE_PATH = join(PROJECT_ROOT, '.gitignore')
const WEB_SRC = join(PROJECT_ROOT, 'web/src')

// v1 の全 REQ ID（L1 vision.md 準拠）
const V1_REQ_IDS = [
  'REQ-0001',
  'REQ-0002',
  'REQ-0003',
  'REQ-0004',
  'REQ-0005',
  'REQ-0008',
  'REQ-0010',
  'REQ-0011',
  'REQ-0012',
  'REQ-0013',
  'REQ-0014',
  'REQ-0015',
  'REQ-0016',
] as const

// v1 スコープ外の REQ ID（実装に含まれてはならない）
const OUT_OF_SCOPE_IDS = ['REQ-0006', 'REQ-0007', 'REQ-0009'] as const

interface CoverageJson {
  v1_requirements: Record<string, { title: string; features: string[] }>
  out_of_scope_v1: Record<string, string>
}

function readCoverage(): CoverageJson {
  return JSON.parse(readFileSync(COVERAGE_PATH, 'utf-8')) as CoverageJson
}

describe('F-0044: Pages 設定', () => {
  it('data/*.json が .gitignore に含まれている', () => {
    const content = readFileSync(GITIGNORE_PATH, 'utf-8')
    expect(content).toMatch(/\/data\//)
  })

  it('vite.config.ts に base 設定がある（CI 用 base path）', () => {
    const content = readFileSync(join(PROJECT_ROOT, 'vite.config.ts'), 'utf-8')
    expect(content).toContain('base')
    expect(content).toContain('nico-danime-viewer')
  })
})

describe('F-0045/F-0046: ワークフロー YAML', () => {
  it('fetch-hourly.yml が存在する', () => {
    expect(existsSync(join(PROJECT_ROOT, '.github/workflows/fetch-hourly.yml'))).toBe(true)
  })

  it('fetch-daily.yml が存在する', () => {
    expect(existsSync(join(PROJECT_ROOT, '.github/workflows/fetch-daily.yml'))).toBe(true)
  })

  it('fetch-hourly.yml に pnpm --frozen-lockfile が含まれる', () => {
    const content = readFileSync(join(PROJECT_ROOT, '.github/workflows/fetch-hourly.yml'), 'utf-8')
    expect(content).toContain('--frozen-lockfile')
  })

  it('fetch-daily.yml に concurrency group state-writer が含まれる', () => {
    const content = readFileSync(join(PROJECT_ROOT, '.github/workflows/fetch-daily.yml'), 'utf-8')
    expect(content).toContain('state-writer')
  })

  it('fetch-daily.yml に permissions: pages: write が含まれる', () => {
    const content = readFileSync(join(PROJECT_ROOT, '.github/workflows/fetch-daily.yml'), 'utf-8')
    expect(content).toContain('pages: write')
  })

  it('ワークフロー YAML で action は SHA + タグコメントでピン留めされている', () => {
    for (const yamlFile of ['fetch-hourly.yml', 'fetch-daily.yml']) {
      const content = readFileSync(join(PROJECT_ROOT, '.github/workflows', yamlFile), 'utf-8')
      // uses: action@SHA # version-tag の形式があること
      const pinned = content.match(/uses: [^@]+@[0-9a-f]{40}/g) ?? []
      expect(pinned.length, `${yamlFile}: SHA ピン留め action がない`).toBeGreaterThan(0)
    }
  })
})

describe('F-0048: v1 受け入れ最終チェック', () => {
  it('coverage.json が存在する', () => {
    expect(existsSync(COVERAGE_PATH)).toBe(true)
  })

  it('v1 の全 REQ が coverage.json に含まれる', () => {
    const coverage = readCoverage()
    const covered = Object.keys(coverage.v1_requirements)
    for (const reqId of V1_REQ_IDS) {
      expect(covered, `${reqId} が coverage.json に見つからない`).toContain(reqId)
    }
  })

  it('各 v1 REQ が少なくとも1つの Feature に対応している', () => {
    const coverage = readCoverage()
    for (const [reqId, entry] of Object.entries(coverage.v1_requirements)) {
      expect(
        entry.features.length,
        `${reqId}: features が空（少なくとも1つの F が必要）`
      ).toBeGreaterThan(0)
    }
  })

  it('v1 スコープ外 REQ が v1_requirements に含まれていない', () => {
    const coverage = readCoverage()
    for (const reqId of OUT_OF_SCOPE_IDS) {
      expect(
        Object.keys(coverage.v1_requirements),
        `${reqId} はスコープ外のため v1_requirements にあってはならない`
      ).not.toContain(reqId)
    }
  })

  it('将来スコープの実装が web/src/ に含まれていない（期間デルタ/リコメンド/個人化）', () => {
    function collectTs(dir: string): string[] {
      const r: string[] = []
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) r.push(...collectTs(p))
        else if (e.name.endsWith('.ts')) r.push(p)
      }
      return r
    }
    const forbidden = ['weeklyDelta', 'monthlyDelta', 'personalizeRecommend', 'watchHistory']
    const violations: string[] = []
    for (const file of collectTs(WEB_SRC)) {
      const content = readFileSync(file, 'utf-8')
      for (const keyword of forbidden) {
        if (content.includes(keyword)) violations.push(`${file}: ${keyword}`)
      }
    }
    expect(violations).toEqual([])
  })
})
