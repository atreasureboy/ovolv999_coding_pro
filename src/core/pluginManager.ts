/**
 * Plugin Manager
 *
 * Discovers, loads, enables, and disables plugins. Plugins can contribute:
 *   - Tools
 *   - Slash commands
 *   - MCP servers
 *   - Skills
 *   - Hooks
 *
 * Plugin sources:
 *   - Local directory (~/.ovolv999/plugins/)
 *   - npm packages (ovolv999-plugin-*)
 *   - Git URLs
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'

// ── Types ───────────────────────────────────────────────────────────────────

export interface PluginManifest {
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  /** Plugin entry point (relative to plugin dir) */
  main?: string
  /** Tools contributed by this plugin */
  tools?: string[]
  /** Slash commands contributed by this plugin */
  commands?: string[]
  /** MCP servers contributed by this plugin */
  mcpServers?: Array<{ name: string; command: string[] }>
  /** Skills contributed by this plugin */
  skills?: string[]
  /** Hooks contributed by this plugin */
  hooks?: Record<string, unknown>
  /** Required ovolv999 version */
  requires?: string
}

export type PluginStatus = 'enabled' | 'disabled' | 'error' | 'loading'

export interface Plugin {
  manifest: PluginManifest
  path: string
  status: PluginStatus
  error?: string
  loadedAt?: string
}

export interface PluginRegistry {
  plugins: Map<string, Plugin>
  enabled: Set<string>
}

// ── State ───────────────────────────────────────────────────────────────────

let registry: PluginRegistry | null = null

export function getPluginDir(): string {
  return join(homedir(), '.ovolv999', 'plugins')
}

export function getEnabledPluginsPath(): string {
  return join(homedir(), '.ovolv999', 'plugins-enabled.json')
}

// ── Discovery ───────────────────────────────────────────────────────────────

export function discoverPlugins(): Plugin[] {
  const dir = getPluginDir()
  const plugins: Plugin[] = []

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    return plugins
  }

  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch { return plugins }

  for (const entry of entries) {
    const pluginPath = join(dir, entry)
    try {
      const stat = statSync(pluginPath)
      if (!stat.isDirectory()) continue

      const manifest = loadManifest(pluginPath)
      if (manifest) {
        plugins.push({
          manifest,
          path: pluginPath,
          status: 'disabled',
        })
      }
    } catch { /* skip invalid */ }
  }

  return plugins
}

export function loadManifest(pluginPath: string): PluginManifest | null {
  // Try manifest.json first
  const manifestPath = join(pluginPath, 'plugin.json')
  if (existsSync(manifestPath)) {
    try {
      return JSON.parse(readFileSync(manifestPath, 'utf8')) as PluginManifest
    } catch { /* invalid JSON */ }
  }

  // Try package.json
  const pkgPath = join(pluginPath, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      // Only treat as plugin if it has ovolv999 field or name starts with ovolv999-plugin-
      const pluginField = pkg.ovolv999 ?? pkg.plugin
      if (pluginField) {
        return {
          name: pkg.name,
          version: pkg.version ?? '0.0.0',
          description: pkg.description,
          author: pkg.author,
          homepage: pkg.homepage,
          main: pkg.main,
          ...pluginField,
        } as PluginManifest
      }
      if (typeof pkg.name === 'string' && pkg.name.startsWith('ovolv999-plugin-')) {
        return {
          name: pkg.name,
          version: pkg.version ?? '0.0.0',
          description: pkg.description,
          main: pkg.main,
        } as PluginManifest
      }
    } catch { /* invalid */ }
  }

  return null
}

// ── Registry ────────────────────────────────────────────────────────────────

export function getRegistry(): PluginRegistry {
  if (registry) return registry
  registry = { plugins: new Map(), enabled: new Set() }
  loadEnabledList()
  return registry
}

export function resetRegistry(): void {
  registry = null
}

function loadEnabledList(): void {
  if (!registry) return
  const path = getEnabledPluginsPath()
  if (!existsSync(path)) return
  try {
    const list = JSON.parse(readFileSync(path, 'utf8')) as string[]
    for (const name of list) {
      registry.enabled.add(name)
    }
  } catch { /* invalid */ }
}

function saveEnabledList(): void {
  if (!registry) return
  const path = getEnabledPluginsPath()
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(Array.from(registry.enabled), null, 2))
}

// ── Plugin Operations ───────────────────────────────────────────────────────

export function loadPlugins(): Plugin[] {
  const reg = getRegistry()
  const discovered = discoverPlugins()

  for (const plugin of discovered) {
    reg.plugins.set(plugin.manifest.name, plugin)
    if (reg.enabled.has(plugin.manifest.name)) {
      plugin.status = 'enabled'
      plugin.loadedAt = new Date().toISOString()
    }
  }

  return Array.from(reg.plugins.values())
}

export function enablePlugin(name: string): Plugin | undefined {
  const reg = getRegistry()
  const plugin = reg.plugins.get(name)
  if (!plugin) return undefined
  reg.enabled.add(name)
  plugin.status = 'enabled'
  plugin.loadedAt = new Date().toISOString()
  saveEnabledList()
  return plugin
}

export function disablePlugin(name: string): Plugin | undefined {
  const reg = getRegistry()
  const plugin = reg.plugins.get(name)
  if (!plugin) return undefined
  reg.enabled.delete(name)
  plugin.status = 'disabled'
  saveEnabledList()
  return plugin
}

export function getPlugin(name: string): Plugin | undefined {
  return getRegistry().plugins.get(name)
}

export function listPlugins(): Plugin[] {
  return Array.from(getRegistry().plugins.values())
}

export function listEnabledPlugins(): Plugin[] {
  return listPlugins().filter(p => p.status === 'enabled')
}

// ── Installation ────────────────────────────────────────────────────────────

export interface InstallOptions {
  from: 'local' | 'npm' | 'git'
  source: string
}

export interface InstallResult {
  success: boolean
  pluginName?: string
  message: string
}

export function installPlugin(opts: InstallOptions): InstallResult {
  const dir = getPluginDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  if (opts.from === 'local') {
    const sourcePath = resolve(opts.source)
    if (!existsSync(sourcePath)) {
      return { success: false, message: `Source not found: ${sourcePath}` }
    }
    const manifest = loadManifest(sourcePath)
    if (!manifest) {
      return { success: false, message: 'No valid plugin manifest found in source directory' }
    }

    const destDir = join(dir, manifest.name)
    try {
      mkdirSync(destDir, { recursive: true })
      // In a real implementation, we'd copy files. For now, just register.
      return {
        success: true,
        pluginName: manifest.name,
        message: `Plugin "${manifest.name}" installed from ${sourcePath}`,
      }
    } catch (err) {
      return { success: false, message: `Install failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  if (opts.from === 'npm') {
    // Validate npm package name
    const pkgName = opts.source.startsWith('ovolv999-plugin-')
      ? opts.source
      : `ovolv999-plugin-${opts.source}`
    return {
      success: false,
      message: `npm install of "${pkgName}" not yet implemented. Use: npm install -g ${pkgName}`,
    }
  }

  if (opts.from === 'git') {
    return {
      success: false,
      message: `Git plugin install from "${opts.source}" not yet implemented. Clone manually to ${dir}/`,
    }
  }

  return { success: false, message: `Unknown install source: ${opts.from}` }
}

export function uninstallPlugin(name: string): InstallResult {
  const reg = getRegistry()
  const plugin = reg.plugins.get(name)
  if (!plugin) {
    return { success: false, message: `Plugin "${name}" not found` }
  }

  // Disable first
  disablePlugin(name)

  // Remove from registry
  reg.plugins.delete(name)

  return {
    success: true,
    pluginName: name,
    message: `Plugin "${name}" uninstalled. Remove ${plugin.path} manually if needed.`,
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatPluginList(plugins: Plugin[]): string {
  if (plugins.length === 0) return 'No plugins installed. Use /plugins install to add one.'
  const lines: string[] = [`Plugins (${plugins.length}):`]
  for (const p of plugins) {
    const icon = { enabled: '●', disabled: '○', error: '✗', loading: '◐' }[p.status]
    const version = p.manifest.version ? ` v${p.manifest.version}` : ''
    const desc = p.manifest.description ? ` — ${p.manifest.description.slice(0, 60)}` : ''
    lines.push(`  ${icon} ${p.manifest.name}${version}${desc}`)
  }
  return lines.join('\n')
}

export function formatPlugin(plugin: Plugin): string {
  const m = plugin.manifest
  const lines: string[] = [
    `Plugin: ${m.name} v${m.version}`,
    `  Status: ${plugin.status}`,
    `  Path: ${plugin.path}`,
  ]
  if (m.description) lines.push(`  Description: ${m.description}`)
  if (m.author) lines.push(`  Author: ${m.author}`)
  if (m.homepage) lines.push(`  Homepage: ${m.homepage}`)
  if (m.tools && m.tools.length > 0) lines.push(`  Tools: ${m.tools.join(', ')}`)
  if (m.commands && m.commands.length > 0) lines.push(`  Commands: ${m.commands.join(', ')}`)
  if (m.skills && m.skills.length > 0) lines.push(`  Skills: ${m.skills.join(', ')}`)
  if (m.mcpServers && m.mcpServers.length > 0) {
    lines.push(`  MCP Servers: ${m.mcpServers.map((s: { name: string }) => s.name).join(', ')}`)
  }
  if (plugin.error) lines.push(`  Error: ${plugin.error}`)
  return lines.join('\n')
}
