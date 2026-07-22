/**
 * Phase 2 (five_goal §三/§四): StructuredToolResult preservation +
 * WorkingState live integration.
 *
 * Verifies that the main execution chain preserves structured fields
 * (status, exitCode, stdout, stderr) from Tool → ToolExecutor →
 * ToolScheduler, and that WorkingState is actually mutated by real
 * tool results during a turn (not just in isolated unit tests).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { ToolExecutor } from '../src/core/toolRuntime/toolExecutor.js'
import { ToolScheduler } from '../src/core/toolRuntime/toolScheduler.js'
import { ToolRegistry } from '../src/core/toolRuntime/toolRegistry.js'
import { ToolPolicy } from '../src/core/toolRuntime/toolPolicy.js'
import { PermissionManager } from '../src/core/permissionSystem.js'
import { ContextManager } from '../src/core/context/contextManager.js'
import { SharedRuntimeState } from '../src/core/runtime/sharedState.js'
import { RunEventEmitter } from '../src/core/runtime/events.js'
import { BashTool, FileReadTool, FileWriteTool } from '../src/tools/index.js'
import { isStructuredResult, toStructured, type AnyToolResult } from '../src/core/structuredToolResult.js'
import type { ToolContext, OpenAIMessage } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'
import OpenAI from 'openai'

let tmpDir = ''
beforeEach(() => {
  tmpDir = mkdtempSync(`${tmpdir()}/phase2-`)
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

const noopRenderer: Renderer = {
  raw: () => {}, info: () => {}, warn: () => {}, error: () => {},
  userMessage: () => {}, assistantMessage: () => {}, toolCall: () => {},
  toolResult: () => {}, cost: () => {}, compactionNotice: () => {},
  turnEnd: () => {}, planModeHeader: () => {},
} as never

function makeExecutor(cm: ContextManager): ToolExecutor {
  const registry = new ToolRegistry(noopRenderer)
  registry.reset([new BashTool(), new FileReadTool(), new FileWriteTool()], [])
  return new ToolExecutor({
    toolRegistry: registry,
    toolPolicy: new ToolPolicy({}),
    permissionManager: new PermissionManager(),
    contextManager: cm,
    notifyToolCall: () => {},
    renderer: noopRenderer,
  })
}

function makeContextManager(): ContextManager {
  const client = new OpenAI({ apiKey: 'test', baseURL: 'http://localhost:0' })
  return new ContextManager({
    client,
    model: 'test-model',
    maxContextTokens: 4096,
    maxOutputTokens: 1024,
    renderer: noopRenderer,
  })
}

function makeToolContext(cwd: string): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
  } as ToolContext
}

// ─────────────────────────────────────────────────────────────────────
// §三: StructuredToolResult preserved through ToolExecutor
// ─────────────────────────────────────────────────────────────────────
describe('§三: ToolExecutor preserves structured fields (no premature toLegacy)', () => {
  it('Bash non-zero exit carries status/exitCode/stdout/stderr through executor', async () => {
    const cm = makeContextManager()
    const executor = makeExecutor(cm)
    const result = await executor.execute(
      'test-1', 'Bash',
      { command: 'echo to-stdout ; echo to-stderr 1>&2 ; exit 42' },
      makeToolContext(tmpDir), false, 1,
    ) as AnyToolResult

    // The result should STILL carry structured fields after executor.
    expect(isStructuredResult(result)).toBe(true)
    const s = toStructured(result)
    expect(s.status).toBe('failed')
    expect(s.exitCode).toBe(42)
    expect(s.stdout).toContain('to-stdout')
    expect(s.stderr).toContain('to-stderr')
  })

  it('Bash exit 0 carries status=success + exitCode=0', async () => {
    const cm = makeContextManager()
    const executor = makeExecutor(cm)
    const result = await executor.execute(
      'test-2', 'Bash',
      { command: 'echo hello' },
      makeToolContext(tmpDir), false, 1,
    ) as AnyToolResult

    expect(isStructuredResult(result)).toBe(true)
    const s = toStructured(result)
    expect(s.status).toBe('success')
    expect(s.exitCode).toBe(0)
    expect(s.stdout).toContain('hello')
  })

  it('content + isError are still available for legacy consumers', async () => {
    const cm = makeContextManager()
    const executor = makeExecutor(cm)
    const result = await executor.execute(
      'test-3', 'Bash',
      { command: 'false' },
      makeToolContext(tmpDir), false, 1,
    )

    // Legacy fields still present.
    expect(typeof result.content).toBe('string')
    expect(result.isError).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// §四: WorkingState mutated by real tool execution
// ─────────────────────────────────────────────────────────────────────
describe('§四: WorkingState is mutated by real tool results via ToolScheduler', () => {
  it('Read success → filesRead updated', async () => {
    const testFile = join(tmpDir, 'target.txt')
    writeFileSync(testFile, 'hello world')
    const cm = makeContextManager()
    const executor = makeExecutor(cm)
    await executor.execute(
      'read-1', 'Read',
      { file_path: testFile },
      makeToolContext(tmpDir), false, 1,
    )
    // WorkingState should now list the file in filesRead.
    expect(cm.getWorkingState().filesRead).toContain(testFile)
  })

  it('Write success → filesChanged updated', async () => {
    const testFile = join(tmpDir, 'new.txt')
    const cm = makeContextManager()
    const executor = makeExecutor(cm)
    await executor.execute(
      'write-1', 'Write',
      { file_path: testFile, content: 'new content' },
      makeToolContext(tmpDir), false, 1,
    )
    expect(cm.getWorkingState().filesChanged).toContain(testFile)
  })

  it('Bash exit 0 → verification.passed updated', async () => {
    const cm = makeContextManager()
    const executor = makeExecutor(cm)
    await executor.execute(
      'bash-ok', 'Bash',
      { command: 'true' },
      makeToolContext(tmpDir), false, 1,
    )
    expect(cm.getWorkingState().verification.passed).toContain('true')
  })

  it('Bash non-zero → verification.failed + unresolved updated', async () => {
    const cm = makeContextManager()
    const executor = makeExecutor(cm)
    await executor.execute(
      'bash-fail', 'Bash',
      { command: 'false' },
      makeToolContext(tmpDir), false, 1,
    )
    const ws = cm.getWorkingState()
    expect(ws.verification.failed).toContain('false')
    expect(ws.unresolved.some(u => u.includes('Bash failed'))).toBe(true)
  })

  it('Bash pass after prior fail → unresolved resolved', async () => {
    const marker = join(tmpDir, 'marker')
    const cm = makeContextManager()
    const executor = makeExecutor(cm)
    // First: file doesn't exist → test exits 1
    await executor.execute('bash-1', 'Bash', { command: `test -f ${marker}` }, makeToolContext(tmpDir), false, 1)
    expect(cm.getWorkingState().unresolved.length).toBeGreaterThan(0)
    // Create the file
    writeFileSync(marker, 'exists')
    // Second: same command now passes
    await executor.execute('bash-2', 'Bash', { command: `test -f ${marker}` }, makeToolContext(tmpDir), false, 1)
    // The unresolved entry for this command should be resolved.
    expect(cm.getWorkingState().unresolved.some(u => u.includes('test -f'))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// §四: WorkingState render — empty guard
// ─────────────────────────────────────────────────────────────────────
describe('§四: renderWorkingStateBlock empty guard', () => {
  it('empty WorkingState renders empty string (no injection)', () => {
    const cm = makeContextManager()
    expect(cm.renderWorkingStateBlock()).toBe('')
  })

  it('non-empty WorkingState renders content', async () => {
    const cm = makeContextManager()
    const executor = makeExecutor(cm)
    await executor.execute('r', 'Bash', { command: 'true' }, makeToolContext(tmpDir), false, 1)
    const block = cm.renderWorkingStateBlock()
    expect(block).not.toBe('')
    expect(block).toMatch(/verification/)
  })
})
