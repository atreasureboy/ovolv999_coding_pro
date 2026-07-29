/**
 * v0.4.1 WS1 — config diagnostics: config errors are never silent.
 *
 * Contract under test:
 *  - corrupt project settings (.ovogo/settings.json) → structured throw with
 *    path + line/column + fix (explicit REPL load path);
 *  - corrupt global settings → loadGlobalProvider degrades to undefined with
 *    a one-time stderr warning (this runs on EVERY boot, even --version —
 *    it must never crash);
 *  - invalid fields (rules/servers/mode/hooks/taskContext) → dropped WITH a
 *    one-time warning naming the field (warn-not-throw);
 *  - corrupt .ovolv999.json → warn + null (never throws — CI/--bg children
 *    must survive), wrong field types dropped per-field with warnings;
 *  - warnings go to stderr ONLY (stdout is reserved for --pipe output).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import {
  parseJsonSyntaxError,
  formatDiagnostics,
  warnConfigOnce,
} from '../src/config/diagnostics.js'
import type { ConfigDiagnostic } from '../src/config/diagnostics.js'
import { resetWarnOnce } from '../src/utils/warnOnce.js'
import { loadProjectSettings, loadSettings, loadGlobalProvider } from '../src/config/settings.js'
import { loadProjectConfig } from '../src/config/projectConfig.js'

describe('parseJsonSyntaxError', () => {
  it('parses the explicit "(line N column M)" V8 format', () => {
    const err = new SyntaxError('Unexpected token } in JSON at position 14 (line 3 column 5)')
    expect(parseJsonSyntaxError(err)).toEqual({ line: 3, column: 5 })
  })

  it('converts a bare position offset against the source text', () => {
    const source = '{\n  ]' // ']' is at offset 4 → line 2 column 3
    const err = new SyntaxError('Unexpected token ] in JSON at position 4')
    expect(parseJsonSyntaxError(err, source)).toEqual({ line: 2, column: 3 })
  })

  it('returns null for a non-SyntaxError', () => {
    expect(parseJsonSyntaxError(new Error('EACCES: permission denied'))).toBeNull()
  })

  it('returns an empty location for a SyntaxError without position info', () => {
    expect(parseJsonSyntaxError(new SyntaxError('Unexpected end of JSON input'))).toEqual({})
  })
})

describe('formatDiagnostics / warnConfigOnce', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetWarnOnce()
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => {
    stderrSpy.mockRestore()
    resetWarnOnce()
  })

  it('formats one line per diagnostic with location, field, and fix', () => {
    const text = formatDiagnostics([{
      file: '/x/settings.json',
      line: 2,
      column: 3,
      field: 'permissions.mode',
      severity: 'warning',
      message: 'invalid mode',
      fix: 'use "auto"',
    }])
    expect(text).toBe(
      '[config warning] /x/settings.json:2:3 (permissions.mode): invalid mode — fix: use "auto"',
    )
  })

  it('warns exactly once per (file, field) key — stderr only', () => {
    const diag: ConfigDiagnostic = {
      file: '/x/a.json', field: 'mcp', severity: 'warning', message: 'dropped entry',
    }
    warnConfigOnce(diag)
    warnConfigOnce(diag)
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy.mock.calls[0][0]).toContain('/x/a.json')
    expect(stderrSpy.mock.calls[0][0]).toContain('(mcp)')
  })

  it('distinct keys each warn once', () => {
    warnConfigOnce({ file: '/x/a.json', field: 'mcp', severity: 'warning', message: 'm1' })
    warnConfigOnce({ file: '/x/a.json', field: 'hooks', severity: 'warning', message: 'm2' })
    expect(stderrSpy).toHaveBeenCalledTimes(2)
  })
})

describe('settings.ts — corrupt or invalid config is visible', () => {
  let workDir: string
  let stderrSpy: ReturnType<typeof vi.spyOn>
  const globalPath = join(homedir(), '.ovogo', 'settings.json')
  let globalBackup: string | null = null

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'cfgdiag-'))
    resetWarnOnce()
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    globalBackup = existsSync(globalPath) ? readFileSync(globalPath, 'utf8') : null
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    if (globalBackup !== null) {
      writeFileSync(globalPath, globalBackup, 'utf8')
    } else if (existsSync(globalPath)) {
      rmSync(globalPath)
    }
    resetWarnOnce()
    rmSync(workDir, { recursive: true, force: true })
  })

  function writeProjectSettings(json: string): void {
    mkdirSync(join(workDir, '.ovogo'), { recursive: true })
    writeFileSync(join(workDir, '.ovogo', 'settings.json'), json, 'utf8')
  }

  it('loadProjectSettings throws a structured error with path and fix on corrupt JSON', () => {
    writeProjectSettings('{ bad json ')
    let message = ''
    try {
      loadProjectSettings(workDir)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/Corrupted JSON config file/)
    expect(message).toContain(join(workDir, '.ovogo', 'settings.json'))
    expect(message).toContain('Fix suggestion')
  })

  it('loadSettings (explicit REPL load) still throws on corrupt global settings', () => {
    mkdirSync(join(homedir(), '.ovogo'), { recursive: true })
    writeFileSync(globalPath, '{ nope', 'utf8')
    expect(() => loadSettings(workDir)).toThrow(/Corrupted JSON config file/)
  })

  it('loadGlobalProvider degrades to undefined with ONE warning on corrupt global settings', () => {
    mkdirSync(join(homedir(), '.ovogo'), { recursive: true })
    writeFileSync(globalPath, '{ nope', 'utf8')
    expect(loadGlobalProvider()).toBeUndefined()
    expect(loadGlobalProvider()).toBeUndefined() // dedup: still one warning
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    const msg = stderrSpy.mock.calls[0][0] as string
    expect(msg).toContain(globalPath)
    expect(msg.toLowerCase()).toContain('fix')
  })

  it('invalid permission rules are dropped WITH a warning; valid rules survive', () => {
    writeProjectSettings(JSON.stringify({
      permissions: {
        rules: [
          { toolName: 'Bash', ruleContent: 'git *', behavior: 'allow', source: 'user' },
          { toolName: '', ruleContent: 'x', behavior: 'allow', source: 'user' },
        ],
      },
    }))
    const s = loadProjectSettings(workDir)
    expect(s.permissions?.rules).toHaveLength(1)
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy.mock.calls[0][0]).toContain('permissions.rules[1]')
  })

  it('invalid permissions.mode is dropped with a warning', () => {
    writeProjectSettings(JSON.stringify({ permissions: { mode: 'godmode' } }))
    const s = loadProjectSettings(workDir)
    expect(s.permissions?.mode).toBeUndefined()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy.mock.calls[0][0]).toContain('permissions.mode')
  })

  it('invalid mcp server entries are dropped with a warning', () => {
    writeProjectSettings(JSON.stringify({
      mcp: {
        servers: [
          { name: 'ok', command: ['node', 'x.js'] },
          { name: '', command: [] },
        ],
      },
    }))
    const s = loadProjectSettings(workDir)
    expect(s.mcp?.servers).toHaveLength(1)
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy.mock.calls[0][0]).toContain('mcp.servers[1]')
  })

  it('invalid hook entries are dropped with a warning', () => {
    writeProjectSettings(JSON.stringify({
      hooks: { PreToolCall: [{ matcher: 'Bash', command: 'echo hi' }, { matcher: 'x' }] },
    }))
    const s = loadProjectSettings(workDir)
    expect(s.hooks?.PreToolCall).toHaveLength(1)
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('invalid taskContext field types are dropped with a warning; valid fields survive', () => {
    writeProjectSettings(JSON.stringify({ taskContext: { name: 42, phase: 'impl' } }))
    const s = loadProjectSettings(workDir)
    expect(s.taskContext?.name).toBeUndefined()
    expect(s.taskContext?.phase).toBe('impl')
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('drops literal model API keys and invalid apiKeyEnv names', () => {
    writeProjectSettings(JSON.stringify({
      models: {
        profiles: [
          {
            id: 'builder',
            model: 'builder-model',
            roles: ['builder'],
            apiKey: 'must-not-survive',
            apiKeyEnv: 'bad-key-name',
          },
        ],
      },
    }))

    const settings = loadProjectSettings(workDir)
    const profile = settings.models?.profiles[0] as Record<string, unknown>
    expect(profile.apiKey).toBeUndefined()
    expect(profile.apiKeyEnv).toBeUndefined()
    const warnings = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n')
    expect(warnings).toContain('apiKey')
    expect(warnings).toContain('tier inferred from legacy roles')
  })

  it('accepts explicit model tiers and drops invalid tier values', () => {
    writeProjectSettings(JSON.stringify({
      models: {
        profiles: [
          { id: 'main', model: 'top-model', tier: 'top', roles: ['main'] },
          { id: 'builder', model: 'worker-model', tier: 'secondary', roles: ['builder'] },
          { id: 'invalid', model: 'invalid-model', tier: 'cheap', roles: ['worker'] },
        ],
      },
    }))

    const settings = loadProjectSettings(workDir)
    const profiles = settings.models?.profiles as Array<Record<string, unknown>>
    expect(profiles.map((profile) => profile.tier)).toEqual(['top', 'secondary', undefined])
    expect(stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n')).toContain('invalid model tier')
  })
})

describe('projectConfig — corrupt or invalid .ovolv999.json warns and continues', () => {
  let workDir: string
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'projcfg-'))
    resetWarnOnce()
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => {
    stderrSpy.mockRestore()
    resetWarnOnce()
    rmSync(workDir, { recursive: true, force: true })
  })

  it('corrupt JSON returns null with a one-time warning (never throws)', () => {
    writeFileSync(join(workDir, '.ovolv999.json'), '{ bad', 'utf8')
    expect(loadProjectConfig(workDir)).toBeNull()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy.mock.calls[0][0]).toContain(join(workDir, '.ovolv999.json'))
  })

  it('wrong field types are dropped per-field with warnings; valid fields survive', () => {
    writeFileSync(join(workDir, '.ovolv999.json'), JSON.stringify({
      model: 'gpt-4o',
      maxIterations: 'lots',
      permissionMode: 'godmode',
      temperature: 0.2,
    }))
    const cfg = loadProjectConfig(workDir)
    expect(cfg).not.toBeNull()
    expect(cfg?.model).toBe('gpt-4o')
    expect(cfg?.temperature).toBe(0.2)
    expect(cfg?.maxIterations).toBeUndefined()
    expect(cfg?.permissionMode).toBeUndefined()
    expect(stderrSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('valid config loads silently (no warnings)', () => {
    writeFileSync(join(workDir, '.ovolv999.json'), JSON.stringify({
      model: 'gpt-4o', maxIterations: 50, permissionMode: 'auto',
    }))
    const cfg = loadProjectConfig(workDir)
    expect(cfg?.maxIterations).toBe(50)
    expect(stderrSpy).not.toHaveBeenCalled()
  })
})
