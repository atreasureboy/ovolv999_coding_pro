/**
 * R11: prove that every permission layer in the 5-layer executor flow
 * emits a `permission_decision` event to the EventLog.
 *
 * Layer 1 (toolPolicy) is NOT a permission decision — it is a structural
 * pre-check (plan mode, agent allowlist). Layers 2-5 are the
 * permission layers and MUST emit.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'

import { ToolExecutor } from '../src/core/toolRuntime/toolExecutor.js'
import { ToolRegistry } from '../src/core/toolRuntime/toolRegistry.js'
import { ToolPolicy } from '../src/core/toolRuntime/toolPolicy.js'
import { PermissionManager } from '../src/core/permissionSystem.js'
import { ContextManager } from '../src/core/context/contextManager.js'
import { BashTool, FileReadTool, FileWriteTool } from '../src/tools/index.js'
import { EventLog } from '../src/core/eventLog.js'
import { sessionApprovalCache } from '../src/core/permissionRules.js'
import type { ToolContext } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'
import OpenAI from 'openai'

let tmpDir = ''
beforeEach(() => {
  tmpDir = mkdtempSync(`${tmpdir()}/r11-decision-`)
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

function makeExecutor(pm: PermissionManager, cm: ContextManager, eventLog: EventLog): ToolExecutor {
  const registry = new ToolRegistry(noopRenderer)
  registry.reset([new BashTool(), new FileReadTool(), new FileWriteTool()], [])
  return new ToolExecutor({
    toolRegistry: registry,
    toolPolicy: new ToolPolicy({}),
    permissionManager: pm,
    contextManager: cm,
    notifyToolCall: () => {},
    renderer: noopRenderer,
    eventLog,
  })
}

function makeContext(cwd: string, permissionMode: ToolContext['permissionMode'] = 'default'): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    permissionMode,
  }
}

function makeEventLog(): EventLog {
  return new EventLog(join(tmpDir, 'events.jsonl'))
}

function readDecisions(log: EventLog): Array<{ source: string; tool: string; outcome: string; reason: string; ruleId: string | null }> {
  const entries = log.readAll() ?? []
  return entries
    .filter((e) => e.type === 'permission_decision')
    .map((e) => {
      const d = e.detail as { tool?: string; outcome?: string; reason?: string; ruleId?: string | null; primaryArg?: string }
      return {
        source: e.source,
        tool: d.tool ?? '',
        outcome: d.outcome ?? '',
        reason: d.reason ?? '',
        ruleId: d.ruleId ?? null,
      }
    })
}

describe('R11: permission_decision event audit log', () => {
  const cm = makeContextManager()

  it('Layer 2 (mode_gate) emits allow when bypassPermissions', async () => {
    const log = makeEventLog()
    const pm = new PermissionManager()
    pm.setMode('bypassPermissions')
    const exec = makeExecutor(pm, cm, log)
    await exec.execute('c1', 'Bash', { command: 'echo hi' }, makeContext(tmpDir, 'bypassPermissions'), false, 1)
    const decisions = readDecisions(log)
    const modeGate = decisions.find((d) => d.source === 'mode_gate')
    expect(modeGate).toBeDefined()
    expect(modeGate?.outcome).toBe('allow')
    expect(modeGate?.tool).toBe('Bash')
  })

  it('Layer 3 (glob_engine) emits deny when rm -rf', async () => {
    const log = makeEventLog()
    const pm = new PermissionManager()
    const exec = makeExecutor(pm, cm, log)
    await exec.execute('c2', 'Bash', { command: 'rm -rf /tmp/x' }, makeContext(tmpDir, 'bypassPermissions'), false, 1)
    const decisions = readDecisions(log)
    const glob = decisions.find((d) => d.source === 'glob_engine')
    expect(glob).toBeDefined()
    expect(glob?.outcome).toBe('deny')
    expect(glob?.reason).toMatch(/recursive delete|rm -rf/i)
    expect(glob?.ruleId).toBe('deny-rm-rf')
  })

  it('Layer 4 (permission_manager) emits deny when manager rules deny', async () => {
    const log = makeEventLog()
    const pm = new PermissionManager()
    pm.setMode('default')
    pm.addRule({ toolName: 'Bash', ruleContent: 'curl *', behavior: 'deny', source: 'user' })
    const exec = makeExecutor(pm, cm, log)
    await exec.execute('c3', 'Bash', { command: 'curl http://example.com' }, makeContext(tmpDir), false, 1)
    const decisions = readDecisions(log)
    const pmDec = decisions.find((d) => d.source === 'permission_manager')
    expect(pmDec).toBeDefined()
    expect(pmDec?.outcome).toBe('deny')
    expect(pmDec?.tool).toBe('Bash')
  })

  it('Layer 3 glob allow + safe command emits allow', async () => {
    const log = makeEventLog()
    const pm = new PermissionManager()
    const exec = makeExecutor(pm, cm, log)
    await exec.execute('c4', 'Bash', { command: 'echo hello' }, makeContext(tmpDir), false, 1)
    const decisions = readDecisions(log)
    const glob = decisions.find((d) => d.source === 'glob_engine' && d.outcome === 'allow')
    expect(glob).toBeDefined()
    expect(glob?.tool).toBe('Bash')
  })

  it('session_approval cache hit emits allow', async () => {
    const log = makeEventLog()
    const pm = new PermissionManager()
    sessionApprovalCache.approve('Bash', 'echo approved')
    const exec = makeExecutor(pm, cm, log)
    await exec.execute('c5', 'Bash', { command: 'echo approved' }, makeContext(tmpDir), false, 1)
    const decisions = readDecisions(log)
    const session = decisions.find((d) => d.source === 'session_approval')
    expect(session).toBeDefined()
    expect(session?.outcome).toBe('allow')
  })

  it('no eventLog → no decisions recorded (best-effort), no crash', async () => {
    const pm = new PermissionManager()
    const exec = makeExecutor(pm, cm, undefined as never)
    // rm -rf should still be denied by glob engine, just no event log
    const result = await exec.execute('c6', 'Bash', { command: 'rm -rf /tmp/x' }, makeContext(tmpDir, 'bypassPermissions'), false, 1)
    expect(result.isError).toBe(true)
  })

  it('decision events include mode, primaryArg, and ruleId fields', async () => {
    const log = makeEventLog()
    const pm = new PermissionManager()
    const exec = makeExecutor(pm, cm, log)
    await exec.execute('c7', 'Bash', { command: 'rm -rf /tmp/x' }, makeContext(tmpDir, 'bypassPermissions'), false, 1)
    const entries = log.readAll() ?? []
    const dec = entries.find((e) => e.type === 'permission_decision')
    expect(dec).toBeDefined()
    const d = dec?.detail as Record<string, unknown>
    expect(d).toHaveProperty('mode')
    expect(d).toHaveProperty('primaryArg')
    expect(d).toHaveProperty('ruleId')
    expect(d).toHaveProperty('callId')
  })
})
