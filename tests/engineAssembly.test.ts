/**
 * v0.4.1 WS3 — assembleEngine extraction.
 *
 * The engine assembly that used to live inline in bin/ovogogogo.ts is now
 * a single function every entry mode shares (interactive / single-shot /
 * stdin / --pipe / --bg / --loop), so permission mode, model precedence
 * and module wiring cannot drift between front doors.
 *
 * These tests construct real engines against a dead API base URL — no
 * runTurn, so no network. session:false (the pipe contract) must NOT
 * create a project session dir; its scratch dir is cleaned on dispose().
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { assembleEngine } from '../src/cli/engineAssembly.js'
import { ExecutionEngine } from '../src/core/engine.js'
import { Renderer } from '../src/ui/renderer.js'
import type { AssemblyOptions } from '../src/cli/engineAssembly.js'

function baseOptions(cwd: string, overrides: Partial<AssemblyOptions> = {}): AssemblyOptions {
  return {
    cwd,
    apiKey: 'test-key',
    baseURL: 'http://127.0.0.1:1/v1',
    provider: 'openai',
    model: 'echo-model',
    maxIterations: 10,
    frontend: 'headless',
    session: false,
    quiet: true,
    version: '0.0.0-test',
    skills: new Map(),
    getActivePrompt: () => null,
    ...overrides,
  }
}

describe('assembleEngine', () => {
  let tmpProj: string

  beforeEach(() => {
    tmpProj = mkdtempSync(join(tmpdir(), 'ovolv999-asm-'))
  })
  afterEach(() => {
    try { rmSync(tmpProj, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('headless + session:false builds an engine with a scratch sessionDir outside the project', async () => {
    const a = await assembleEngine(baseOptions(tmpProj))
    try {
      expect(a.engine).toBeInstanceOf(ExecutionEngine)
      expect(a.config.sessionDir).toBeTruthy()
      expect(a.config.sessionDir!.startsWith(tmpProj)).toBe(false)
      expect(a.config.permissionMode).toBe('auto')
      expect(a.config.systemPrompt).toContain('ovolv999 Coding Agent')
      expect(a.sessionDir).toBe(a.config.sessionDir)
    } finally {
      a.dispose()
    }
  })

  it('model precedence: explicit model wins; project config would override when present', async () => {
    const a = await assembleEngine(baseOptions(tmpProj, { model: 'cli-model' }))
    try {
      expect(a.config.model).toBe('cli-model')
      expect(a.model).toBe('cli-model')
    } finally {
      a.dispose()
    }
  })

  it('v0.4.1 C4: every front door shares ONE assembly — identical permissionMode + model', async () => {
    const classic = await assembleEngine(baseOptions(tmpProj, { frontend: 'classic', model: 'parity-model' }))
    const headless = await assembleEngine(baseOptions(tmpProj, { frontend: 'headless', model: 'parity-model' }))
    try {
      expect(classic.config.permissionMode).toBe(headless.config.permissionMode)
      expect(classic.config.permissionMode).toBe('auto')
      expect(classic.config.model).toBe(headless.config.model)
      expect(classic.config.model).toBe('parity-model')
    } finally {
      classic.dispose()
      headless.dispose()
    }
  })

  it('dispose() removes the scratch session dir and is idempotent', async () => {
    const a = await assembleEngine(baseOptions(tmpProj))
    const scratch = a.config.sessionDir!
    expect(existsSync(scratch)).toBe(true)
    a.dispose()
    expect(existsSync(scratch)).toBe(false)
    expect(() => a.dispose()).not.toThrow()
  })

  it('frontend classic yields a classic Renderer and no UIStore', async () => {
    const a = await assembleEngine(baseOptions(tmpProj, { frontend: 'classic' }))
    try {
      expect(a.renderer).toBeInstanceOf(Renderer)
      expect(a.uiStore).toBeUndefined()
    } finally {
      a.dispose()
    }
  })

  it('frontend ink creates a UIStore + InkRenderer', async () => {
    const a = await assembleEngine(baseOptions(tmpProj, { frontend: 'ink' }))
    try {
      expect(a.uiStore).toBeTruthy()
      expect(a.inkRenderer).toBeTruthy()
    } finally {
      a.dispose()
    }
  })

  it('session {mode:new} creates the session dir under the project', async () => {
    const a = await assembleEngine(baseOptions(tmpProj, { session: { mode: 'new' } }))
    try {
      expect(a.sessionDir).toBeTruthy()
      expect(a.sessionDir.startsWith(join(tmpProj, 'sessions'))).toBe(true)
      expect(statSync(a.sessionDir).isDirectory()).toBe(true)
    } finally {
      a.dispose()
    }
  })

  it('is reusable: assembling twice in one process does not throw (module re-registration)', async () => {
    const a1 = await assembleEngine(baseOptions(tmpProj))
    a1.dispose()
    const a2 = await assembleEngine(baseOptions(tmpProj))
    a2.dispose()
    expect(a2.engine).toBeInstanceOf(ExecutionEngine)
  })
})
