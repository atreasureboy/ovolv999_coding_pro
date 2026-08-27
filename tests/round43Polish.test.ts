import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseWaitFromBody, rateLimitDelayMs } from '../src/utils/rateLimit.js'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Round 43 — polish details mined from codex/opencode: behaviors only
 * mass usage would surface. Each test pins a tolerance/UX contract.
 */

describe('rate-limit wait extraction (codex detail)', () => {
  it('parses "try again in 11.054s" bodies', () => {
    expect(parseWaitFromBody('Rate limit reached for gpt-x. Try again in 11.054s.')).toBe(11054)
    expect(parseWaitFromBody('please try again in 850ms')).toBe(850)
    expect(parseWaitFromBody('try again in 3 seconds')).toBe(3000)
    expect(parseWaitFromBody('no wait info here')).toBeNull()
  })

  it('prefers Retry-After header over body text', () => {
    const err = new Error('try again in 99s') as Error & { headers?: Record<string, string> }
    err.headers = { 'retry-after': '2' }
    expect(rateLimitDelayMs(err, 30_000)).toBe(2000)
  })

  it('falls back to default when nothing is found', () => {
    expect(rateLimitDelayMs(new Error('plain failure'), 7777)).toBe(7777)
    expect(rateLimitDelayMs(null, 1234)).toBe(1234)
  })
})

describe('Edit typographic tolerance (opencode/git-apply leniency)', async () => {
  const { FileEditTool } = await import('../src/tools/fileEdit.js')
  let cwd = ''
  const executeEdit = async (input: Record<string, unknown>): Promise<{ isError: boolean; content: string }> => {
    const result = await new FileEditTool().execute(input, { cwd, permissionMode: 'auto' } as never)
    return { isError: result.isError, content: result.content }
  }

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'ovogo-r43-edit-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('applies an ASCII old_string against curly quotes in the file', async () => {
    // File uses typographic quotes (e.g. prose in comments/docs).
    const file = join(cwd, 'prose.md')
    writeFileSync(file, 'She said \u201Chello world\u201D loudly.\n', 'utf8')
    // First "read" so the edit guard passes.
    const content = readFileSync(file, 'utf8')
    const { markFileRead } = await import('../src/core/fileState.js')
    markFileRead(file, content)

    const result = await executeEdit(
      { file_path: file, old_string: 'She said "hello world" loudly.', new_string: 'She whispered.' },
    )
    expect(result.isError).toBe(false)
    expect(result.content).toContain('typographic')
    expect(readFileSync(file, 'utf8')).toBe('She whispered.\n')
  })

  it('does NOT kick in when the plain match exists (exact wins)', async () => {
    const file = join(cwd, 'plain.ts')
    writeFileSync(file, 'const x = 1;\n', 'utf8')
    const { markFileRead } = await import('../src/core/fileState.js')
    markFileRead(file, 'const x = 1;\n')
    const result = await executeEdit(
      { file_path: file, old_string: 'const x = 1;', new_string: 'const x = 2;' },
    )
    expect(result.isError).toBe(false)
    expect(result.content).not.toContain('typographic')
  })
})

describe('apply_patch graded matching (codex seek_sequence)', async () => {
  const { ApplyPatchTool } = await import('../src/tools/applyPatch.js')
  let cwd = ''
  let sessionDir = ''
  const tool = new ApplyPatchTool()

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'ovogo-r43-patch-'))
    sessionDir = join(cwd, 'sess')
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('matches hunks with trimmed indentation differences', async () => {
    const f = join(cwd, 'ind.py')
    writeFileSync(f, 'def f():\n        return   deeply(indented())\n', 'utf8')
    const patch = [
      '*** Begin Patch',
      '*** Update File: ind.py',
      '@@',
      ' def f():',
      '-      return   deeply(indented())',
      '+      return 1',
      '*** End Patch',
    ].join('\n')
    const r = await tool.execute({ patch }, { cwd, permissionMode: 'auto', sessionDir } as never)
    expect(r.isError).toBe(false)
    expect(readFileSync(f, 'utf8')).toContain('return 1')
  })

  it('matches curly quotes in patch context vs straight quotes in pattern', async () => {
    const f = join(cwd, 'q.md')
    writeFileSync(f, '# Title\n\n\u201Cquoted line\u201D here\n\ntail\n', 'utf8')
    // Empty (unprefixed) middle line is context too — the three pattern
    // lines must be CONTIGUOUS just like the file's.
    const patch = [
      '*** Begin Patch',
      '*** Update File: q.md',
      '@@',
      '"quoted line" here',
      '',
      '-tail',
      '+TAIL',
      '*** End Patch',
    ].join('\n')
    const r = await tool.execute({ patch }, { cwd, permissionMode: 'auto', sessionDir } as never)
    expect(r.isError).toBe(false)
    expect(readFileSync(f, 'utf8')).toContain('\u201Cquoted line\u201D here')
    expect(readFileSync(f, 'utf8')).toContain('TAIL')
  })
})

describe('bash timeout exit-code 124 convention (codex/GNU timeout)', async () => {
  it('reports exit code 124 on internal timeout', async () => {
    const { BashTool } = await import('../src/tools/bash.js')
    const tool = new BashTool()
    const res = await tool.execute(
      { command: 'sleep 10', timeout: 500 },
      { cwd: process.cwd(), permissionMode: 'auto' } as never,
    )
    expect(res.isError).toBe(true)
    expect((res as unknown as { status?: string }).status ?? '').toBe('timed_out')
    expect(res.content).toContain('exit code 124')
  }, 15000)
})
