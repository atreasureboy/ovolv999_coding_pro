import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionEngine } from '../../src/core/engine.js'
import { Renderer } from '../../src/ui/renderer.js'

const enabled = process.env.OVOGO_REAL_EVAL === '1'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!enabled)('real eval', () => {
  it('repairs and verifies a TypeScript defect with the native Responses transport', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovogo-real-eval-'))
    dirs.push(cwd)
    writeFileSync(join(cwd, 'math.ts'), 'export const multiply = (a: number, b: number): number => a + b\n')
    writeFileSync(join(cwd, 'math.test.ts'), "import { multiply } from './math.js'\nif (multiply(3, 4) !== 12) throw new Error('multiply is broken')\n")
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'tsx math.test.ts' }, devDependencies: { tsx: '^4.19.0' } }))

    const renderer = Renderer.forFile(join(cwd, 'eval.log'))
    const engine = new ExecutionEngine({
      model: process.env.OVOGO_REAL_EVAL_MODEL!,
      provider: 'openai',
      apiMode: 'responses',
      apiKey: process.env.OPENAI_API_KEY!,
      cwd,
      maxIterations: 8,
      permissionMode: 'auto',
      enabledModules: [],
    }, renderer)

    try {
      await engine.runTurn('Fix the multiply implementation so npm test passes. Inspect the files, make the smallest correct change, and run the test.', [])
    } finally {
      engine.dispose()
    }

    expect(readFileSync(join(cwd, 'math.ts'), 'utf8')).toMatch(/=>\s*a\s*\*\s*b/)
  }, 600_000)
})
