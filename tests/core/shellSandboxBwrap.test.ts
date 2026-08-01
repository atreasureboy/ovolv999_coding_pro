import { describe, expect, it } from 'vitest'
import {
  bubblewrapArgs,
  isBwrapAvailable,
  wrapWithBwrap,
} from '../../src/core/shellSandbox.js'

describe('bubblewrap (R7)', () => {
  it('produces standard bwrap argv prefix', () => {
    const args = bubblewrapArgs('/home/user/proj')
    expect(args[0]).toBe('bwrap')
    expect(args).toContain('--unshare-net')
    expect(args).toContain('--die-with-parent')
    expect(args).toContain('--ro-bind-try')
    expect(args).toContain('--bind-try')
    expect(args).toContain('--')
    expect(args[args.length - 2]).toBe('/bin/sh')
    expect(args[args.length - 1]).toBe('-c')
  })

  it('includes workdir as --bind-try', () => {
    const args = bubblewrapArgs('/tmp/sandbox-test')
    const idx = args.indexOf('/tmp/sandbox-test')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx - 1]).toBe('--bind-try')
  })

  it('includes /tmp as writable', () => {
    const args = bubblewrapArgs('/x')
    expect(args).toContain('/tmp')
  })

  it('wrapWithBwrap joins and quotes a single command', () => {
    const out = wrapWithBwrap('echo hello', '/x')
    expect(out).toMatch(/^bwrap /)
    expect(out).toMatch(/--unshare-net/)
    expect(out).toContain("'echo hello'")
  })

  it('isBwrapAvailable returns boolean without throwing', () => {
    const result = isBwrapAvailable()
    expect(typeof result).toBe('boolean')
  })
})
