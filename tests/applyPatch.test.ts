import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseApplyPatch, ApplyPatchTool } from '../src/tools/applyPatch.js'
import { FileHistory } from '../src/core/fileHistory.js'
import type { ToolContext } from '../src/core/types.js'

let cwd = ''
const tool = new ApplyPatchTool()

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd,
    permissionMode: 'auto',
    ...extra,
  }
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ovogo-apply-patch-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('parseApplyPatch', () => {
  it('parses add/update/delete ops', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: new.txt',
      '+hello',
      '*** Update File: old.txt',
      '@@',
      ' keep',
      '-remove me',
      '+add me',
      '*** Delete File: gone.txt',
      '*** End Patch',
    ].join('\n')
    const { ops } = parseApplyPatch(patch)
    expect(ops).toHaveLength(3)
    expect(ops[0]).toEqual({ type: 'add', path: 'new.txt', lines: ['hello'] })
    expect(ops[1].type).toBe('update')
    expect(ops[2]).toEqual({ type: 'delete', path: 'gone.txt' })
    const update = ops[1]
    if (update?.type === 'update') {
      expect(update.hunks).toHaveLength(1)
      expect(update.hunks[0].find).toEqual(['keep', 'remove me'])
      expect(update.hunks[0].replace).toEqual(['keep', 'add me'])
    }
  })

  it('rejects patches without terminator', () => {
    expect(() => parseApplyPatch('*** Begin Patch\n*** Delete File: x')).toThrow(/End Patch/)
  })

  it('rejects update ops without hunks', () => {
    expect(() => parseApplyPatch('*** Begin Patch\n*** Update File: x\n*** End Patch')).toThrow(/no @@ hunks/)
  })
})

describe('ApplyPatchTool.execute', () => {
  it('adds, updates, and deletes files in one patch', async () => {
    writeFileSync(join(cwd, 'old.txt'), 'keep\nremove me\ntail\n', 'utf8')
    writeFileSync(join(cwd, 'gone.txt'), 'bye\n', 'utf8')

    const patch = [
      '*** Begin Patch',
      '*** Add File: new.txt',
      '+hello',
      '+world',
      '*** Update File: old.txt',
      '@@',
      ' keep',
      '-remove me',
      '+add me',
      '*** Delete File: gone.txt',
      '*** End Patch',
    ].join('\n')

    const result = await tool.execute({ patch }, ctx())
    expect(result.isError).toBe(false)
    expect(readFileSync(join(cwd, 'new.txt'), 'utf8')).toBe('hello\nworld\n')
    expect(readFileSync(join(cwd, 'old.txt'), 'utf8')).toBe('keep\nadd me\ntail\n')
    expect(existsSync(join(cwd, 'gone.txt'))).toBe(false)
  })

  it('applies multiple hunks to one file sequentially', async () => {
    writeFileSync(join(cwd, 'f.txt'), 'a\nb\nc\nd\n', 'utf8')
    const patch = [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      '-a',
      '+A1',
      '@@',
      '-d',
      '+D1',
      '*** End Patch',
    ].join('\n')
    const result = await tool.execute({ patch }, ctx())
    expect(result.isError).toBe(false)
    expect(readFileSync(join(cwd, 'f.txt'), 'utf8')).toBe('A1\nb\nc\nD1\n')
  })

  it('errors when a hunk does not match', async () => {
    writeFileSync(join(cwd, 'f.txt'), 'a\nb\n', 'utf8')
    const patch = [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      '-not there',
      '+x',
      '*** End Patch',
    ].join('\n')
    const result = await tool.execute({ patch }, ctx())
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/does not match/)
    expect(readFileSync(join(cwd, 'f.txt'), 'utf8')).toBe('a\nb\n')
  })

  it('rejects Add over an existing file and Update of a missing file', async () => {
    writeFileSync(join(cwd, 'exists.txt'), 'x\n', 'utf8')
    const patch = [
      '*** Begin Patch',
      '*** Add File: exists.txt',
      '+nope',
      '*** Update File: missing.txt',
      '@@',
      '-a',
      '+b',
      '*** End Patch',
    ].join('\n')
    const result = await tool.execute({ patch }, ctx())
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/already exists/)
    expect(result.content).toMatch(/does not exist/)
  })

  it('tracks backups via fileHistory for undo', async () => {
    const sessionDir = join(cwd, 'session')
    mkdirSync(sessionDir, { recursive: true })
    const fh = new FileHistory(sessionDir)
    writeFileSync(join(cwd, 'f.txt'), 'one\n', 'utf8')
    const patch = [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      '-one',
      '+two',
      '*** End Patch',
    ].join('\n')
    const result = await tool.execute({ patch }, ctx({ fileHistory: fh, sessionDir }))
    expect(result.isError).toBe(false)
    expect(fh.undoEdit(join(cwd, 'f.txt'))).toBe(true)
    expect(readFileSync(join(cwd, 'f.txt'), 'utf8')).toBe('one\n')
  })

  it('claims write access on every touched path (raw + resolved)', () => {
    const patch = '*** Begin Patch\n*** Add File: a.txt\n+x\n*** Delete File: b.txt\n*** End Patch'
    const claims = tool.metadata?.claims?.({ patch }) ?? []
    const keys = claims.map((c) => c.key).sort()
    // Round 41: both spellings claimed — the resolved form serializes
    // against Edit/Write's absolute-path claims.
    expect(keys).toContain('a.txt')
    expect(keys).toContain('b.txt')
    expect(keys.some((k) => k.endsWith('/a.txt') && k !== 'a.txt')).toBe(true)
    expect(keys.some((k) => k.endsWith('/b.txt') && k !== 'b.txt')).toBe(true)
  })

  it('rejects malformed patch input with an actionable error', async () => {
    const result = await tool.execute({ patch: 'not a patch' }, ctx())
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/Begin Patch/)
  })
})
