import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  validateManifest,
  parseManifest,
  registerBuiltinPlugin,
  getBuiltinPlugins,
  _clearBuiltinPlugins,
  loadPlugins,
  enablePlugin,
  disablePlugin,
  getEnabledPlugins,
  createPluginScaffold,
  checkDependencies,
  formatPluginList,
  type PluginManifest,
} from '../src/core/plugins.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

function makePluginDir(dir: string, name: string, manifest: Partial<PluginManifest> = {}): string {
  const pluginDir = join(dir, '.ovolv999', 'plugins', name)
  mkdirSync(pluginDir, { recursive: true })
  const fullManifest: PluginManifest = {
    name,
    version: '1.0.0',
    description: `${name} plugin`,
    ...manifest,
  }
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(fullManifest), 'utf8')
  return pluginDir
}

// ── Manifest Validation ─────────────────────────────────────────────────────

describe('validateManifest', () => {
  it('validates a complete manifest', () => {
    const m = validateManifest({
      name: 'test', version: '1.0.0', description: 'd', author: 'a',
    })
    expect(m).not.toBeNull()
    expect(m!.name).toBe('test')
    expect(m!.version).toBe('1.0.0')
  })

  it('validates manifest with provides', () => {
    const m = validateManifest({
      name: 'test', version: '1.0.0',
      provides: { tools: ['tools.js'], commands: ['cmds.js'] },
    })
    expect(m!.provides!.tools).toEqual(['tools.js'])
    expect(m!.provides!.commands).toEqual(['cmds.js'])
  })

  it('rejects missing name', () => {
    expect(validateManifest({ version: '1.0.0' })).toBeNull()
  })

  it('rejects empty name', () => {
    expect(validateManifest({ name: '', version: '1.0.0' })).toBeNull()
  })

  it('rejects missing version', () => {
    expect(validateManifest({ name: 'test' })).toBeNull()
  })

  it('rejects non-objects', () => {
    expect(validateManifest(null)).toBeNull()
    expect(validateManifest('string')).toBeNull()
    expect(validateManifest(42)).toBeNull()
  })

  it('accepts enabled flag', () => {
    const m = validateManifest({ name: 'x', version: '1', enabled: false })
    expect(m!.enabled).toBe(false)
  })

  it('defaults enabled to undefined (treated as true)', () => {
    const m = validateManifest({ name: 'x', version: '1' })
    expect(m!.enabled).toBeUndefined()
  })

  it('handles dependencies array', () => {
    const m = validateManifest({ name: 'x', version: '1', dependencies: ['dep1', 'dep2'] })
    expect(m!.dependencies).toEqual(['dep1', 'dep2'])
  })
})

describe('parseManifest', () => {
  it('parses valid JSON', () => {
    const m = parseManifest(JSON.stringify({ name: 'x', version: '1.0' }))
    expect(m).not.toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseManifest('{invalid')).toBeNull()
  })
})

// ── Built-in Plugins ────────────────────────────────────────────────────────

describe('Built-in plugins', () => {
  beforeEach(() => _clearBuiltinPlugins())
  afterEach(() => _clearBuiltinPlugins())

  it('registers a built-in plugin', () => {
    registerBuiltinPlugin({ name: 'builtin-test', version: '1.0.0', description: 'test' })
    const plugins = getBuiltinPlugins()
    expect(plugins).toHaveLength(1)
    expect(plugins[0].name).toBe('builtin-test')
  })

  it('can register multiple', () => {
    registerBuiltinPlugin({ name: 'a', version: '1' })
    registerBuiltinPlugin({ name: 'b', version: '1' })
    expect(getBuiltinPlugins()).toHaveLength(2)
  })

  it('overwrites same-name registration', () => {
    registerBuiltinPlugin({ name: 'x', version: '1' })
    registerBuiltinPlugin({ name: 'x', version: '2' })
    expect(getBuiltinPlugins()).toHaveLength(1)
    expect(getBuiltinPlugins()[0].version).toBe('2')
  })
})

// ── Plugin Discovery ────────────────────────────────────────────────────────

describe('loadPlugins', () => {
  let dir: string

  beforeEach(() => {
    _clearBuiltinPlugins()
    dir = mkdtempSync(join(tmpdir(), 'plug-'))
  })

  afterEach(() => {
    _clearBuiltinPlugins()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('returns empty registry with no plugins', () => {
    const registry = loadPlugins(dir)
    expect(registry.plugins.size).toBe(0)
  })

  it('loads built-in plugins', () => {
    registerBuiltinPlugin({ name: 'b1', version: '1.0.0' })
    const registry = loadPlugins(dir)
    expect(registry.plugins.size).toBe(1)
    expect(registry.bySource.get('builtin')).toHaveLength(1)
  })

  it('loads project plugins from .ovolv999/plugins/', () => {
    makePluginDir(dir, 'proj-plug')
    const registry = loadPlugins(dir)
    expect(registry.plugins.size).toBe(1)
    expect(registry.bySource.get('project')).toHaveLength(1)
    const plugin = [...registry.plugins.values()][0]
    expect(plugin.source).toBe('project')
    expect(plugin.path).toContain('proj-plug')
  })

  it('loads global plugins from homeDir', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'))
    try {
      makePluginDir(home, 'global-plug')
      const registry = loadPlugins(dir, home)
      expect(registry.plugins.size).toBe(1)
      expect(registry.bySource.get('global')).toHaveLength(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('combines builtin + project + global', () => {
    registerBuiltinPlugin({ name: 'builtin', version: '1' })
    makePluginDir(dir, 'project')
    const home = mkdtempSync(join(tmpdir(), 'home2-'))
    try {
      makePluginDir(home, 'global')
      const registry = loadPlugins(dir, home)
      expect(registry.plugins.size).toBe(3)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('skips directories without plugin.json', () => {
    const pluginDir = join(dir, '.ovolv999', 'plugins', 'no-manifest')
    mkdirSync(pluginDir, { recursive: true })
    const registry = loadPlugins(dir)
    expect(registry.plugins.size).toBe(0)
  })

  it('records error for invalid manifest', () => {
    const pluginDir = join(dir, '.ovolv999', 'plugins', 'bad')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'plugin.json'), '{invalid json', 'utf8')
    const registry = loadPlugins(dir)
    expect(registry.plugins.size).toBe(1)
    const plugin = [...registry.plugins.values()][0]
    expect(plugin.errors.length).toBeGreaterThan(0)
    expect(plugin.enabled).toBe(false)
  })

  it('detects missing provides files', () => {
    makePluginDir(dir, 'missing-files', {
      provides: { tools: ['nonexistent.js'] },
    })
    const registry = loadPlugins(dir)
    const plugin = [...registry.plugins.values()][0]
    expect(plugin.errors).toContain('Missing tools file: nonexistent.js')
  })

  it('passes validation when provides files exist', () => {
    const pluginPath = makePluginDir(dir, 'good-files', {
      provides: { tools: ['tools.js'] },
    })
    writeFileSync(join(pluginPath, 'tools.js'), '// tools', 'utf8')
    const registry = loadPlugins(dir)
    const plugin = [...registry.plugins.values()][0]
    expect(plugin.errors).toHaveLength(0)
  })

  it('respects enabled flag', () => {
    makePluginDir(dir, 'disabled', { enabled: false })
    const registry = loadPlugins(dir)
    const plugin = [...registry.plugins.values()][0]
    expect(plugin.enabled).toBe(false)
  })
})

// ── Enable/Disable ──────────────────────────────────────────────────────────

describe('enablePlugin & disablePlugin', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plug-ed-'))
  })

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('disables an enabled plugin', () => {
    makePluginDir(dir, 'toggle', { enabled: true })
    const result = disablePlugin(dir, 'toggle@project')
    expect(result.success).toBe(true)
    const registry = loadPlugins(dir)
    expect([...registry.plugins.values()][0].enabled).toBe(false)
  })

  it('enables a disabled plugin', () => {
    makePluginDir(dir, 'toggle', { enabled: false })
    const result = enablePlugin(dir, 'toggle@project')
    expect(result.success).toBe(true)
    const registry = loadPlugins(dir)
    expect([...registry.plugins.values()][0].enabled).toBe(true)
  })

  it('returns error for unknown plugin', () => {
    const result = enablePlugin(dir, 'nonexistent@project')
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('rejects builtin plugins', () => {
    _clearBuiltinPlugins()
    registerBuiltinPlugin({ name: 'builtin', version: '1' })
    const result = disablePlugin(dir, 'builtin@builtin')
    expect(result.success).toBe(false)
    expect(result.error).toContain('built-in')
    _clearBuiltinPlugins()
  })
})

// ── Get Enabled ─────────────────────────────────────────────────────────────

describe('getEnabledPlugins', () => {
  let dir: string

  beforeEach(() => {
    _clearBuiltinPlugins()
    dir = mkdtempSync(join(tmpdir(), 'plug-enabled-'))
  })

  afterEach(() => {
    _clearBuiltinPlugins()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('returns only enabled plugins', () => {
    makePluginDir(dir, 'enabled-one', { enabled: true })
    makePluginDir(dir, 'disabled-one', { enabled: false })
    const enabled = getEnabledPlugins(dir)
    expect(enabled).toHaveLength(1)
    expect(enabled[0].name).toBe('enabled-one')
  })

  it('excludes plugins with errors', () => {
    makePluginDir(dir, 'errored', {
      provides: { tools: ['missing.js'] },
    })
    const enabled = getEnabledPlugins(dir)
    expect(enabled).toHaveLength(0)
  })

  it('includes builtin plugins', () => {
    registerBuiltinPlugin({ name: 'b', version: '1' })
    const enabled = getEnabledPlugins(dir)
    expect(enabled).toHaveLength(1)
    expect(enabled[0].name).toBe('b')
  })
})

// ── Create Scaffold ─────────────────────────────────────────────────────────

describe('createPluginScaffold', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plug-scaffold-'))
  })

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('creates a basic plugin', () => {
    createPluginScaffold(dir, 'my-plugin')
    const registry = loadPlugins(dir)
    expect(registry.plugins.size).toBe(1)
    const plugin = [...registry.plugins.values()][0]
    expect(plugin.name).toBe('my-plugin')
    expect(plugin.version).toBe('0.1.0')
  })

  it('creates plugin with tools scaffold', () => {
    createPluginScaffold(dir, 'tool-plugin', { tools: true })
    const registry = loadPlugins(dir)
    const plugin = [...registry.plugins.values()][0]
    expect(plugin.manifest.provides!.tools).toEqual(['tools.js'])
    expect(plugin.errors).toHaveLength(0) // file was created
  })

  it('creates plugin with commands scaffold', () => {
    createPluginScaffold(dir, 'cmd-plugin', { commands: true })
    const registry = loadPlugins(dir)
    const plugin = [...registry.plugins.values()][0]
    expect(plugin.manifest.provides!.commands).toEqual(['commands.js'])
  })

  it('uses custom description', () => {
    createPluginScaffold(dir, 'desc-plugin', { description: 'Custom desc' })
    const registry = loadPlugins(dir)
    const plugin = [...registry.plugins.values()][0]
    expect(plugin.description).toBe('Custom desc')
  })
})

// ── Dependency Resolution ───────────────────────────────────────────────────

describe('checkDependencies', () => {
  let dir: string

  beforeEach(() => {
    _clearBuiltinPlugins()
    dir = mkdtempSync(join(tmpdir(), 'plug-deps-'))
  })

  afterEach(() => {
    _clearBuiltinPlugins()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('returns empty when no deps', () => {
    makePluginDir(dir, 'no-deps')
    const registry = loadPlugins(dir)
    expect(checkDependencies(registry).size).toBe(0)
  })

  it('returns empty when deps satisfied', () => {
    makePluginDir(dir, 'dep')
    makePluginDir(dir, 'dependent', { dependencies: ['dep'] })
    const registry = loadPlugins(dir)
    expect(checkDependencies(registry).size).toBe(0)
  })

  it('detects missing dependencies', () => {
    makePluginDir(dir, 'need-missing', { dependencies: ['nonexistent'] })
    const registry = loadPlugins(dir)
    const issues = checkDependencies(registry)
    expect(issues.size).toBe(1)
    const missing = [...issues.values()][0]
    expect(missing).toContain('nonexistent')
  })
})

// ── Formatting ──────────────────────────────────────────────────────────────

describe('formatPluginList', () => {
  let dir: string

  beforeEach(() => {
    _clearBuiltinPlugins()
    dir = mkdtempSync(join(tmpdir(), 'plug-fmt-'))
  })

  afterEach(() => {
    _clearBuiltinPlugins()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('includes header', () => {
    const registry = loadPlugins(dir)
    const text = formatPluginList(registry)
    expect(text).toContain('Plugins:')
    expect(text).toContain('Total:')
  })

  it('shows plugin names', () => {
    makePluginDir(dir, 'visible')
    const registry = loadPlugins(dir)
    const text = formatPluginList(registry)
    expect(text).toContain('visible')
  })

  it('shows source headers', () => {
    registerBuiltinPlugin({ name: 'b', version: '1' })
    makePluginDir(dir, 'p')
    const registry = loadPlugins(dir)
    const text = formatPluginList(registry)
    expect(text).toContain('BUILTIN')
    expect(text).toContain('PROJECT')
  })

  it('shows status icons', () => {
    makePluginDir(dir, 'enabled', { enabled: true })
    makePluginDir(dir, 'disabled', { enabled: false })
    const registry = loadPlugins(dir)
    const text = formatPluginList(registry)
    expect(text).toContain('✓')
    expect(text).toContain('✗')
  })

  it('shows missing dependencies', () => {
    makePluginDir(dir, 'dep', { dependencies: ['missing'] })
    const registry = loadPlugins(dir)
    const text = formatPluginList(registry)
    expect(text).toContain('MISSING DEPENDENCIES')
    expect(text).toContain('missing')
  })
})
