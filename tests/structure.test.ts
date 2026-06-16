import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()

describe('directory structure (L2 §2.3)', () => {
  beforeAll(() => {
    // data/ and data/state/ are git-ignored runtime dirs; create if missing
    const dataState = path.join(root, 'data', 'state')
    if (!existsSync(dataState)) {
      mkdirSync(dataState, { recursive: true })
    }
  })

  const dirs = [
    'scripts',
    'scripts/nico',
    'data',
    'data/state',
    'web/src/data',
    'web/src/features',
    'web/src/shared',
  ]

  for (const dir of dirs) {
    it(`${dir}/ exists`, () => {
      expect(existsSync(path.join(root, dir))).toBe(true)
    })
  }
})

describe('Node version pin (F-0001)', () => {
  it('.nvmrc exists and starts with 20', () => {
    const nvmrc = readFileSync(path.join(root, '.nvmrc'), 'utf-8').trim()
    expect(nvmrc).toMatch(/^20/)
  })

  it('package.json engines.node is >=20', async () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'))
    expect(pkg.engines?.node).toMatch(/>=20/)
  })
})
