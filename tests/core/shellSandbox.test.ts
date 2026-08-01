import { describe, expect, it } from 'vitest'
import {
  macOSSandboxExecArgv,
  describeSandboxProfile,
} from '../../src/core/shellSandbox.js'

describe('shellSandbox', () => {
  it('builds macOS sandbox-exec argv with profile', () => {
    if (process.platform !== 'darwin') {
      return
    }
    const argv = macOSSandboxExecArgv(['bash', '-c', 'echo hi'], '/tmp')
    expect(argv[0]).toBe('/usr/bin/sandbox-exec')
    expect(argv[1]).toBe('-p')
    expect(argv[2]).toContain('WORKDIR')
    expect(argv[2]).toContain('/tmp')
    expect(argv[3]).toBe('bash')
  })

  it('passes through argv on non-macOS', () => {
    if (process.platform === 'darwin') return
    const argv = macOSSandboxExecArgv(['echo', 'hi'], '/tmp')
    expect(argv).toEqual(['echo', 'hi'])
  })

  it('describes profile as non-empty string', () => {
    const desc = describeSandboxProfile('/tmp')
    expect(desc).toBeTruthy()
    expect(typeof desc).toBe('string')
  })

  it('macOS profile contains deny network-outbound', () => {
    if (process.platform !== 'darwin') return
    const desc = describeSandboxProfile('/tmp')
    expect(desc).toContain('deny network-outbound')
  })

  it('linux profile contains fs rules', () => {
    if (process.platform !== 'linux') return
    const desc = describeSandboxProfile('/tmp')
    expect(desc).toContain('fs-read')
    expect(desc).toContain('fs-write')
    expect(desc).toContain('no-network')
  })
})
