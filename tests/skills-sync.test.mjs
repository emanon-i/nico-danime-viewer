// tests/skills-sync.test.mjs
// .claude/skills と .agents/skills は「同一内容の複製」運用のため、機械的に同一性を保証する。

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CLAUDE_DIR = join(process.cwd(), '.claude/skills/nico-snapshot-api')
const AGENTS_DIR = join(process.cwd(), '.agents/skills/nico-snapshot-api')

function listFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .filter((rel) => statSync(join(dir, rel)).isFile())
    .sort()
}

describe('skills 複製: .claude/skills と .agents/skills は同一内容', () => {
  it('相対パス集合が一致する', () => {
    expect(listFiles(AGENTS_DIR)).toEqual(listFiles(CLAUDE_DIR))
  })

  it('各ファイルの内容（バイト列）が一致する', () => {
    for (const rel of listFiles(CLAUDE_DIR)) {
      const claudeContent = readFileSync(join(CLAUDE_DIR, rel))
      const agentsContent = readFileSync(join(AGENTS_DIR, rel))
      expect(agentsContent.equals(claudeContent)).toBe(true)
    }
  })
})
