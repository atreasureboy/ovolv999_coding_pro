import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeLoopWorkspace } from '../src/core/loopScaffold.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('loop workspace scaffold', () => {
  it('detects package verification scripts and creates the complete contract', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovolv-loop-scaffold-'))
    roots.push(cwd)
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      scripts: { typecheck: 'tsc --noEmit', test: 'vitest run', build: 'tsc' },
    }))

    const result = initializeLoopWorkspace(cwd, 'Ship the migration safely')
    const acceptance = readFileSync(join(cwd, '.loop', 'ACCEPTANCE.md'), 'utf8')

    expect(result.acceptanceCount).toBe(3)
    expect(acceptance).toContain('`npm run typecheck`')
    expect(acceptance).toContain('`npm run test`')
    expect(readFileSync(join(cwd, '.loop', 'GOAL.md'), 'utf8')).toContain('Ship the migration safely')
    expect(readFileSync(join(cwd, '.loop', 'skills', 'COMMANDS.md'), 'utf8')).toContain('npm run build')
  })

  it('preserves contracts that already exist', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovolv-loop-preserve-'))
    roots.push(cwd)
    initializeLoopWorkspace(cwd, 'Original goal')
    writeFileSync(join(cwd, '.loop', 'GOAL.md'), '# Goal\n\nCustom goal\n')

    const result = initializeLoopWorkspace(cwd, 'Replacement goal')

    expect(result.preserved.some(path => path.endsWith('GOAL.md'))).toBe(true)
    expect(readFileSync(join(cwd, '.loop', 'GOAL.md'), 'utf8')).toContain('Custom goal')
  })
})
