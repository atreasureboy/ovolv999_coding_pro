import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  loadManifest,
  discoverPlugins,
  getRegistry,
  resetRegistry,
  loadPlugins,
  enablePlugin,
  disablePlugin,
  getPlugin,
  listPlugins,
  listEnabledPlugins,
  installPlugin,
  uninstallPlugin,
  formatPlugin,
  formatPluginList,
  type PluginManifest,
} from '../src/core/pluginManager.js'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let testDir: string
let origHome: string | undefined

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'ovolv999-plugins-'))
  origHome = process.env.HOME
  process.env.HOME = testDir
})

beforeEach(() => {
  resetRegistry()
  // Clean plugins dir
  const pluginsDir = join(testDir, '.ovolv999', 'plugins')
  if (existsSync(pluginsDir)) {
    rmSync(pluginsDir, { recursive: true, force: true })
  }
  mkdirSync(pluginsDir, { recursive: true })
})

afterAll(() => {
  if (origHome !== undefined) process.env.HOME = origHome
  rmSync(testDir, { recursive: true, force: true })
})

function makePlugin(name: string, manifest: Partial<PluginManifest> = {}): string {
  const pluginDir = join(testDir, '.ovolv999', 'plugins', name)
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      description: `Test plugin ${name}`,
      ...manifest,
    }),
  )
  return pluginDir
}

describe('pluginManager', () => {
  describe('loadManifest', () => {
    it('loads plugin.json', () => {
      const dir = mkdtempSync(join(tmpdir(), 'plugin-test-'))
      try {
        writeFileSync(
          join(dir, 'plugin.json'),
          JSON.stringify({ name: 'test', version: '1.0.0' }),
        )
        const m = loadManifest(dir)
        expect(m).toBeTruthy()
        expect(m!.name).toBe('test')
        expect(m!.version).toBe('1.0.0')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('loads from package.json with ovolv999 field', () => {
      const dir = mkdtempSync(join(tmpdir(), 'plugin-test-'))
      try {
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({
            name: 'my-pkg',
            version: '2.0.0',
            ovolv999: { tools: ['Foo'] },
          }),
        )
        const m = loadManifest(dir)
        expect(m).toBeTruthy()
        expect(m!.name).toBe('my-pkg')
        expect(m!.tools).toEqual(['Foo'])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('returns null for non-plugin package', () => {
      const dir = mkdtempSync(join(tmpdir(), 'plugin-test-'))
      try {
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({ name: 'regular-pkg', version: '1.0.0' }),
        )
        expect(loadManifest(dir)).toBeNull()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('returns null for directory without manifest', () => {
      const dir = mkdtempSync(join(tmpdir(), 'plugin-test-'))
      try {
        expect(loadManifest(dir)).toBeNull()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('discoverPlugins', () => {
    it('discovers plugins in plugins directory', () => {
      makePlugin('alpha')
      makePlugin('beta')
      const plugins = discoverPlugins()
      expect(plugins).toHaveLength(2)
      expect(plugins.map(p => p.manifest.name).sort()).toEqual(['alpha', 'beta'])
    })

    it('returns empty when no plugins', () => {
      const plugins = discoverPlugins()
      expect(plugins).toHaveLength(0)
    })
  })

  describe('registry operations', () => {
    it('loads plugins into registry', () => {
      makePlugin('alpha')
      const plugins = loadPlugins()
      expect(plugins).toHaveLength(1)
      expect(plugins[0].status).toBe('disabled')
    })

    it('enables and disables plugins', () => {
      makePlugin('alpha')
      loadPlugins()

      const enabled = enablePlugin('alpha')
      expect(enabled!.status).toBe('enabled')

      const disabled = disablePlugin('alpha')
      expect(disabled!.status).toBe('disabled')
    })

    it('persists enabled state', () => {
      makePlugin('alpha')
      loadPlugins()
      enablePlugin('alpha')

      resetRegistry()
      loadPlugins()
      // Should reload from disk
      const plugins = listPlugins()
      expect(plugins[0].status).toBe('enabled')
    })

    it('getPlugin returns by name', () => {
      makePlugin('alpha')
      loadPlugins()
      expect(getPlugin('alpha')).toBeDefined()
      expect(getPlugin('nonexistent')).toBeUndefined()
    })

    it('listPlugins returns all', () => {
      makePlugin('a')
      makePlugin('b')
      loadPlugins()
      expect(listPlugins()).toHaveLength(2)
    })

    it('listEnabledPlugins filters', () => {
      makePlugin('a')
      makePlugin('b')
      loadPlugins()
      enablePlugin('a')
      const enabled = listEnabledPlugins()
      expect(enabled).toHaveLength(1)
      expect(enabled[0].manifest.name).toBe('a')
    })
  })

  describe('install/uninstall', () => {
    it('installs from local directory', () => {
      const sourceDir = mkdtempSync(join(tmpdir(), 'plugin-src-'))
      try {
        writeFileSync(
          join(sourceDir, 'plugin.json'),
          JSON.stringify({ name: 'installed', version: '1.0.0' }),
        )
        const result = installPlugin({ from: 'local', source: sourceDir })
        expect(result.success).toBe(true)
        expect(result.pluginName).toBe('installed')
      } finally {
        rmSync(sourceDir, { recursive: true, force: true })
      }
    })

    it('fails for invalid source', () => {
      const result = installPlugin({ from: 'local', source: '/nonexistent' })
      expect(result.success).toBe(false)
    })

    it('uninstalls existing plugin', () => {
      makePlugin('removable')
      loadPlugins()
      const result = uninstallPlugin('removable')
      expect(result.success).toBe(true)
      expect(getPlugin('removable')).toBeUndefined()
    })

    it('uninstall fails for non-existent', () => {
      loadPlugins()
      const result = uninstallPlugin('nonexistent')
      expect(result.success).toBe(false)
    })
  })

  describe('formatting', () => {
    it('formats plugin list', () => {
      makePlugin('alpha', { description: 'Alpha plugin' })
      loadPlugins()
      const out = formatPluginList(listPlugins())
      expect(out).toContain('alpha')
      expect(out).toContain('Alpha plugin')
    })

    it('formats empty plugin list', () => {
      const out = formatPluginList([])
      expect(out).toContain('No plugins')
    })

    it('formats single plugin details', () => {
      makePlugin('detailed', {
        description: 'A detailed plugin',
        author: 'Test Author',
        tools: ['Tool1', 'Tool2'],
        commands: ['/foo'],
      })
      loadPlugins()
      const plugin = getPlugin('detailed')!
      const out = formatPlugin(plugin)
      expect(out).toContain('detailed')
      expect(out).toContain('A detailed plugin')
      expect(out).toContain('Test Author')
      expect(out).toContain('Tool1')
      expect(out).toContain('/foo')
    })
  })
})
