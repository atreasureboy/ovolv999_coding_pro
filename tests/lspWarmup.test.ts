import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { homedir } from 'os'
import { join } from 'path'
import {
  warmLspForFile,
  loadLspServersFromSettings,
  _resetLspToolCaches,
} from '../src/tools/lspTool.js'

/**
 * Round 40 (opencode read→LSP warmup): FileRead fires a one-shot
 * background warmup for the matching language server. Shared registry +
 * one-attempt-per-(cwd,server) dedupe; failures are swallowed.
 */

let home = ''
let cwd = ''
const realHome = homedir()

function writeSettings(servers: unknown): void {
  mkdirSync(join(home, '.ovogo'), { recursive: true })
  writeFileSync(
    join(home, '.ovogo', 'settings.json'),
    JSON.stringify({ lsp: { servers } }, null, 2),
    'utf8',
  )
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ovogo-lsp-warm-'))
  cwd = mkdtempSync(join(tmpdir(), 'ovogo-lsp-warm-cwd-'))
  process.env.HOME = home
  _resetLspToolCaches()
})

afterEach(() => {
  process.env.HOME = realHome
  _resetLspToolCaches()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

describe('warmLspForFile', () => {
  it('returns false when no servers are configured', () => {
    expect(warmLspForFile(join(cwd, 'a.ts'), cwd)).toBe(false)
  })

  it('returns true and attempts exactly once for a matching extension', async () => {
    writeSettings({
      tsserver: { command: 'definitely-not-a-real-binary-12345', fileExtensions: ['.ts'] },
    })
    // Settings cache was reset in beforeEach — the write above is visible.
    const first = warmLspForFile(join(cwd, 'a.ts'), cwd)
    expect(first).toBe(true)

    // Dedupe: second call is a no-op (still true — server known).
    const second = warmLspForFile(join(cwd, 'b.ts'), cwd)
    expect(second).toBe(true)

    // The spawn failure is swallowed asynchronously; give it a tick and
    // confirm no state was poisoned for later tool calls.
    await new Promise((r) => setTimeout(r, 50))
    expect(warmLspForFile(join(cwd, 'c.ts'), cwd)).toBe(true)
  })

  it('non-matching extensions never warm', () => {
    writeSettings({
      tsserver: { command: 'x', fileExtensions: ['.ts'] },
    })
    expect(warmLspForFile(join(cwd, 'a.py'), cwd)).toBe(false)
  })

  it('loadLspServersFromSettings reads the lsp.servers block', () => {
    writeSettings({
      pylsp: { command: 'pylsp', fileExtensions: ['.py'] },
    })
    _resetLspToolCaches()
    const servers = loadLspServersFromSettings()
    expect(servers.pylsp?.command).toBe('pylsp')
  })
})
