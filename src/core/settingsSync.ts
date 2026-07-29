/**
 * Settings Sync — cross-machine configuration synchronization
 *
 * Lets the user port their ovolv999 configuration between machines via
 * a portable bundle. The bundle is a JSON snapshot of global config,
 * settings, profiles, permission rules, and slash-command aliases.
 * Optionally encrypted with a passphrase (AES-256-GCM via the keychain
 * module) so it's safe to store in a public gist / git repo.
 *
 * Two transports:
 *   1. Git-backed: push to / pull from a dedicated repo branch
 *   2. File: write / read a local bundle file (manual sync via Dropbox,
 *      USB, etc.)
 *
 * Usage:
 *   syncPush({ transport: 'git', repo, encrypt }) → writes bundle
 *   syncPull({ transport: 'git', repo, passphrase }) → applies bundle
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir, hostname } from 'os'
import { execSync } from 'child_process'
import { randomBytes, createHash, createCipheriv, createDecipheriv, scryptSync } from 'crypto'
import { warnConfigOnce } from '../config/diagnostics.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface SettingsBundle {
  version: 1
  createdAt: string
  hostname: string
  config?: unknown
  settings?: unknown
  profiles?: Record<string, unknown>
  permissionRules?: unknown
  aliases?: Record<string, unknown>
  hooks?: unknown
  /** Schema hash for compatibility checking */
  schemaHash: string
}

export type SyncTransport = 'git' | 'file'

export interface SyncPushOptions {
  transport: SyncTransport
  /** For git transport: repo URL */
  repo?: string
  /** For git transport: branch (default: 'ovolv999-sync') */
  branch?: string
  /** For file transport: output path */
  filePath?: string
  /** Encrypt with a passphrase (recommended for git transport) */
  passphrase?: string
  /** Skip encryption even if passphrase available */
  noEncrypt?: boolean
}

export interface SyncPullOptions {
  transport: SyncTransport
  repo?: string
  branch?: string
  filePath?: string
  passphrase?: string
  /** Dry-run: show what would change without applying */
  dryRun?: boolean
  /** Overwrite local changes instead of merging */
  force?: boolean
}

export interface SyncResult {
  success: boolean
  message: string
  bundle?: SettingsBundle
  applied?: boolean
  warnings: string[]
}

// ── Bundle Assembly ─────────────────────────────────────────────────────────

function getOvolv999Dir(): string {
  return join(homedir(), '.ovolv999')
}

function safeReadJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (err) {
    warnConfigOnce({
      file: path, severity: 'warning',
      message: `settings file corrupt — skipped for sync bundle (${(err as Error).message.split('\n')[0]})`,
      fix: `fix or remove "${path}"`,
    })
    return undefined
  }
}

export function collectBundle(): SettingsBundle {
  const dir = getOvolv999Dir()
  const bundle: SettingsBundle = {
    version: 1,
    createdAt: new Date().toISOString(),
    hostname: hostname(),
    schemaHash: '',
  }

  // Global config
  const config = safeReadJson(join(dir, 'config.json'))
  if (config) bundle.config = config

  // Settings
  const settings = safeReadJson(join(dir, 'settings.json'))
  if (settings) bundle.settings = settings

  // Profiles
  const profiles = safeReadJson<Record<string, unknown>>(join(dir, 'profiles.json'))
  if (profiles) bundle.profiles = profiles

  // Permission rules
  const permRules = safeReadJson(join(dir, 'permission-rules.json'))
  if (permRules) bundle.permissionRules = permRules

  // Aliases
  const aliases = safeReadJson<Record<string, unknown>>(join(dir, 'aliases.json'))
  if (aliases) bundle.aliases = aliases

  // Hooks
  const hooks = safeReadJson(join(dir, 'hooks.json'))
  if (hooks) bundle.hooks = hooks

  bundle.schemaHash = hashBundle(bundle)
  return bundle
}

export function hashBundle(bundle: SettingsBundle): string {
  const data = JSON.stringify({
    version: bundle.version,
    hasConfig: !!bundle.config,
    hasSettings: !!bundle.settings,
    hasProfiles: !!bundle.profiles,
    hasPermissions: !!bundle.permissionRules,
    hasAliases: !!bundle.aliases,
    hasHooks: !!bundle.hooks,
  })
  return createHash('sha256').update(data).digest('hex').slice(0, 16)
}

// ── Bundle Application ──────────────────────────────────────────────────────

export function applyBundle(bundle: SettingsBundle, opts: { force?: boolean } = {}): { applied: boolean; warnings: string[] } {
  const dir = getOvolv999Dir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const warnings: string[] = []

  // Schema compatibility
  const currentHash = hashBundle(bundle)
  if (currentHash !== bundle.schemaHash) {
    warnings.push('Schema hash mismatch — bundle may be from a different version')
    if (!opts.force) {
      return { applied: false, warnings }
    }
  }

  if (bundle.config) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(bundle.config, null, 2))
  }
  if (bundle.settings) {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(bundle.settings, null, 2))
  }
  if (bundle.profiles) {
    writeFileSync(join(dir, 'profiles.json'), JSON.stringify(bundle.profiles, null, 2))
  }
  if (bundle.permissionRules) {
    writeFileSync(join(dir, 'permission-rules.json'), JSON.stringify(bundle.permissionRules, null, 2))
  }
  if (bundle.aliases) {
    writeFileSync(join(dir, 'aliases.json'), JSON.stringify(bundle.aliases, null, 2))
  }
  if (bundle.hooks) {
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify(bundle.hooks, null, 2))
  }

  return { applied: true, warnings }
}

// ── Encryption ──────────────────────────────────────────────────────────────

const SALT = 'ovolv999-settings-sync-v1'
const KEY_LEN = 32
const IV_LEN = 12

function deriveKey(passphrase: string): Buffer {
  return scryptSync(passphrase, SALT, KEY_LEN)
}

export function encryptBundle(bundle: SettingsBundle, passphrase: string): string {
  const key = deriveKey(passphrase)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = JSON.stringify(bundle)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // Format: base64(iv | tag | ciphertext)
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

export function decryptBundle(encoded: string, passphrase: string): SettingsBundle {
  const buf = Buffer.from(encoded, 'base64')
  if (buf.length < IV_LEN + 16) throw new Error('Invalid encrypted bundle (too short)')
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + 16)
  const ciphertext = buf.subarray(IV_LEN + 16)
  const key = deriveKey(passphrase)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(decrypted.toString('utf8')) as SettingsBundle
}

// ── Push ────────────────────────────────────────────────────────────────────

export function syncPush(options: SyncPushOptions): SyncResult {
  const bundle = collectBundle()
  let payload: string

  if (options.passphrase && !options.noEncrypt) {
    payload = encryptBundle(bundle, options.passphrase)
  } else {
    payload = JSON.stringify(bundle, null, 2)
  }

  switch (options.transport) {
    case 'file':
      return pushToFile(payload, options, bundle)
    case 'git':
      return pushToGit(payload, options, bundle)
    default:
      return { success: false, message: `Unknown transport: ${String(options.transport)}`, warnings: [] }
  }
}

function pushToFile(payload: string, options: SyncPushOptions, bundle: SettingsBundle): SyncResult {
  if (!options.filePath) {
    return { success: false, message: 'filePath is required for file transport', warnings: [] }
  }
  try {
    const dir = join(options.filePath, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(options.filePath, payload)
    return {
      success: true,
      message: `Bundle written to ${options.filePath}`,
      bundle,
      applied: false,
      warnings: [],
    }
  } catch (err) {
    return { success: false, message: `Write failed: ${(err as Error).message}`, warnings: [] }
  }
}

function pushToGit(payload: string, options: SyncPushOptions, bundle: SettingsBundle): SyncResult {
  if (!options.repo) {
    return { success: false, message: 'repo is required for git transport', warnings: [] }
  }
  const branch = options.branch ?? 'ovolv999-sync'
  const tmpDir = join(getOvolv999Dir(), 'sync-tmp')
  try {
    // Clean + clone
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
    execSync(`git clone --depth 1 ${shellQuote(options.repo)} ${shellQuote(tmpDir)} 2>&1`, {
      stdio: 'pipe', timeout: 30000,
    })
    // Write payload
    writeFileSync(join(tmpDir, 'ovolv999-bundle.json'), payload)
    // Commit + push
    execSync(`git checkout -b ${shellQuote(branch)} 2>/dev/null || git checkout ${shellQuote(branch)}`, {
      cwd: tmpDir, stdio: 'pipe', timeout: 5000,
    })
    execSync('git add ovolv999-bundle.json && git commit -m "ovolv999 settings sync"', {
      cwd: tmpDir, stdio: 'pipe', timeout: 10000,
    })
    execSync(`git push origin ${shellQuote(branch)} 2>&1`, {
      cwd: tmpDir, stdio: 'pipe', timeout: 30000,
    })
    return {
      success: true,
      message: `Bundle pushed to ${options.repo} (${branch})`,
      bundle,
      applied: false,
      warnings: [],
    }
  } catch (err) {
    return { success: false, message: `Git push failed: ${(err as Error).message}`, warnings: [] }
  } finally {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ── Pull ────────────────────────────────────────────────────────────────────

export function syncPull(options: SyncPullOptions): SyncResult {
  let payload: string

  switch (options.transport) {
    case 'file':
      if (!options.filePath) {
        return { success: false, message: 'filePath is required for file transport', warnings: [] }
      }
      if (!existsSync(options.filePath)) {
        return { success: false, message: `Bundle not found: ${options.filePath}`, warnings: [] }
      }
      payload = readFileSync(options.filePath, 'utf8')
      break

    case 'git': {
      if (!options.repo) {
        return { success: false, message: 'repo is required for git transport', warnings: [] }
      }
      const fetched = fetchFromGit(options.repo, options.branch ?? 'ovolv999-sync')
      if (!fetched) {
        return { success: false, message: 'Failed to fetch bundle from git', warnings: [] }
      }
      payload = fetched
      break
    }
    default:
      return { success: false, message: `Unknown transport: ${String(options.transport)}`, warnings: [] }
  }

  // Decrypt / parse
  let bundle: SettingsBundle
  try {
    if (options.passphrase) {
      bundle = decryptBundle(payload, options.passphrase)
    } else {
      // Try plaintext first; if it fails, it may be encrypted
      try {
        bundle = JSON.parse(payload) as SettingsBundle
      } catch {
        return { success: false, message: 'Bundle appears encrypted — provide a passphrase', warnings: [] }
      }
    }
  } catch (err) {
    return { success: false, message: `Decrypt failed: ${(err as Error).message}`, warnings: [] }
  }

  if (options.dryRun) {
    return {
      success: true,
      message: 'Dry run — bundle fetched but not applied',
      bundle,
      applied: false,
      warnings: [],
    }
  }

  const result = applyBundle(bundle, { force: options.force })
  return {
    success: result.applied,
    message: result.applied ? 'Bundle applied successfully' : 'Bundle not applied (schema mismatch — use force)',
    bundle,
    applied: result.applied,
    warnings: result.warnings,
  }
}

function fetchFromGit(repo: string, branch: string): string | null {
  const tmpDir = join(getOvolv999Dir(), 'sync-tmp')
  try {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
    execSync(`git clone --depth 1 -b ${shellQuote(branch)} ${shellQuote(repo)} ${shellQuote(tmpDir)} 2>&1`, {
      stdio: 'pipe', timeout: 30000,
    })
    const bundlePath = join(tmpDir, 'ovolv999-bundle.json')
    if (!existsSync(bundlePath)) return null
    return readFileSync(bundlePath, 'utf8')
  } catch {
    return null
  } finally {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ── Status / Diff ───────────────────────────────────────────────────────────

export interface SyncStatus {
  hasLocalConfig: boolean
  hasLocalSettings: boolean
  bundleKeys: string[]
  lastSyncAt?: string
}

export function getSyncStatus(): SyncStatus {
  const dir = getOvolv999Dir()
  const keys: string[] = []
  for (const f of ['config.json', 'settings.json', 'profiles.json', 'permission-rules.json', 'aliases.json', 'hooks.json']) {
    if (existsSync(join(dir, f))) keys.push(f)
  }
  const syncMeta = safeReadJson<{ lastSyncAt?: string }>(join(dir, 'sync-meta.json'))
  return {
    hasLocalConfig: keys.includes('config.json'),
    hasLocalSettings: keys.includes('settings.json'),
    bundleKeys: keys,
    lastSyncAt: syncMeta?.lastSyncAt,
  }
}

export function diffBundles(local: SettingsBundle, remote: SettingsBundle): string[] {
  const diffs: string[] = []
  const sections: Array<{ key: keyof SettingsBundle; label: string }> = [
    { key: 'config', label: 'config' },
    { key: 'settings', label: 'settings' },
    { key: 'profiles', label: 'profiles' },
    { key: 'permissionRules', label: 'permission rules' },
    { key: 'aliases', label: 'aliases' },
    { key: 'hooks', label: 'hooks' },
  ]
  for (const { key, label } of sections) {
    const lv = JSON.stringify(local[key])
    const rv = JSON.stringify(remote[key])
    if (lv !== rv) {
      diffs.push(`  ${label}: ${lv === rv ? 'same' : 'different'}`)
    }
  }
  return diffs
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatBundle(bundle: SettingsBundle): string {
  const lines = [
    `Settings Bundle:`,
    `  Version: ${bundle.version}`,
    `  Created: ${bundle.createdAt}`,
    `  Host: ${bundle.hostname}`,
    `  Schema: ${bundle.schemaHash}`,
    '',
    'Contents:',
  ]
  if (bundle.config) lines.push('  ✓ config.json')
  if (bundle.settings) lines.push('  ✓ settings.json')
  if (bundle.profiles) lines.push(`  ✓ profiles.json (${Object.keys(bundle.profiles).length} profiles)`)
  if (bundle.permissionRules) lines.push('  ✓ permission-rules.json')
  if (bundle.aliases) lines.push(`  ✓ aliases.json (${Object.keys(bundle.aliases).length} aliases)`)
  if (bundle.hooks) lines.push('  ✓ hooks.json')
  return lines.join('\n')
}

export function formatSyncStatus(status: SyncStatus): string {
  const lines = ['Settings Sync Status:', `  Local files: ${status.bundleKeys.join(', ') || 'none'}`]
  if (status.lastSyncAt) lines.push(`  Last sync: ${status.lastSyncAt}`)
  return lines.join('\n')
}

export function formatSyncResult(result: SyncResult): string {
  const lines = [result.message]
  if (result.bundle) lines.push('', formatBundle(result.bundle))
  if (result.warnings.length > 0) {
    lines.push('', 'Warnings:')
    for (const w of result.warnings) lines.push(`  ⚠ ${w}`)
  }
  return lines.join('\n')
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_:.@/-]+$/.test(s)) return s
  return `'${s.replace(/'/g, "'\\''")}'`
}
