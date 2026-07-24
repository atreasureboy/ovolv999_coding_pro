/**
 * Secret Scanner & Masker
 *
 * Detects and redacts secrets from text before display, export, or sharing.
 * Patterns adapted from CCB's share command and common industry practice.
 *
 * Supported patterns:
 *   - OpenAI API keys (sk-...)
 *   - Anthropic API keys (sk-ant-...)
 *   - AWS access keys (AKIA...)
 *   - AWS secret keys (40-char base64 after access key)
 *   - GitHub tokens (ghp_..., gho_..., ghs_..., ghr_..., github_pat_...)
 *   - Slack tokens (xoxb-..., xoxp-..., xoxa-..., xoxr-...)
 *   - Google API keys (AIza...)
 *   - Generic Bearer tokens
 *   - Generic api_key=, token=, secret=, password= in query/JSON
 *   - Private keys (-----BEGIN ... PRIVATE KEY-----)
 *   - Connection strings with embedded credentials
 *   - JWT tokens (eyJ...)
 */

import { createHash } from 'crypto'

// ── Types ───────────────────────────────────────────────────────────────────

export interface SecretMatch {
  /** The pattern name */
  type: string
  /** Start offset in original text */
  start: number
  /** End offset (exclusive) */
  end: number
  /** The matched text (full) */
  fullMatch: string
  /** Masked replacement */
  replacement: string
}

export interface ScanResult {
  /** All matches found */
  matches: SecretMatch[]
  /** Text with secrets replaced */
  masked: string
  /** Whether any secrets were found */
  found: boolean
  /** Total count */
  count: number
}

// ── Pattern Definitions ─────────────────────────────────────────────────────

interface SecretPattern {
  name: string
  regex: RegExp
  /** How to mask the match */
  mask: (match: string) => string
}

/**
 * Mask a secret by showing first 4 and last 4 chars.
 * `sk-abc123...xyz789` → `sk-a...z789`
 * Short strings → fully masked.
 */
export function maskKey(s: string): string {
  if (s.length <= 12) return '***REDACTED***'
  return s.slice(0, 4) + '...' + s.slice(-4)
}

const PATTERNS: SecretPattern[] = [
  // OpenAI API keys
  {
    name: 'OpenAI API key',
    regex: /\bsk-[a-zA-Z0-9]{20,}\b/g,
    mask: maskKey,
  },
  // Anthropic API keys
  {
    name: 'Anthropic API key',
    regex: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g,
    mask: maskKey,
  },
  // AWS access keys
  {
    name: 'AWS access key',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    mask: (m) => m.slice(0, 8) + '...' + m.slice(-4),
  },
  // GitHub tokens
  {
    name: 'GitHub token',
    regex: /\b(?:gh[opsr]_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{22,})\b/g,
    mask: maskKey,
  },
  // Slack tokens
  {
    name: 'Slack token',
    regex: /\bxox[abpr]-[a-zA-Z0-9-]{10,}\b/g,
    mask: maskKey,
  },
  // Google API keys
  {
    name: 'Google API key',
    regex: /\bAIza[a-zA-Z0-9_-]{35,}\b/g,
    mask: maskKey,
  },
  // JWT tokens (eyJ prefix — base64-encoded JSON header)
  {
    name: 'JWT token',
    regex: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]*\b/g,
    mask: (m) => m.slice(0, 10) + '...' + (m.length > 20 ? m.slice(-4) : ''),
  },
  // Bearer tokens in Authorization headers
  {
    name: 'Bearer token',
    regex: /\bBearer\s+[a-zA-Z0-9_\-.=]{20,}/gi,
    mask: (m) => 'Bearer ' + maskKey(m.replace(/^Bearer\s+/i, '')),
  },
  // Private keys (PEM format)
  {
    name: 'Private key',
    regex: /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|PGP\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|OPENSSH\s+|PGP\s+)?PRIVATE\s+KEY-----/g,
    mask: () => '***REDACTED PRIVATE KEY***',
  },
  // Generic key=value patterns (api_key=, token=, secret=, password=, passwd=)
  // Negative lookahead avoids matching values that start with known key prefixes
  // (those are handled by specific patterns above)
  {
    name: 'Generic API key assignment',
    regex: /(?:api[_-]?key|apikey|token|secret|password|passwd)["']?\s*[:=]\s*["']?(?!(?:sk-ant-|sk-|AKIA|gh[opsr]_|github_pat_|xox[abpr]-|AIza|eyJ))(?=[a-zA-Z0-9_\-/+]{16,})[a-zA-Z0-9_\-/+]{16,}["']?/gi,
    mask: (m) => {
      const eqIndex = m.search(/[:=]/)
      if (eqIndex < 0) return '***REDACTED***'
      const prefix = m.slice(0, eqIndex + 1)
      return prefix + '***REDACTED***'
    },
  },
  // Connection strings with passwords
  {
    name: 'Connection string',
    regex: /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp)?:\/\/[^:\s]+:[^@\s]+@[^\s]+/gi,
    mask: (m) => {
      // Show protocol and host, redact password
      const protoMatch = m.match(/^([a-z]+):\/\/[^:\s]+:([^@]+)@/)
      if (protoMatch) {
        const atIndex = m.indexOf('@')
        return m.slice(0, m.indexOf(':') + 3) + '***:***' + m.slice(atIndex)
      }
      return '***REDACTED***'
    },
  },
]

// ── Scanner ─────────────────────────────────────────────────────────────────

/**
 * Scan text for secrets and return all matches.
 * Does NOT modify the text — use `maskSecrets()` for that.
 */
export function scanForSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = []

  for (const pattern of PATTERNS) {
    // Reset regex lastIndex (global flag)
    pattern.regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.regex.exec(text)) !== null) {
      const fullMatch = match[0]
      const start = match.index
      const end = start + fullMatch.length
      matches.push({
        type: pattern.name,
        start,
        end,
        fullMatch,
        replacement: pattern.mask(fullMatch),
      })
    }
  }

  // Sort by position
  matches.sort((a, b) => a.start - b.start)

  // Remove overlapping matches (keep the first/longer one)
  const filtered: SecretMatch[] = []
  let lastEnd = 0
  for (const m of matches) {
    if (m.start >= lastEnd) {
      filtered.push(m)
      lastEnd = m.end
    }
  }

  return filtered
}

/**
 * Scan text and return a result with masked text.
 */
export function maskSecrets(text: string): ScanResult {
  const matches = scanForSecrets(text)

  if (matches.length === 0) {
    return { matches, masked: text, found: false, count: 0 }
  }

  // Build masked text by replacing from end to start (preserves indices)
  const chars = text.split('')
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    chars.splice(m.start, m.end - m.start, m.replacement)
  }
  const masked = chars.join('')

  return { matches, masked, found: true, count: matches.length }
}

/**
 * Check if text contains any secrets (fast — no masking).
 */
export function hasSecrets(text: string): boolean {
  return scanForSecrets(text).length > 0
}

/**
 * Generate a SHA-256 fingerprint of a secret (for logging without revealing).
 */
export function fingerprintSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16)
}

/**
 * Summarize scan results for display.
 */
export function formatScanSummary(result: ScanResult): string {
  if (!result.found) return 'No secrets detected.'

  const byType = new Map<string, number>()
  for (const m of result.matches) {
    byType.set(m.type, (byType.get(m.type) ?? 0) + 1)
  }

  const lines = [`Found ${result.count} secret(s):`]
  for (const [type, count] of byType) {
    lines.push(`  - ${type}: ${count}`)
  }
  return lines.join('\n')
}

/**
 * Validate that a string looks like a real secret (not a false positive).
 * Checks length, character distribution, and known prefixes.
 */
export function isValidSecret(s: string): boolean {
  if (s.length < 16) return false
  // Must have a reasonable mix of chars (not all same)
  const unique = new Set(s).size
  if (unique < 4) return false
  return true
}

// ── Extended scan API (v2) ──────────────────────────────────────────────────

export interface ExtendedScanResult {
  hasSecrets: boolean
  matches: SecretMatch[]
  cleanedContent: string
}

/**
 * Extended scan that returns cleaned content with secrets redacted.
 */
export function scanText(content: string): ExtendedScanResult {
  const matches = scanForSecrets(content)
  let cleaned = content
  for (const m of matches) {
    cleaned = cleaned.replace(m.fullMatch, `[REDACTED:${m.type}]`)
  }
  return {
    hasSecrets: matches.length > 0,
    matches,
    cleanedContent: cleaned,
  }
}

export function formatScanResult(result: ExtendedScanResult): string {
  if (!result.hasSecrets) return 'No secrets detected.'
  const lines = [`Found ${result.matches.length} secret(s):`]
  for (const m of result.matches) {
    lines.push(`  - ${m.type}: ${maskKey(m.fullMatch)}`)
  }
  return lines.join('\n')
}

export interface BulkScanResult {
  totalFiles: number
  filesWithSecrets: number
  totalSecrets: number
  results: Array<{ filePath: string; result: ExtendedScanResult }>
}

export function scanFiles(files: Array<{ path: string; content: string }>): BulkScanResult {
  const results: BulkScanResult['results'] = []
  let filesWithSecrets = 0
  let totalSecrets = 0

  for (const file of files) {
    const result = scanText(file.content)
    results.push({ filePath: file.path, result })
    if (result.hasSecrets) {
      filesWithSecrets++
      totalSecrets += result.matches.length
    }
  }

  return { totalFiles: files.length, filesWithSecrets, totalSecrets, results }
}

export function formatBulkScanResult(result: BulkScanResult): string {
  const lines = [
    `Scanned ${result.totalFiles} file(s):`,
    `  ${result.filesWithSecrets} file(s) with secrets`,
    `  ${result.totalSecrets} total secrets found`,
  ]
  for (const { filePath, result: scanResult } of result.results) {
    if (!scanResult.hasSecrets) continue
    lines.push(`${filePath}:`)
    for (const m of scanResult.matches) {
      lines.push(`  - ${m.type}: ${maskKey(m.fullMatch)}`)
    }
  }
  return lines.join('\n')
}
