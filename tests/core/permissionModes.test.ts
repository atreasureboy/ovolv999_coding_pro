import { describe, expect, it } from 'vitest'
import {
  getNextPermissionMode,
  isValidPermissionMode,
  isSandboxMode,
  isBypassMode,
  permissionModeDescription,
  permissionModeLabel,
  permissionModeSymbol,
} from '../../src/core/permissionSystem.js'

describe('Permission mode utilities (7 modes)', () => {
  it('accepts all 7 valid modes', () => {
    const valid = [
      'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk', 'bubble',
    ]
    for (const mode of valid) {
      expect(isValidPermissionMode(mode)).toBe(true)
    }
  })

  it('rejects unknown modes', () => {
    expect(isValidPermissionMode('unknown')).toBe(false)
    expect(isValidPermissionMode('default2')).toBe(false)
  })

  it('cycles through modes in order', () => {
    expect(getNextPermissionMode('default')).toBe('acceptEdits')
    expect(getNextPermissionMode('acceptEdits')).toBe('plan')
    expect(getNextPermissionMode('plan')).toBe('auto')
    expect(getNextPermissionMode('auto')).toBe('bypassPermissions')
    expect(getNextPermissionMode('bypassPermissions')).toBe('dontAsk')
    expect(getNextPermissionMode('dontAsk')).toBe('bubble')
    expect(getNextPermissionMode('bubble')).toBe('default')
  })

  it('returns default for unknown current mode', () => {
    expect(getNextPermissionMode('unknown' as never)).toBe('default')
  })

  it('identifies sandbox mode', () => {
    expect(isSandboxMode('bubble')).toBe(true)
    expect(isSandboxMode('default')).toBe(false)
    expect(isSandboxMode('plan')).toBe(false)
  })

  it('identifies bypass modes', () => {
    expect(isBypassMode('bypassPermissions')).toBe(true)
    expect(isBypassMode('dontAsk')).toBe(true)
    expect(isBypassMode('default')).toBe(false)
    expect(isBypassMode('plan')).toBe(false)
  })

  it('returns a label for every mode', () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk', 'bubble'] as const) {
      expect(permissionModeLabel(mode)).toBeTruthy()
      expect(permissionModeSymbol(mode)).toBeDefined()
      expect(permissionModeDescription(mode)).toContain(' ')
    }
  })
})
