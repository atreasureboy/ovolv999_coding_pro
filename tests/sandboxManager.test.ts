/**
 * v0.5.2 (C9 — borrowed from codex sandboxing/{landlock.rs,bwrap.rs}):
 * tests for the SandboxManager fallback chain.
 */
import { describe, it, expect } from 'vitest'
import { SandboxManager } from '../src/core/sandbox.js'

describe('SandboxManager (C9)', () => {
  it('returns the host-appropriate backend list', () => {
    const mgr = new SandboxManager()
    const list = mgr.listAvailable()
    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBeGreaterThan(0)
    // Every entry has a backend string and a boolean availability
    for (const s of list) {
      expect(typeof s.backend).toBe('string')
      expect(typeof s.available).toBe('boolean')
    }
  })

  it('select() returns a usable backend or "none" with a reason', () => {
    const mgr = new SandboxManager()
    const result = mgr.select()
    expect(['none', 'macos-seatbelt', 'linux-bubblewrap', 'linux-landlock', 'windows-jobobject'])
      .toContain(result.selected)
    expect(Array.isArray(result.attempted)).toBe(true)
    if (result.selected === 'none') {
      // When no backend is available, the manager MUST surface a
      // fallbackReason — otherwise the caller can't warn the user.
      expect(typeof result.fallbackReason).toBe('string')
    }
  })

  it('selectedBackend() agrees with select()', () => {
    const mgr = new SandboxManager()
    expect(mgr.selectedBackend()).toBe(mgr.select().selected)
  })
})