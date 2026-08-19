import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FileReadTool } from '../src/tools/fileRead.js'
import type { ToolContext } from '../src/core/types.js'

let cwd = ''
const tool = new FileReadTool()

function ctx(): ToolContext {
  return { cwd, permissionMode: 'auto' }
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ovogo-read-suggest-'))
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'sessionManager.ts'), 'export {}', 'utf8')
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('Read ENOENT did-you-mean', () => {
  it('suggests a close sibling for a typo', async () => {
    const result = await tool.execute({ file_path: join(cwd, 'src', 'sessionManagr.ts') }, ctx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Did you mean')
    expect(result.content).toContain('sessionManager.ts')
  })

  it('keeps the Glob hint when nothing is similar', async () => {
    const result = await tool.execute({ file_path: join(cwd, 'src', 'zzz-qxw-999.ts') }, ctx())
    expect(result.isError).toBe(true)
    expect(result.content).not.toContain('Did you mean')
    expect(result.content).toContain('Glob')
  })

  it('does not suggest when the parent directory does not exist', async () => {
    const result = await tool.execute({ file_path: join(cwd, 'no-such-dir', 'a.ts') }, ctx())
    expect(result.isError).toBe(true)
    expect(result.content).not.toContain('Did you mean')
  })
})
