import { describe, it, expect } from 'vitest'
import {
  getNextPermissionMode,
  permissionModeLabel,
  permissionModeDescription,
  getModeBehavior,
  matchRule,
  checkRules,
  PermissionManager,
  type PermissionRule,
} from '../src/core/permissionSystem.js'

describe('Permission Mode Cycling', () => {
  it('cycles through all 5 modes in order', () => {
    expect(getNextPermissionMode('default')).toBe('acceptEdits')
    expect(getNextPermissionMode('acceptEdits')).toBe('plan')
    expect(getNextPermissionMode('plan')).toBe('auto')
    expect(getNextPermissionMode('auto')).toBe('bypassPermissions')
    expect(getNextPermissionMode('bypassPermissions')).toBe('default')
  })

  it('wraps around', () => {
    expect(getNextPermissionMode('bypassPermissions')).toBe('default')
  })

  it('returns default for unknown mode', () => {
    expect(getNextPermissionMode('unknown' as never)).toBe('default')
  })

  it('has labels for all modes', () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const) {
      expect(permissionModeLabel(mode)).toBeTruthy()
      expect(permissionModeDescription(mode)).toBeTruthy()
    }
  })
})

describe('getModeBehavior', () => {
  it('bypass allows everything', () => {
    expect(getModeBehavior('bypassPermissions', 'Bash', false)).toBe('allow')
    expect(getModeBehavior('bypassPermissions', 'Bash', true)).toBe('allow')
    expect(getModeBehavior('bypassPermissions', 'Write', false)).toBe('allow')
  })

  it('plan denies writes but allows reads', () => {
    expect(getModeBehavior('plan', 'Read', false)).toBe('allow')
    expect(getModeBehavior('plan', 'Glob', false)).toBe('allow')
    expect(getModeBehavior('plan', 'Write', false)).toBe('deny')
    expect(getModeBehavior('plan', 'Bash', false)).toBe('deny')
    expect(getModeBehavior('plan', 'Edit', false)).toBe('deny')
  })

  it('plan allows ExitPlanMode', () => {
    expect(getModeBehavior('plan', 'ExitPlanMode', false)).toBe('allow')
  })

  it('auto allows safe, asks for dangerous', () => {
    expect(getModeBehavior('auto', 'Bash', false)).toBe('allow')
    expect(getModeBehavior('auto', 'Bash', true)).toBe('ask')
  })

  it('acceptEdits auto-approves file tools', () => {
    expect(getModeBehavior('acceptEdits', 'Write', false)).toBe('allow')
    expect(getModeBehavior('acceptEdits', 'Edit', false)).toBe('allow')
    expect(getModeBehavior('acceptEdits', 'Read', false)).toBe('allow')
    // Dangerous Bash prompts for confirmation (regression: previously 'deny')
    expect(getModeBehavior('acceptEdits', 'Bash', true)).toBe('ask')
  })

  // Regression: acceptEdits must prompt — not silently deny — for dangerous
  // Bash, matching the behaviour of 'default' and 'auto'. Otherwise users
  // see "Permission denied" with no opportunity to confirm a one-off command.
  it('acceptEdits dangerous Bash behaves like default (ask, not deny)', () => {
    expect(getModeBehavior('acceptEdits', 'Bash', true)).toBe('ask')
    // Non-dangerous Bash still allowed
    expect(getModeBehavior('acceptEdits', 'Bash', false)).toBe('allow')
    // Confirm the other modes are unchanged — regression guard for this fix.
    expect(getModeBehavior('default', 'Bash', true)).toBe('ask')
    expect(getModeBehavior('auto', 'Bash', true)).toBe('ask')
    expect(getModeBehavior('bypassPermissions', 'Bash', true)).toBe('allow')
  })

  it('default allows safe, asks for dangerous', () => {
    expect(getModeBehavior('default', 'Read', false)).toBe('allow')
    expect(getModeBehavior('default', 'Bash', true)).toBe('ask')
  })
})

describe('matchRule', () => {
  it('matches exact command', () => {
    expect(matchRule('ls -la', 'ls -la')).toBe(true)
    expect(matchRule('ls -la', 'ls -la /home')).toBe(false)
  })

  it('matches prefix with legacy :* syntax', () => {
    expect(matchRule('npm:*', 'npm install')).toBe(true)
    expect(matchRule('npm:*', 'npm run build')).toBe(true)
    expect(matchRule('npm:*', 'yarn install')).toBe(false)
  })

  it('matches wildcard pattern', () => {
    expect(matchRule('git *', 'git commit')).toBe(true)
    expect(matchRule('git *', 'git push origin main')).toBe(true)
    expect(matchRule('git *', 'git')).toBe(true) // trailing wildcard is optional
    expect(matchRule('git *', 'npm install')).toBe(false)
  })

  it('matches multi-word wildcard', () => {
    expect(matchRule('npm run *', 'npm run build')).toBe(true)
    expect(matchRule('npm run *', 'npm test')).toBe(false)
  })
})

describe('checkRules', () => {
  const rules: PermissionRule[] = [
    { toolName: 'Bash', ruleContent: 'git *', behavior: 'allow', source: 'user' },
    { toolName: 'Bash', ruleContent: 'rm *', behavior: 'deny', source: 'builtin' },
    { toolName: 'Read', ruleContent: 'src/**', behavior: 'allow', source: 'project' },
  ]

  it('returns allow for matching allow rule', () => {
    const result = checkRules(rules, 'Bash', { command: 'git status' })
    expect(result?.behavior).toBe('allow')
  })

  it('returns deny for matching deny rule', () => {
    const result = checkRules(rules, 'Bash', { command: 'rm -rf /tmp' })
    expect(result?.behavior).toBe('deny')
  })

  it('returns null when no rule matches', () => {
    const result = checkRules(rules, 'Bash', { command: 'docker build' })
    expect(result).toBeNull()
  })

  it('checks toolName filter', () => {
    const result = checkRules(rules, 'Write', { command: 'git status' })
    expect(result).toBeNull() // git rule is for Bash, not Write
  })
})

describe('PermissionManager', () => {
  it('starts in default mode', () => {
    const mgr = new PermissionManager()
    expect(mgr.getMode()).toBe('default')
  })

  it('can set mode', () => {
    const mgr = new PermissionManager()
    mgr.setMode('auto')
    expect(mgr.getMode()).toBe('auto')
  })

  it('can cycle mode', () => {
    const mgr = new PermissionManager()
    mgr.cycleMode()
    expect(mgr.getMode()).toBe('acceptEdits')
    mgr.cycleMode()
    expect(mgr.getMode()).toBe('plan')
  })

  it('check uses rules first', () => {
    const mgr = new PermissionManager()
    mgr.setMode('default')
    mgr.addRule({ toolName: 'Bash', ruleContent: 'git *', behavior: 'allow', source: 'user' })
    // Even in default mode, git commands are allowed by rule
    expect(mgr.check('Bash', { command: 'git status' }, false)).toBe('allow')
    // Non-git commands use mode default
    expect(mgr.check('Bash', { command: 'docker build' }, false)).toBe('allow')
  })

  it('deduplicates identical rules', () => {
    const mgr = new PermissionManager()
    mgr.addRule({ toolName: 'Bash', ruleContent: 'git *', behavior: 'allow', source: 'user' })
    mgr.addRule({ toolName: 'Bash', ruleContent: 'git *', behavior: 'allow', source: 'project' })
    mgr.addRule({ toolName: 'Bash', ruleContent: 'git *', behavior: 'deny', source: 'user' })

    expect(mgr.getRules()).toHaveLength(2)
  })

  it('deny rule overrides mode', () => {
    const mgr = new PermissionManager()
    mgr.setMode('bypassPermissions')
    mgr.addRule({ toolName: 'Bash', ruleContent: 'rm *', behavior: 'deny', source: 'builtin' })
    // Even in bypass, rm is denied by rule
    expect(mgr.check('Bash', { command: 'rm -rf /' }, true)).toBe('deny')
  })

  it('formatRules returns readable string', () => {
    const mgr = new PermissionManager()
    mgr.addRule({ toolName: 'Bash', ruleContent: 'git *', behavior: 'allow', source: 'user' })
    const out = mgr.formatRules()
    expect(out).toContain('git *')
    expect(out).toContain('ALLOW')
    expect(out).toContain('user')
  })

  it('formatMode returns label and description', () => {
    const mgr = new PermissionManager()
    mgr.setMode('acceptEdits')
    const out = mgr.formatMode()
    expect(out).toContain('Accept Edits')
    expect(out).toContain('file')
  })
})
