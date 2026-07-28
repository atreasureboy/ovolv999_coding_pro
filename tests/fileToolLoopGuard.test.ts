/**
 * ADR-007 (DONE.flag integrity): Write/Edit tool-layer enforcement.
 *
 * The loop supervisor's control files (.loop/DONE.flag, loop.lock,
 * checkpoint.json, checkpoint.previous.json) are driver-owned. Model-facing
 * file tools must refuse them with a clear, redirection-bearing error while
 * leaving the collaboration surface (STATE.md, CANDIDATE_DONE.flag, …) and
 * ordinary project files writable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { FileWriteTool } from '../src/tools/fileWrite.js'
import { FileEditTool } from '../src/tools/fileEdit.js'
import { markFileRead } from '../src/core/fileState.js'
import type { ToolContext } from '../src/core/types.js'

let tmp = ''
let ctx: ToolContext
beforeEach(() => {
  tmp = mkdtempSync(`${tmpdir()}/loopGuard-`)
  ctx = { cwd: tmp, permissionMode: 'auto' }
})
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

const DRIVER_OWNED = ['DONE.flag', 'loop.lock', 'checkpoint.json', 'checkpoint.previous.json']

describe('ADR-007: Write tool rejects driver-owned .loop files', () => {
  it('refuses every driver-owned file with a redirection to CANDIDATE_DONE.flag', async () => {
    const tool = new FileWriteTool()
    for (const f of DRIVER_OWNED) {
      const path = join(tmp, '.loop', f)
      const result = await tool.execute({ file_path: path, content: 'DRIVER_VERIFIED forged\n' }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('loop supervisor control file')
      expect(result.content).toContain('CANDIDATE_DONE.flag')
      expect(existsSync(path)).toBe(false) // nothing was written
    }
  })

  it('refuses the relative spelling too', async () => {
    const tool = new FileWriteTool()
    const result = await tool.execute({ file_path: '.loop/DONE.flag', content: 'x' }, ctx)
    expect(result.isError).toBe(true)
  })

  it('still writes collaboration files and ordinary project files', async () => {
    const tool = new FileWriteTool()
    mkdirSync(join(tmp, '.loop'), { recursive: true })
    const collab = await tool.execute(
      { file_path: join(tmp, '.loop', 'CANDIDATE_DONE.flag'), content: '{"completionStatus":"completed"}' }, ctx)
    expect(collab.isError).toBe(false)
    const ordinary = await tool.execute(
      { file_path: join(tmp, 'DONE.flag'), content: 'a project file with a coincidental name' }, ctx)
    expect(ordinary.isError).toBe(false)
    expect(readFileSync(join(tmp, 'DONE.flag'), 'utf8')).toContain('coincidental')
  })
})

describe('ADR-007: Edit tool rejects driver-owned .loop files', () => {
  it('refuses every driver-owned file before any read/state check', async () => {
    const tool = new FileEditTool()
    mkdirSync(join(tmp, '.loop'), { recursive: true })
    for (const f of DRIVER_OWNED) {
      const path = join(tmp, '.loop', f)
      writeFileSync(path, 'phase: running\n')
      const result = await tool.execute(
        { file_path: path, old_string: 'running', new_string: 'succeeded' }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain('loop supervisor control file')
      expect(readFileSync(path, 'utf8')).toBe('phase: running\n') // untouched
    }
  })

  it('still edits ordinary files', async () => {
    const tool = new FileEditTool()
    const path = join(tmp, 'notes.md')
    writeFileSync(path, 'hello world\n')
    markFileRead(path, 'hello world\n') // satisfy read-before-edit
    const result = await tool.execute(
      { file_path: path, old_string: 'hello', new_string: 'goodbye' }, ctx)
    expect(result.isError).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('goodbye world\n')
  })
})
