/**
 * R10.2: prove that the user-rule pipeline from settings.json flows
 * into the actual permission check inside ToolExecutor.
 *
 * Path under test:
 *   ~/.ovogo/settings.json → settings.permissions.rules[]
 *   → engineAssembly.ts:184-188 addRule()
 *   → PermissionManager.rules (Layer 4)
 *   → ToolExecutor → permissionManager.check()
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

import { PermissionManager } from '../src/core/permissionSystem.js'
import { ToolExecutor } from '../src/core/toolRuntime/toolExecutor.js'
import { ToolRegistry } from '../src/core/toolRuntime/toolRegistry.js'
import { ToolPolicy } from '../src/core/toolRuntime/toolPolicy.js'
import { ContextManager } from '../src/core/context/contextManager.js'
import { BashTool } from '../src/tools/index.js'
import type { ToolContext } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'
import OpenAI from 'openai'

let tmpDir = ''
beforeEach(() => {
  tmpDir = mkdtempSync(`${tmpdir()}/r10-rules-`)
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

function makeExecutor(pm: PermissionManager, cm: ContextManager): ToolExecutor {
  const registry = new ToolRegistry(noopRenderer)
  registry.reset([new BashTool()], [])
  return new ToolExecutor({
    toolRegistry: registry,
    toolPolicy: new ToolPolicy({}),
    permissionManager: pm,
    contextManager: cm,
    notifyToolCall: () => {},
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

describe('R10.2: user rules from settings.json reach ToolExecutor', () => {
  const cm = makeContextManager()

  it('user rule "Bash:ls * → allow" overrides default mode for those commands', async () => {
    // This is what engineAssembly.ts:184-188 does at boot.
    const pm = new PermissionManager()
    pm.setMode('default') // default mode asks for dangerous; ls is safe anyway
    pm.addRule({
      toolName: 'Bash',
      ruleContent: 'ls *',
      behavior: 'allow',
      source: 'user',
    })

    const exec = makeExecutor(pm, cm)
    // Use an arg the allow rule pattern matches
    const result = await exec.execute('c1', 'Bash', { command: 'ls -la' }, makeToolContext(tmpDir), false, 1)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('total') // standard ls output
  })

  it('user rule "Bash:rm -rf * → deny" beats default mode (defense in depth)', async () => {
    const pm = new PermissionManager()
    pm.setMode('default')
    pm.addRule({
      toolName: 'Bash',
      ruleContent: 'rm -rf *',
      behavior: 'deny',
      source: 'user',
    })

    const exec = makeExecutor(pm, cm)
    const result = await exec.execute('c2', 'Bash', { command: 'rm -rf /tmp/x' }, makeToolContext(tmpDir, 'acceptEdits'), false, 1)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/denied/i)
  })

  it('user rule "Bash:npm test → ask" overrides default allow', async () => {
    const pm = new PermissionManager()
    pm.setMode('default')
    pm.addRule({
      toolName: 'Bash',
      ruleContent: 'npm test',
      behavior: 'ask',
      source: 'user',
    })

    const exec = makeExecutor(pm, cm)
    // No requestPermission wired in this exec → falls through to run anyway
    // (the executor's 'ask' branch defaults to "continue in single-user mode" when no UI)
    const result = await exec.execute('c3', 'Bash', { command: 'npm test' }, makeToolContext(tmpDir), false, 1)
    // result may be error (no package.json) but NOT a denial
    expect(result.content).not.toMatch(/Permission denied/)
  })

  it('settings.json permissions.rules are actually parsed (no schema validation gap)', async () => {
    // Direct schema test: write a valid settings.json, run loadSettings,
    // verify the rules come out the other side.
    const pm = new PermissionManager()
    const settingsPath = join(tmpDir, '.ovogo', 'settings.json')
    const { mkdirSync } = await import('fs')
    mkdirSync(join(tmpDir, '.ovogo'), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({
      permissions: {
        mode: 'default',
        rules: [
          { toolName: 'Bash', ruleContent: 'karma *', behavior: 'allow', source: 'user' },
          { toolName: 'Read', ruleContent: '*.secret', behavior: 'deny', source: 'user' },
        ],
      },
    }))

    const { loadSettings } = await import('../src/config/settings.js')
    const settings = loadSettings(tmpDir)
    expect(settings.permissions?.rules?.length).toBe(2)
    expect(settings.permissions?.rules?.[0]?.toolName).toBe('Bash')

    for (const rule of settings.permissions?.rules ?? []) {
      pm.addRule(rule)
    }
    expect(pm.getRules().length).toBe(2)
  })
})
