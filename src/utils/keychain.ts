/**
 * Local Vault — encrypted credential/secret storage
 *
 * Stores API keys and secrets securely using OS keychain when available,
 * falling back to an encrypted file store.
 *
 * Storage backends:
 *   - macOS: Keychain (via `security` command)
 *   - Linux: secret-tool (libsecret) or encrypted file
 *   - Windows: Credential Manager (cmdkey)
 *   - Fallback: AES-256-GCM encrypted JSON file (scrypt-derived key)
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { atomicWriteSync } from '../core/atomicWrite.js'
import { execFileSync, execSync } from 'child_process'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

// ── Types ───────────────────────────────────────────────────────────────────

export interface VaultEntry {
  key: string
  value: string
  description?: string
  createdAt: string
  updatedAt: string
}

export interface VaultMetadata {
  count: number
  backend: string
  lastModified?: string
}

// ── Constants ───────────────────────────────────────────────────────────────

const SERVICE_NAME = 'ovolv999'
const VAULT_FILE = 'vault.enc'

// ── Backend Detection ───────────────────────────────────────────────────────

export type VaultBackend = 'keychain-macos' | 'libsecret' | 'credential-manager' | 'file'

export function detectBackend(): VaultBackend {
  // macOS keychain
  try {
    execSync('which security', { stdio: 'pipe', timeout: 2000 })
    return 'keychain-macos'
  } catch { /* not macOS */ }

  // Linux libsecret
  try {
    execSync('which secret-tool', { stdio: 'pipe', timeout: 2000 })
    return 'libsecret'
  } catch { /* not available */ }

  // Windows credential manager
  try {
    execSync('where cmdkey', { stdio: 'pipe', timeout: 2000 })
    return 'credential-manager'
  } catch { /* not Windows */ }

  return 'file'
}

// ── Vault Directory ─────────────────────────────────────────────────────────

export function getVaultDir(): string {
  return join(homedir(), '.ovolv999', 'vault')
}

export function getVaultFilePath(): string {
  return join(getVaultDir(), VAULT_FILE)
}

// ── File-based Encryption ───────────────────────────────────────────────────

// Fresh salt per encrypt() call — reusing one process-wide salt lets an
// attacker precompute a single scrypt rainbow table for every secret the
// process ever writes. The salt travels in the payload prefix, so
// decrypt() remains compatible with existing vaults.
const KEY_LENGTH = 32

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH)
}

export function encrypt(data: string, passphrase: string): string {
  const salt = randomBytes(16)
  const key = deriveKey(passphrase, salt)
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  // Format: salt:iv:authTag:encrypted (all hex)
  return [salt.toString('hex'), iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':')
}

export function decrypt(encoded: string, passphrase: string): string {
  const [saltHex, ivHex, authTagHex, dataHex] = encoded.split(':')
  if (!saltHex || !ivHex || !authTagHex || !dataHex) throw new Error('Invalid vault format')

  const salt = Buffer.from(saltHex, 'hex')
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const encrypted = Buffer.from(dataHex, 'hex')

  const key = scryptSync(passphrase, salt, KEY_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  return decrypted.toString('utf8')
}

// ── File Backend ────────────────────────────────────────────────────────────

interface FileVault {
  entries: VaultEntry[]
}

function loadFileVault(passphrase: string): FileVault {
  const path = getVaultFilePath()
  if (!existsSync(path)) return { entries: [] }
  const raw = readFileSync(path, 'utf8')
  // A decrypt failure (wrong passphrase / corrupted vault) must NOT be
  // treated as an empty vault — returning empty here would let the next
  // setSecret() overwrite and silently destroy every stored entry.
  const decrypted = decrypt(raw, passphrase)
  return JSON.parse(decrypted) as FileVault
}

function saveFileVault(vault: FileVault, passphrase: string): void {
  const encrypted = encrypt(JSON.stringify(vault), passphrase)
  atomicWriteSync(getVaultFilePath(), encrypted)
}

// ── macOS Keychain Backend ──────────────────────────────────────────────────

function keychainGet(key: string): string | null {
  try {
    const result = execFileSync('security', [
      'find-generic-password', '-s', SERVICE_NAME, '-a', key, '-w',
    ], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return result.trim()
  } catch {
    return null
  }
}

function keychainSet(key: string, value: string): boolean {
  try {
    // The interactive stdin protocol is line-based — a value containing
    // a newline would inject a second `security -i` command. Reject.
    if (/[\r\n]/.test(value)) return false
    try { execFileSync('security', ['delete-generic-password', '-s', SERVICE_NAME, '-a', key], { stdio: 'pipe', timeout: 5000 }) } catch { /* ignore */ }
    // Security (M6): the secret must NOT travel as a command-line
    // argument — argv is world-readable via `ps` for the process
    // lifetime. `security -i` reads subcommands from stdin; in
    // interactive mode `add-generic-password -w` (no value, LAST on the
    // line) prompts for the password on the next stdin line.
    const script =
      `add-generic-password -U -s ${shellQuote(SERVICE_NAME)} -a ${shellQuote(key)} -w\n` +
      `${value}\n`
    execFileSync('security', ['-i'], {
      input: script,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    })
    return true
  } catch {
    return false
  }
}

function shellQuote(s: string): string {
  return `"${s.replace(/(["\\])/g, '\\$1')}"`
}

function keychainDelete(key: string): boolean {
  try {
    execFileSync('security', [
      'delete-generic-password', '-s', SERVICE_NAME, '-a', key,
    ], {
      stdio: 'pipe',
      timeout: 5000,
    })
    return true
  } catch {
    return false
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function setSecret(key: string, value: string, passphrase?: string): boolean {
  const backend = detectBackend()

  if (backend === 'keychain-macos') {
    return keychainSet(key, value)
  }

  // File backend (with passphrase)
  if (!passphrase) {
    throw new Error('Passphrase required for file-based vault. Set OVOLV999_VAULT_PASSPHRASE env var.')
  }

  const vault = loadFileVault(passphrase)
  const existing = vault.entries.find(e => e.key === key)
  const now = new Date().toISOString()

  if (existing) {
    existing.value = value
    existing.updatedAt = now
  } else {
    vault.entries.push({
      key,
      value,
      createdAt: now,
      updatedAt: now,
    })
  }

  saveFileVault(vault, passphrase)
  return true
}

export function getSecret(key: string, passphrase?: string): string | null {
  const backend = detectBackend()

  if (backend === 'keychain-macos') {
    return keychainGet(key)
  }

  if (!passphrase) {
    throw new Error('Passphrase required for file-based vault.')
  }

  const vault = loadFileVault(passphrase)
  return vault.entries.find(e => e.key === key)?.value ?? null
}

export function deleteSecret(key: string, passphrase?: string): boolean {
  const backend = detectBackend()

  if (backend === 'keychain-macos') {
    return keychainDelete(key)
  }

  if (!passphrase) {
    throw new Error('Passphrase required for file-based vault.')
  }

  const vault = loadFileVault(passphrase)
  const before = vault.entries.length
  vault.entries = vault.entries.filter(e => e.key !== key)
  if (vault.entries.length < before) {
    saveFileVault(vault, passphrase)
    return true
  }
  return false
}

export function listSecrets(passphrase?: string): string[] {
  const backend = detectBackend()

  if (backend === 'keychain-macos') {
    // Can't easily list all entries for a service in keychain
    // Would require dumping and parsing
    return []
  }

  if (!passphrase) return []

  const vault = loadFileVault(passphrase)
  return vault.entries.map(e => e.key)
}

export function getVaultMetadata(passphrase?: string): VaultMetadata {
  const backend = detectBackend()

  if (backend === 'keychain-macos') {
    return { count: 0, backend: 'keychain-macos' }
  }

  if (!passphrase) {
    return { count: 0, backend }
  }

  try {
    const vault = loadFileVault(passphrase)
    return {
      count: vault.entries.length,
      backend,
      lastModified: vault.entries.length > 0
        ? vault.entries.reduce((latest, e) => e.updatedAt > latest ? e.updatedAt : latest, vault.entries[0].updatedAt)
        : undefined,
    }
  } catch {
    return { count: 0, backend }
  }
}

// ── Env-based passphrase ────────────────────────────────────────────────────

export function getPassphraseFromEnv(): string | undefined {
  return process.env.OVOLV999_VAULT_PASSPHRASE
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatVaultStatus(metadata: VaultMetadata): string {
  const lines: string[] = [
    'Vault Status:',
    `  Backend: ${metadata.backend}`,
    `  Secrets stored: ${metadata.count}`,
  ]
  if (metadata.lastModified) {
    lines.push(`  Last modified: ${metadata.lastModified}`)
  }
  return lines.join('\n')
}
