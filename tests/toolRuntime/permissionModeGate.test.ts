import { describe, expect, it } from 'vitest'
import { gateByPermissionMode } from '../../src/core/toolRuntime/permissionModeGate.js'

describe('permissionModeGate (R5)', () => {
  it('bypassPermissions allows all', () => {
    expect(gateByPermissionMode('bypassPermissions', 'Bash')).toBe('allow')
    expect(gateByPermissionMode('bypassPermissions', 'Write')).toBe('allow')
  })

  it('dontAsk allows all', () => {
    expect(gateByPermissionMode('dontAsk', 'Read')).toBe('allow')
    expect(gateByPermissionMode('dontAsk', 'Edit')).toBe('allow')
  })

  it('acceptEdits allows edit tools, defers others', () => {
    expect(gateByPermissionMode('acceptEdits', 'Write')).toBe('allow')
    expect(gateByPermissionMode('acceptEdits', 'Edit')).toBe('allow')
    expect(gateByPermissionMode('acceptEdits', 'NotebookEdit')).toBe('allow')
    expect(gateByPermissionMode('acceptEdits', 'Bash')).toBe('check')
    expect(gateByPermissionMode('acceptEdits', 'Read')).toBe('check')
  })

  it('default / auto / plan / bubble defer to permissionManager', () => {
    expect(gateByPermissionMode('default', 'Bash')).toBe('check')
    expect(gateByPermissionMode('auto', 'Edit')).toBe('check')
    expect(gateByPermissionMode('plan', 'Write')).toBe('check')
    expect(gateByPermissionMode('bubble', 'Bash')).toBe('check')
  })

  it('acceptEdits does not auto-allow MultiEdit by default', () => {
    expect(gateByPermissionMode('acceptEdits', 'MultiEdit')).toBe('check')
  })
})
