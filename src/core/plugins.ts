/**
 * Plugin System — extensible architecture for custom tools, commands, and hooks.
 *
 * Plugins are directories under `.ovolv999/plugins/<name>/` containing:
 *   - plugin.json  (required manifest)
 *   - tools.js     (optional — exports tool definitions)
 *   - commands.js  (optional — exports slash command definitions)
 *   - hooks.js     (optional — exports hook handlers)
 *
 * Plugin manifest (plugin.json):
 * {
 *   "name": "my-plugin",
 *   "version": "1.0.0",
 *   "description": "Does cool stuff",
 *   "author": "me",
 *   "enabled": true,
 *   "provides": {
 *     "tools": ["tools.js"],
 *     "commands": ["commands.js"],
 *     "hooks": ["hooks.js"]
 *   }
 * }
 *
 * Built-in plugins are registered via registerBuiltinPlugin() at startup.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'

// ── Types ───────────────────────────────────────────────────────────────────

export interface PluginManifest {
  name: string
  version: string
  description?: string
  author?: string
  /** Whether the plugin is enabled (default: true) */
  enabled?: boolean
  /** Plugin provides declarations */
  provides?: {
    tools?: string[]
    commands?: string[]
    hooks?: string[]
  }
  /** Plugin dependencies (other plugin names) */
  dependencies?: string[]
  /** Minimum ovolv999 version required */
  minAppVersion?: string
}

export type PluginSource = 'builtin' | 'project' | 'global'

export interface LoadedPlugin {
  /** Unique plugin ID (name@source) */
  id: string
  /** Display name */
  name: string
  version: string
  description: string
  author: string
  source: PluginSource
  enabled: boolean
  /** Path to plugin directory (undefined for built-in) */
  path?: string
  manifest: PluginManifest
  /** Validation errors */
  errors: string[]
}

export interface PluginRegistry {
  /** All loaded plugins keyed by ID */
  plugins: Map<string, LoadedPlugin>
  /** Plugins grouped by source */
  bySource: Map<PluginSource, LoadedPlugin[]>
}

// ── Manifest Validation ─────────────────────────────────────────────────────

/**
 * Parse and validate a plugin manifest.
 * Returns null if invalid.
 */
export function validateManifest(data: unknown): PluginManifest | null {
  if (typeof data !== 'object' || data === null) return null
  const obj = data as Record<string, unknown>

  if (typeof obj.name !== 'string' || !obj.name.trim()) return null
  if (typeof obj.version !== 'string' || !obj.version.trim()) return null

  const manifest: PluginManifest = {
    name: obj.name,
    version: obj.version,
  }

  if (typeof obj.description === 'string') manifest.description = obj.description
  if (typeof obj.author === 'string') manifest.author = obj.author
  if (typeof obj.enabled === 'boolean') manifest.enabled = obj.enabled
  if (typeof obj.minAppVersion === 'string') manifest.minAppVersion = obj.minAppVersion

  if (Array.isArray(obj.dependencies)) {
    manifest.dependencies = obj.dependencies.filter((d): d is string => typeof d === 'string')
  }

  if (typeof obj.provides === 'object' && obj.provides !== null) {
    const p = obj.provides as Record<string, unknown>
    manifest.provides = {}
    if (Array.isArray(p.tools)) {
      manifest.provides.tools = p.tools.filter((t): t is string => typeof t === 'string')
    }
    if (Array.isArray(p.commands)) {
      manifest.provides.commands = p.commands.filter((c): c is string => typeof c === 'string')
    }
    if (Array.isArray(p.hooks)) {
      manifest.provides.hooks = p.hooks.filter((h): h is string => typeof h === 'string')
    }
  }

  return manifest
}

/** Parse a plugin.json file */
export function parseManifest(raw: string): PluginManifest | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return validateManifest(parsed)
  } catch {
    return null
  }
}

// ── Built-in Plugins ────────────────────────────────────────────────────────

const BUILTIN_PLUGINS = new Map<string, PluginManifest>()

/**
 * Register a built-in plugin manifest.
 */
export function registerBuiltinPlugin(manifest: PluginManifest): void {
  BUILTIN_PLUGINS.set(manifest.name, manifest)
}

/**
 * Get all registered built-in plugins.
 */
export function getBuiltinPlugins(): PluginManifest[] {
  return [...BUILTIN_PLUGINS.values()]
}

/**
 * Clear all built-in plugins (for testing).
 */
export function _clearBuiltinPlugins(): void {
  BUILTIN_PLUGINS.clear()
}

// ── Plugin Discovery ────────────────────────────────────────────────────────

const PLUGIN_DIR = '.ovolv999/plugins'
const GLOBAL_PLUGIN_DIR = '.ovolv999/plugins' // relative to home

/**
 * Discover and load all plugins from project and global directories.
 */
export function loadPlugins(cwd: string, homeDir?: string): PluginRegistry {
  const plugins = new Map<string, LoadedPlugin>()
  const bySource = new Map<PluginSource, LoadedPlugin[]>([
    ['builtin', []],
    ['project', []],
    ['global', []],
  ])

  // 1. Load built-in plugins
  for (const manifest of BUILTIN_PLUGINS.values()) {
    const plugin: LoadedPlugin = {
      id: `${manifest.name}@builtin`,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description ?? '',
      author: manifest.author ?? 'built-in',
      source: 'builtin',
      enabled: manifest.enabled !== false,
      manifest,
      errors: [],
    }
    plugins.set(plugin.id, plugin)
    bySource.get('builtin')!.push(plugin)
  }

  // 2. Load project plugins from .ovolv999/plugins/
  const projectPluginDir = join(resolve(cwd), PLUGIN_DIR)
  loadPluginsFromDir(projectPluginDir, 'project', plugins, bySource)

  // 3. Load global plugins from ~/.ovolv999/plugins/
  if (homeDir) {
    const globalPluginDir = join(homeDir, GLOBAL_PLUGIN_DIR)
    loadPluginsFromDir(globalPluginDir, 'global', plugins, bySource)
  }

  return { plugins, bySource }
}

function loadPluginsFromDir(
  dir: string,
  source: PluginSource,
  plugins: Map<string, LoadedPlugin>,
  bySource: Map<PluginSource, LoadedPlugin[]>,
): void {
  if (!existsSync(dir)) return

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  for (const entry of entries) {
    const pluginPath = join(dir, entry)
    let stat
    try { stat = statSync(pluginPath) } catch { continue }
    if (!stat.isDirectory()) continue

    const manifestPath = join(pluginPath, 'plugin.json')
    if (!existsSync(manifestPath)) continue

    const errors: string[] = []
    let manifest: PluginManifest | null = null

    try {
      const raw = readFileSync(manifestPath, 'utf8')
      manifest = parseManifest(raw)
      if (!manifest) {
        errors.push('Invalid plugin.json manifest')
      }
    } catch (err) {
      errors.push(`Failed to read manifest: ${(err as Error).message}`)
    }

    if (!manifest) {
      const failedPlugin: LoadedPlugin = {
        id: `${entry}@${source}`,
        name: entry,
        version: '0.0.0',
        description: '',
        author: '',
        source,
        enabled: false,
        path: pluginPath,
        manifest: { name: entry, version: '0.0.0' },
        errors,
      }
      plugins.set(failedPlugin.id, failedPlugin)
      bySource.get(source)!.push(failedPlugin)
      continue
    }

    // Verify provided files exist
    if (manifest.provides) {
      if (manifest.provides.tools) {
        for (const toolFile of manifest.provides.tools) {
          if (!existsSync(join(pluginPath, toolFile))) {
            errors.push(`Missing tools file: ${toolFile}`)
          }
        }
      }
      if (manifest.provides.commands) {
        for (const cmdFile of manifest.provides.commands) {
          if (!existsSync(join(pluginPath, cmdFile))) {
            errors.push(`Missing commands file: ${cmdFile}`)
          }
        }
      }
      if (manifest.provides.hooks) {
        for (const hookFile of manifest.provides.hooks) {
          if (!existsSync(join(pluginPath, hookFile))) {
            errors.push(`Missing hooks file: ${hookFile}`)
          }
        }
      }
    }

    const plugin: LoadedPlugin = {
      id: `${manifest.name}@${source}`,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description ?? '',
      author: manifest.author ?? 'unknown',
      source,
      enabled: manifest.enabled !== false,
      path: pluginPath,
      manifest,
      errors,
    }
    plugins.set(plugin.id, plugin)
    bySource.get(source)!.push(plugin)
  }
}

// ── Plugin Operations ───────────────────────────────────────────────────────

/**
 * Enable a plugin by updating its manifest.
 */
export function enablePlugin(cwd: string, pluginId: string): { success: boolean; error?: string } {
  // Round 41 audit fix: pass homeDir so @global plugins (listed with
  // home by /plugins) are actually operable — the registry used to load
  // project-only and "not found" every global entry.
  const registry = loadPlugins(cwd, homedir())
  const plugin = registry.plugins.get(pluginId)
  if (!plugin) {
    return { success: false, error: `Plugin "${pluginId}" not found` }
  }
  if (plugin.source === 'builtin') {
    return { success: false, error: 'Cannot enable/disable built-in plugins via filesystem' }
  }
  if (!plugin.path) {
    return { success: false, error: 'Plugin path not available' }
  }

  const manifestPath = join(plugin.path, 'plugin.json')
  try {
    const manifest = { ...plugin.manifest, enabled: true }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    return { success: true }
  } catch (err) {
    return { success: false, error: `Failed to enable: ${(err as Error).message}` }
  }
}

/**
 * Disable a plugin by updating its manifest.
 */
export function disablePlugin(cwd: string, pluginId: string): { success: boolean; error?: string } {
  const registry = loadPlugins(cwd, homedir())
  const plugin = registry.plugins.get(pluginId)
  if (!plugin) {
    return { success: false, error: `Plugin "${pluginId}" not found` }
  }
  if (plugin.source === 'builtin') {
    return { success: false, error: 'Cannot enable/disable built-in plugins via filesystem' }
  }
  if (!plugin.path) {
    return { success: false, error: 'Plugin path not available' }
  }

  const manifestPath = join(plugin.path, 'plugin.json')
  try {
    const manifest = { ...plugin.manifest, enabled: false }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    return { success: true }
  } catch (err) {
    return { success: false, error: `Failed to disable: ${(err as Error).message}` }
  }
}

/**
 * Get only enabled plugins.
 */
export function getEnabledPlugins(cwd: string, homeDir?: string): LoadedPlugin[] {
  const registry = loadPlugins(cwd, homeDir)
  return [...registry.plugins.values()].filter(p => p.enabled && p.errors.length === 0)
}

/**
 * Create a new plugin scaffold.
 */
export function createPluginScaffold(
  cwd: string,
  name: string,
  options: { description?: string; tools?: boolean; commands?: boolean } = {},
): string {
  const pluginDir = join(resolve(cwd), PLUGIN_DIR, name)
  mkdirSync(pluginDir, { recursive: true })

  const manifest: PluginManifest = {
    name,
    version: '0.1.0',
    description: options.description ?? `${name} plugin`,
    enabled: true,
    provides: {},
  }

  if (options.tools) {
    manifest.provides!.tools = ['tools.js']
    const toolsContent = `// ${name} plugin tools\n// Export an array of Tool objects\nexport const tools = []\n`
    writeFileSync(join(pluginDir, 'tools.js'), toolsContent, 'utf8')
  }

  if (options.commands) {
    manifest.provides!.commands = ['commands.js']
    const cmdsContent = `// ${name} plugin commands\n// Export an array of Command objects\nexport const commands = []\n`
    writeFileSync(join(pluginDir, 'commands.js'), cmdsContent, 'utf8')
  }

  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8')

  return pluginDir
}

// ── Dependency Resolution ───────────────────────────────────────────────────

/**
 * Check if all plugin dependencies are satisfied.
 * Returns a map of plugin ID → missing dependencies.
 */
export function checkDependencies(registry: PluginRegistry): Map<string, string[]> {
  const result = new Map<string, string[]>()
  const allNames = new Set([...registry.plugins.values()].map(p => p.name))

  for (const [id, plugin] of registry.plugins) {
    if (!plugin.manifest.dependencies || plugin.manifest.dependencies.length === 0) continue
    const missing = plugin.manifest.dependencies.filter(dep => !allNames.has(dep))
    if (missing.length > 0) {
      result.set(id, missing)
    }
  }

  return result
}

// ── Formatting ──────────────────────────────────────────────────────────────

/**
 * Format the plugin registry as human-readable text.
 */
export function formatPluginList(registry: PluginRegistry): string {
  const lines: string[] = ['Plugins:', '']

  for (const source of ['builtin', 'project', 'global'] as PluginSource[]) {
    const plugins = registry.bySource.get(source) ?? []
    if (plugins.length === 0) continue

    lines.push(`── ${source.toUpperCase()} ──`)
    for (const p of plugins) {
      const status = p.enabled ? (p.errors.length > 0 ? '⚠' : '✓') : '✗'
      const version = `v${p.version}`
      const desc = p.description ? ` — ${p.description}` : ''
      lines.push(`  ${status} ${p.name.padEnd(20)} ${version.padEnd(12)}${desc}`)
      for (const err of p.errors) {
        lines.push(`      ${err}`)
      }
    }
    lines.push('')
  }

  // Dependency check
  const depIssues = checkDependencies(registry)
  if (depIssues.size > 0) {
    lines.push('── MISSING DEPENDENCIES ──')
    for (const [id, missing] of depIssues) {
      lines.push(`  ${id}: needs ${missing.join(', ')}`)
    }
    lines.push('')
  }

  const total = registry.plugins.size
  const enabled = [...registry.plugins.values()].filter(p => p.enabled).length
  lines.push(`Total: ${total} (${enabled} enabled)`)

  return lines.join('\n')
}
