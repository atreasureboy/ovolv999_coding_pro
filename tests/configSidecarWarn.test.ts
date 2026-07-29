/**
 * v0.4.1 WS1 — sidecar config loaders: corrupt input → defaults/null +
 * exactly ONE stderr warning (never silent, never fatal, never stdout).
 *
 * Covers: sandbox, telemetry, team-memory, statusline, settings-sync bundle
 * collection, migrations raw-config read. Each backed up/restored so the
 * developer's real ~/.ovolv999 files survive the run.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { resetWarnOnce } from '../src/utils/warnOnce.js'
import { loadConfig as loadSandboxConfig, DEFAULT_CONFIG as SANDBOX_DEFAULTS } from '../src/core/sandbox.js'
import { loadConfig as loadTelemetryConfig, DEFAULT_CONFIG as TELEMETRY_DEFAULTS } from '../src/core/telemetry.js'
import { loadTeamConfig } from '../src/core/teamMemory.js'
import { loadConfig as loadStatusLineConfig } from '../src/ui/statusLineCustom.js'
import { collectBundle } from '../src/core/settingsSync.js'
import { getRawConfig } from '../src/core/migrations.js'

const DIR = join(homedir(), '.ovolv999')
const TOUCHED = ['sandbox.json', 'telemetry-config.json', 'team-memory.json', 'statusline.json', 'config.json']

describe('sidecar config loaders warn once on corrupt input and degrade safely', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let backups: Map<string, string | null>

  beforeEach(() => {
    mkdirSync(DIR, { recursive: true })
    backups = new Map(
      TOUCHED.map((f) => {
        const p = join(DIR, f)
        return [f, existsSync(p) ? readFileSync(p, 'utf8') : null] as const
      }),
    )
    resetWarnOnce()
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    for (const [f, content] of backups) {
      const p = join(DIR, f)
      if (content === null) {
        if (existsSync(p)) rmSync(p)
      } else {
        writeFileSync(p, content, 'utf8')
      }
    }
    resetWarnOnce()
  })

  function corrupt(name: string): void {
    writeFileSync(join(DIR, name), '{ not json', 'utf8')
  }

  it('sandbox.loadConfig → defaults + exactly one warning', () => {
    corrupt('sandbox.json')
    const cfg = loadSandboxConfig()
    expect(cfg).toEqual({ ...SANDBOX_DEFAULTS })
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy.mock.calls[0][0]).toContain('sandbox.json')
  })

  it('telemetry.loadConfig → defaults + exactly one warning', () => {
    corrupt('telemetry-config.json')
    const cfg = loadTelemetryConfig()
    expect(cfg).toEqual({ ...TELEMETRY_DEFAULTS })
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy.mock.calls[0][0]).toContain('telemetry-config.json')
  })

  it('teamMemory.loadTeamConfig → null + exactly one warning', () => {
    corrupt('team-memory.json')
    expect(loadTeamConfig()).toBeNull()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy.mock.calls[0][0]).toContain('team-memory.json')
  })

  it('statusLineCustom.loadConfig → null + exactly one warning', () => {
    corrupt('statusline.json')
    expect(loadStatusLineConfig()).toBeNull()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy.mock.calls[0][0]).toContain('statusline.json')
  })

  it('settingsSync.collectBundle skips a corrupt config.json with one warning', () => {
    corrupt('config.json')
    const bundle = collectBundle()
    expect(bundle.config).toBeUndefined()
    const warnings = stderrSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('config.json'))
    expect(warnings).toHaveLength(1)
  })

  it('migrations.getRawConfig(project) → null + one warning on corrupt settings', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'migcfg-'))
    try {
      mkdirSync(join(workDir, '.ovolv999'), { recursive: true })
      writeFileSync(join(workDir, '.ovolv999', 'settings.json'), '{ nope', 'utf8')
      expect(getRawConfig('project', workDir)).toBeNull()
      expect(stderrSpy).toHaveBeenCalledTimes(1)
      expect(stderrSpy.mock.calls[0][0]).toContain(join(workDir, '.ovolv999', 'settings.json'))
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  it('missing files stay silent (no warnings, defaults returned)', () => {
    for (const f of TOUCHED) {
      const p = join(DIR, f)
      if (existsSync(p)) rmSync(p)
    }
    expect(loadSandboxConfig()).toEqual({ ...SANDBOX_DEFAULTS })
    expect(loadTelemetryConfig()).toEqual({ ...TELEMETRY_DEFAULTS })
    expect(loadTeamConfig()).toBeNull()
    expect(loadStatusLineConfig()).toBeNull()
    expect(stderrSpy).not.toHaveBeenCalled()
  })
})
