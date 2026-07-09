import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { detectProjectContext } from '../src/config/projectContext.js'

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'ovogo-context-'))
}

describe('detectProjectContext', () => {
  it('reads package scripts only when scripts is an object', () => {
    const cwd = tmpProject()
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      scripts: {
        build: 'tsc',
        test: 'vitest run',
      },
    }), 'utf8')

    expect(detectProjectContext(cwd).scripts).toEqual({
      build: 'tsc',
      test: 'vitest run',
    })
  })

  it('ignores malformed package scripts', () => {
    const cwd = tmpProject()
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      scripts: 'npm test',
    }), 'utf8')

    expect(detectProjectContext(cwd).scripts).toBeUndefined()
  })

  it('uses packageManager field when no lockfile exists', () => {
    const cwd = tmpProject()
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      packageManager: 'bun@1.2.0',
    }), 'utf8')

    expect(detectProjectContext(cwd).packageManager).toBe('bun')
  })
})
