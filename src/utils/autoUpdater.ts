/**
 * Auto-Updater
 *
 * Checks for newer versions of ovolv999 on npm.
 * Supports dist-tag tracking (latest/beta/next).
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { atomicWriteSync, preserveCorruptFile } from '../core/atomicWrite.js'
import { join } from 'path'
import { homedir } from 'os'
import { createRequire } from 'module'

// ── Types ───────────────────────────────────────────────────────────────────

export interface VersionInfo {
  current: string
  latest?: string
  beta?: string
  next?: string
  distTag?: string
  updateAvailable: boolean
  betaAvailable: boolean
  isPrerelease: boolean
}

export interface UpdateCheckResult {
  checked: string
  version: VersionInfo
  ignored?: string[]
  error?: string
}

export type UpdateChannel = 'latest' | 'beta' | 'next'

// ── Constants ───────────────────────────────────────────────────────────────

const PACKAGE_NAME = 'ovolv999'
const REGISTRY_URL = 'https://registry.npmjs.org'

// ── Version Helpers ─────────────────────────────────────────────────────────

export function getCurrentVersion(): string {
  try {
    // Resolve our OWN package.json relative to this module — never
    // process.cwd() (which is the USER's project dir when installed
    // globally, and would report a foreign version or 0.0.0).
    const selfRequire = createRequire(import.meta.url)
    const pkg = selfRequire('../../package.json') as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch { /* ignore */ }
  return '0.0.0'
}

export function parseVersion(v: string): { major: number; minor: number; patch: number; prerelease?: string } {
  const match = v.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/)
  if (!match) return { major: 0, minor: 0, patch: 0 }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4],
  }
}

export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (va.major !== vb.major) return va.major - vb.major
  if (va.minor !== vb.minor) return va.minor - vb.minor
  if (va.patch !== vb.patch) return va.patch - vb.patch
  // Prerelease versions are LOWER than non-prerelease
  if (va.prerelease && !vb.prerelease) return -1
  if (!va.prerelease && vb.prerelease) return 1
  if (va.prerelease && vb.prerelease) return va.prerelease.localeCompare(vb.prerelease)
  return 0
}

export function isNewerVersion(current: string, candidate: string): boolean {
  return compareVersions(candidate, current) > 0
}

// ── Registry Check ──────────────────────────────────────────────────────────

interface NpmDistTags {
  latest?: string
  beta?: string
  next?: string
  [key: string]: string | undefined
}

export function fetchDistTags(): NpmDistTags | null {
  try {
    const output = execSync(`npm view ${PACKAGE_NAME} dist-tags --json 2>/dev/null`, {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return JSON.parse(output) as NpmDistTags
  } catch {
    // Try direct fetch
    try {
      const output = execSync(`curl -s ${REGISTRY_URL}/${PACKAGE_NAME}/dist-tags`, {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return JSON.parse(output) as NpmDistTags
    } catch {
      return null
    }
  }
}

export function checkForUpdates(): UpdateCheckResult {
  const current = getCurrentVersion()
  const tags = fetchDistTags()

  if (!tags) {
    return {
      checked: new Date().toISOString(),
      version: {
        current,
        updateAvailable: false,
        betaAvailable: false,
        isPrerelease: parseVersion(current).prerelease !== undefined,
      },
      error: 'Failed to fetch version info from npm registry',
    }
  }

  const latest = tags.latest
  const beta = tags.beta
  const nextTag = tags.next

  const version: VersionInfo = {
    current,
    latest,
    beta,
    next: nextTag,
    updateAvailable: latest ? isNewerVersion(current, latest) : false,
    betaAvailable: beta ? isNewerVersion(current, beta) : false,
    isPrerelease: parseVersion(current).prerelease !== undefined,
  }

  return {
    checked: new Date().toISOString(),
    version,
  }
}

// ── Update Ignoring ─────────────────────────────────────────────────────────

export function getIgnoredVersionsPath(): string {
  return join(homedir(), '.ovolv999', 'ignored-versions.json')
}

export function getIgnoredVersions(): string[] {
  const path = getIgnoredVersionsPath()
  if (!existsSync(path)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) {
      throw new Error('ignored-versions store shape violation')
    }
    return parsed
  } catch {
    preserveCorruptFile(path)
    return []
  }
}

export function ignoreVersion(version: string): void {
  const ignored = getIgnoredVersions()
  if (!ignored.includes(version)) {
    ignored.push(version)
    atomicWriteSync(getIgnoredVersionsPath(), JSON.stringify(ignored, null, 2))
  }
}

export function isVersionIgnored(version: string): boolean {
  return getIgnoredVersions().includes(version)
}

// ── Performing Update ───────────────────────────────────────────────────────

export interface InstallResult {
  success: boolean
  message: string
  newVersion?: string
}

export function performUpdate(channel: UpdateChannel = 'latest'): InstallResult {
  try {
    // Second layer of defense: the UpdateChannel type is only as honest as
    // the caller's cast — the interpolated shell string must not trust it.
    const VALID_CHANNELS: readonly UpdateChannel[] = ['latest', 'beta', 'next']
    if (!VALID_CHANNELS.includes(channel)) {
      return { success: false, message: `Invalid update channel: ${String(channel)}` }
    }
    const tag = channel === 'latest' ? '' : `@${channel}`
    execSync(`npm install -g ${PACKAGE_NAME}${tag} 2>&1`, {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const newVersion = getCurrentVersion()
    return {
      success: true,
      message: `Updated to ${newVersion}`,
      newVersion,
    }
  } catch (err) {
    return {
      success: false,
      message: `Update failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ── Cache ───────────────────────────────────────────────────────────────────

let cachedCheck: UpdateCheckResult | null = null
const CACHE_TTL = 60 * 60 * 1000 // 1 hour

export function getCachedCheck(): UpdateCheckResult | null {
  if (!cachedCheck) return null
  const age = Date.now() - new Date(cachedCheck.checked).getTime()
  if (age > CACHE_TTL) {
    cachedCheck = null
    return null
  }
  return cachedCheck
}

export function setCachedCheck(result: UpdateCheckResult): void {
  cachedCheck = result
}

export function clearCache(): void {
  cachedCheck = null
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatVersionInfo(info: VersionInfo): string {
  const lines: string[] = [
    `Current: ${info.current}${info.isPrerelease ? ' (prerelease)' : ''}`,
  ]
  if (info.latest) {
    const arrow = info.updateAvailable ? ' → UPDATE AVAILABLE' : ''
    lines.push(`Latest:  ${info.latest}${arrow}`)
  }
  if (info.beta && info.beta !== info.latest) {
    const arrow = info.betaAvailable ? ' → BETA AVAILABLE' : ''
    lines.push(`Beta:    ${info.beta}${arrow}`)
  }
  return lines.join('\n')
}

export function formatUpdateCheckResult(result: UpdateCheckResult): string {
  if (result.error) {
    return `Update check failed: ${result.error}`
  }

  const v = result.version
  let out = formatVersionInfo(v)

  if (v.updateAvailable && v.latest && !isVersionIgnored(v.latest)) {
    out += `\n\nRun \`npm install -g ${PACKAGE_NAME}@latest\` to update.`
  }

  if (result.ignored && result.ignored.length > 0) {
    out += `\n\nIgnored versions: ${result.ignored.join(', ')}`
  }

  return out
}
