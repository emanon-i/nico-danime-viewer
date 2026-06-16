import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PROJECT_ROOT = join(__dirname, '../..')
const WEB_SRC = join(PROJECT_ROOT, 'web/src')
const WEB_INDEX = join(PROJECT_ROOT, 'web/index.html')
const DIST_INDEX = join(PROJECT_ROOT, 'dist/index.html')

function collectTsFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(fullPath))
    } else if (entry.name.endsWith('.ts')) {
      results.push(fullPath)
    }
  }
  return results
}

describe('F-0040: 静的解析 - innerHTML', () => {
  it('test_no_raw_innerHTML: 外部データが innerHTML に直接渡されていない', () => {
    const files = collectTsFiles(WEB_SRC)
    const violations: string[] = []

    for (const file of files) {
      const content = readFileSync(file, 'utf-8')

      // innerHTML = `...${var}...` パターン（テンプレート補間あり → 外部データ混入の可能性）
      // 制限: バッククォートより前に別のバッククォートがある複雑な式は未検出
      if (/\.innerHTML\s*=\s*`[^`]*\$\{/s.test(content)) {
        violations.push(
          `${relative(PROJECT_ROOT, file)}: innerHTML にテンプレート補間が含まれている`
        )
      }

      // innerHTML = someVar パターン（クォート/テンプレートでない直接代入）
      // 制限: 'str' + var のような文字列結合は先頭が引用符のため検出されない。
      //       現コードに該当パターンが存在しないことを定期的に確認すること。
      if (/\.innerHTML\s*=\s*(?!\s*['"`])/.test(content)) {
        violations.push(`${relative(PROJECT_ROOT, file)}: innerHTML に変数が直接代入されている`)
      }
    }

    expect(violations).toEqual([])
  })
})

describe('F-0042: CSP', () => {
  it('test_csp_meta_present: index.html に Content-Security-Policy meta が含まれる', () => {
    const indexPath = existsSync(DIST_INDEX) ? DIST_INDEX : WEB_INDEX
    const content = readFileSync(indexPath, 'utf-8')
    expect(content.toLowerCase()).toContain('content-security-policy')
  })

  it('test_no_inline_script: index.html にインライン script が存在しない', () => {
    const content = readFileSync(WEB_INDEX, 'utf-8')
    // <script src="..."> は OK、インラインコードは NG
    const inlineScriptRe = /<script(?![^>]*\bsrc\b)[^>]*>[^<\s][^<]*<\/script>/i
    expect(inlineScriptRe.test(content)).toBe(false)
  })

  it('test_csp_img_src: CSP に img-src と nimg.jp が含まれる', () => {
    const indexPath = existsSync(DIST_INDEX) ? DIST_INDEX : WEB_INDEX
    const content = readFileSync(indexPath, 'utf-8')
    expect(content).toContain('img-src')
    expect(content).toContain('nimg.jp')
  })
})

describe('F-0043: 通信範囲・サプライチェーン', () => {
  it('test_browser_only_self_and_cdn: web/src/ から外部 URL への直接 fetch がない', () => {
    const files = collectTsFiles(WEB_SRC)
    const violations: string[] = []

    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      const lines = content.split('\n')
      lines.forEach((line, i) => {
        // fetch( の引数が https:// または http:// 始まりの URL リテラル
        if (/fetch\s*\(\s*['"`]https?:\/\//.test(line)) {
          violations.push(`${relative(PROJECT_ROOT, file)}:${i + 1}: ${line.trim()}`)
        }
      })
    }

    expect(violations).toEqual([])
  })

  it('test_no_intermediate_in_dist: dist/ に SQLite/DB ファイルが含まれない', () => {
    const distDir = join(PROJECT_ROOT, 'dist')
    if (!existsSync(distDir)) {
      // dist/ がまだ生成されていない場合はスキップ
      return
    }

    const dbFiles: string[] = []
    function findDbFiles(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          findDbFiles(fullPath)
        } else if (/\.(db|sqlite|sqlite3)$/i.test(entry.name)) {
          dbFiles.push(relative(distDir, fullPath))
        }
      }
    }
    findDbFiles(distDir)

    expect(dbFiles).toEqual([])
  })
})
