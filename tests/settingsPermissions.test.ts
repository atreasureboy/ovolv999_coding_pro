import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { getProjectSettingsPath, loadSettings, saveProjectSettings } from '../src/config/settings.js'

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'ovogo-settings-'))
}

describe('settings permissions', () => {
  it('saves permission mode and rules into project settings', () => {
    const cwd = tmpProject()
    const saved = saveProjectSettings(cwd, {
      permissions: {
        mode: 'auto',
        rules: [{ toolName: 'Bash', ruleContent: 'git *', behavior: 'allow', source: 'user' }],
      },
    })

    expect(saved.permissions?.mode).toBe('auto')
    expect(saved.permissions?.rules).toHaveLength(1)
    expect(loadSettings(cwd).permissions?.rules?.[0].ruleContent).toBe('git *')
  })

  it('preserves unrelated project settings when permissions are updated', () => {
    const cwd = tmpProject()
    mkdirSync(join(cwd, '.ovogo'), { recursive: true })
    writeFileSync(getProjectSettingsPath(cwd), JSON.stringify({
      taskContext: { name: 'coding', scope: ['src'] },
    }), 'utf8')

    saveProjectSettings(cwd, { permissions: { mode: 'plan', rules: [] } })
    const loaded = loadSettings(cwd)

    expect(loaded.taskContext?.name).toBe('coding')
    expect(loaded.permissions?.mode).toBe('plan')
  })

  it('filters invalid permission modes and rules while loading settings', () => {
    const cwd = tmpProject()
    mkdirSync(join(cwd, '.ovogo'), { recursive: true })
    writeFileSync(getProjectSettingsPath(cwd), JSON.stringify({
      permissions: {
        mode: 'root',
        rules: [
          { toolName: 'Bash', ruleContent: 'git *', behavior: 'allow', source: 'user' },
          { toolName: '', ruleContent: 'rm *', behavior: 'deny', source: 'user' },
          { toolName: 'Bash', ruleContent: 'npm *', behavior: 'maybe', source: 'user' },
          { toolName: 'Read', ruleContent: 'src/**', behavior: 'allow', source: 'unknown' },
        ],
      },
    }), 'utf8')

    const loaded = loadSettings(cwd)

    expect(loaded.permissions?.mode).toBeUndefined()
    expect(loaded.permissions?.rules).toEqual([
      { toolName: 'Bash', ruleContent: 'git *', behavior: 'allow', source: 'user' },
    ])
  })
})
