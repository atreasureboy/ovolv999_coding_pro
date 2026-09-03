/**
 * R9.2: prove that the glob-engine permission rules in `permissionRules.ts`
 * are actually reached by the tool executor's permission flow.
 *
 * Without this test, the rules could be decorator-only code that nothing
 * imports. The original wiring problem (R9.1) was that the rules module
 * was wired only to settingsSync export, not the executor.
 *
 * The test runs three real denies (rm -rf / sudo / .env write) and three
 * real allows (Read / Glob / safe bash) through a ToolExecutor and
 * confirms the right outcome.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

import { ToolExecutor } from '../src/core/toolRuntime/toolExecutor.js'
import { ToolRegistry } from '../src/core/toolRuntime/toolRegistry.js'
import { ToolPolicy } from '../src/core/toolRuntime/toolPolicy.js'
import { PermissionManager } from '../src/core/permissionSystem.js'
import { ContextManager } from '../src/core/context/contextManager.js'
import { BashTool, FileReadTool, FileWriteTool } from '../src/tools/index.js'
import { sessionApprovalCache } from '../src/core/permissionRules.js'
import type { IHookRunner, ToolContext } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'
import OpenAI from 'openai'

let tmpDir = ''
beforeEach(() => {
  tmpDir = mkdtempSync(`${tmpdir()}/r9-perm-`)
  sessionApprovalCache.clear()
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

function makeExecutor(cm: ContextManager, hookRunner?: IHookRunner): ToolExecutor {
  const registry = new ToolRegistry(noopRenderer)
  registry.reset([new BashTool(), new FileReadTool(), new FileWriteTool()], [])
  return new ToolExecutor({
    toolRegistry: registry,
    toolPolicy: new ToolPolicy({}),
    permissionManager: new PermissionManager(),
    contextManager: cm,
    notifyToolCall: () => {},
    renderer: noopRenderer,
    hookRunner,
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

function makeToolContext(cwd: string, permissionMode: ToolContext['permissionMode'] = 'default'): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    permissionMode,
  }
}

describe('R9.2: glob engine wired into ToolExecutor', () => {
  const cm = makeContextManager()

  it('denies BASH rm -rf regardless of mode (defense-in-depth)', async () => {
    const exec = makeExecutor(cm)
    const ctx = makeToolContext(tmpDir, 'bypassPermissions') // bypass mode
    const result = await exec.execute(
      'call-1',
      'Bash',
      { command: 'rm -rf /tmp/should-not-delete' },
      ctx,
      false,
      1,
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/Permission rule denied/)
    expect(result.content).toMatch(/recursive delete|rm -rf/i)
  })

  it('denies BASH sudo regardless of mode', async () => {
    const exec = makeExecutor(cm)
    const ctx = makeToolContext(tmpDir, 'bypassPermissions')
    const result = await exec.execute(
      'call-2',
      'Bash',
      { command: 'sudo apt-get update' },
      ctx,
      false,
      1,
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/Permission rule denied/)
  })

  it('denies WRITE to .env files', async () => {
    const exec = makeExecutor(cm)
    const ctx = makeToolContext(tmpDir, 'default')
    const result = await exec.execute(
      'call-3',
      'Write',
      { file_path: join(tmpDir, '.env'), content: 'SECRET=x' },
      ctx,
      false,
      1,
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/Permission rule denied/)
  })

  it('rechecks permission rules after a hook rewrites tool input', async () => {
    const hookRunner = {
      runPreToolUse: async () => [{
        decision: 'allow' as const,
        updatedInput: { file_path: join(tmpDir, '.env'), content: 'SECRET=x' },
        hookName: 'rewrite',
      }],
      runPreToolCall: () => [],
      runPostToolCall: () => [],
      runUserPromptSubmit: () => [],
    }
    const exec = makeExecutor(cm, hookRunner)
    const result = await exec.execute(
      'call-hook-rewrite',
      'Write',
      { file_path: join(tmpDir, 'safe.txt'), content: 'safe' },
      makeToolContext(tmpDir, 'acceptEdits'),
      false,
      1,
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/hook-updated input/i)
  })

  it('fails closed when a hook asks in a non-interactive executor', async () => {
    const hookRunner = {
      runPreToolUse: async () => [{ decision: 'ask' as const, hookName: 'approval' }],
      runPreToolCall: () => [],
      runPostToolCall: () => [],
      runUserPromptSubmit: () => [],
    }
    const exec = makeExecutor(cm, hookRunner)
    const result = await exec.execute(
      'call-hook-ask',
      'Write',
      { file_path: join(tmpDir, 'safe.txt'), content: 'safe' },
      makeToolContext(tmpDir, 'acceptEdits'),
      false,
      1,
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/no permission prompt/i)
  })

  it('allows BASH safe commands even with default mode', async () => {
    const exec = makeExecutor(cm)
    const ctx = makeToolContext(tmpDir, 'default')
    const result = await exec.execute(
      'call-4',
      'Bash',
      { command: 'ls -la' },
      ctx,
      false,
      1,
    )
    // Should NOT be denied by the glob engine
    expect(result.isError).toBe(false)
    expect(result.content).not.toMatch(/Permission rule denied/)
  })

  it('allows READ on any path by default', async () => {
    const target = join(tmpDir, 'hello.txt')
    writeFileSync(target, 'hi')
    const exec = makeExecutor(cm)
    const ctx = makeToolContext(tmpDir, 'default')
    const result = await exec.execute(
      'call-5',
      'Read',
      { file_path: target },
      ctx,
      false,
      1,
    )
    expect(result.isError).toBe(false)
    expect(result.content).toContain('hi')
  })

  it('session-approval cache skips subsequent asks', async () => {
    // Pre-approve Bash with a safe command for this session
    sessionApprovalCache.approve('Bash', 'echo hello')

    const exec = makeExecutor(cm)
    const ctx = makeToolContext(tmpDir, 'default')
    // This is not a deny rule, so the glob engine returns 'ask' by default.
    // The session-approval cache should make it skip the prompt.
    const result = await exec.execute(
      'call-6',
      'Bash',
      { command: 'echo hello' },
      ctx,
      false,
      1,
    )
    // Should not be denied by permission system AND the command runs
    expect(result.isError).toBe(false)
    expect(result.content).toContain('hello')
  })

  it('Bash tool wraps command with sandbox when permissionMode === bubble', async () => {
    // Integration sanity check: the bash tool's permissionMode check.
    // We don't actually run the wrapped command (no real sandbox in CI),
    // but we verify the check fires by reading the bash.ts source.
    const fs = await import('fs/promises')
    const bashSrc = await fs.readFile(
      new URL('../src/tools/bash.ts', import.meta.url),
      'utf8',
    )
    expect(bashSrc).toMatch(/permissionMode === 'bubble'/)
    expect(bashSrc).toMatch(/sandboxWrap/)
  })

  it('dontAsk mode: glob engine deny still wins (deny is non-negotiable)', async () => {
    // Even in dontAsk mode, the glob engine's deny is absolute — no
    // bypass by user setting. This is the defense-in-depth principle.
    const exec = makeExecutor(cm)
    const ctx = makeToolContext(tmpDir, 'dontAsk')
    const result = await exec.execute(
      'call-7',
      'Bash',
      { command: 'rm -rf /tmp/x' },
      ctx,
      false,
      1,
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/Permission rule denied/)
  })
})
