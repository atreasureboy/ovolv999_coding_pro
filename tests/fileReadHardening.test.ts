import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FileReadTool } from '../src/tools/fileRead.js'
import type { ToolContext } from '../src/core/types.js'

/**
 * Round 37 (opencode read hardening): binary files are rejected BEFORE
 * their content is lifted into memory, and overlong lines are truncated
 * with a marker instead of flooding the context window.
 */

let cwd = ''
const tool = new FileReadTool()

function ctx(): ToolContext {
  return { cwd, permissionMode: 'auto' }
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ovogo-read-harden-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('Read binary rejection', () => {
  it('rejects known binary extensions without reading content', async () => {
    const p = join(cwd, 'image.png')
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const result = await tool.execute({ file_path: p }, ctx())
    expect(result.content).toContain('Binary file')
  })

  it('rejects unknown-extension files with NUL bytes via the sniff', async () => {
    const p = join(cwd, 'data.xyz')
    writeFileSync(p, Buffer.concat([Buffer.from('header'), Buffer.from([0x00, 0x01, 0xff])]))
    const result = await tool.execute({ file_path: p }, ctx())
    expect(result.content).toContain('Binary file')
  })

  it('still reads normal text files', async () => {
    const p = join(cwd, 'a.txt')
    writeFileSync(p, 'hello\nworld\n')
    const result = await tool.execute({ file_path: p }, ctx())
    expect(result.content).toContain('hello')
    expect(result.content).toContain('world')
  })
})

describe('Read long-line truncation', () => {
  it('truncates lines beyond 2000 chars with a marker', async () => {
    const p = join(cwd, 'minified.js')
    const longLine = 'x'.repeat(10_000)
    writeFileSync(p, `short\n${longLine}\nafter\n`)
    const result = await tool.execute({ file_path: p }, ctx())
    expect(result.content).toContain('[line truncated')
    expect(result.content).toContain('10,000 chars total')
    // The truncated line must NOT appear in full.
    expect(result.content).not.toContain(longLine)
    // Neighbouring lines stay intact.
    expect(result.content).toContain('short')
    expect(result.content).toContain('after')
  })

  it('leaves ordinary lines untouched', async () => {
    const p = join(cwd, 'normal.ts')
    writeFileSync(p, 'const a = 1\n'.repeat(5))
    const result = await tool.execute({ file_path: p }, ctx())
    expect(result.content).not.toContain('[line truncated')
  })
})
