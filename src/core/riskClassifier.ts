/**
 * Risk Classifier — three-tier risk classification for shell commands.
 *
 * Inspired by AgentOS risk_classifier.py, adapted for ovolv999 CLI.
 *
 * Modes (controlled by EngineConfig.permissionMode):
 *   'auto'   — no risk checking (default, CLI convenience)
 *   'ask'    — dangerous commands blocked, risky commands warn
 *   'deny'   — dangerous + risky commands blocked
 *
 * When enabled (ask/deny mode), BashTool checks each command before execution.
 */

/** Three risk levels */
export type RiskLevel = 'safe' | 'needs_approval' | 'dangerous'

// Patterns that are ALWAYS dangerous — irreversible or system-destroying
const DANGEROUS_PATTERNS: RegExp[] = [
  // File deletion
  /\brm\b(?=.*(?:\s-[a-zA-Z]*r[a-zA-Z]*\b|\s--recursive\b))/,  // rm -rf
  /\brm\s+.*--no-preserve-root/,                                  // rm --no-preserve-root
  // Disk / device destruction
  /\bdd\s+.*of=\/dev\//,                                          // dd to device
  /\bmkfs\./,                                                     // format filesystem
  />\s*\/dev\/(sd|nvme|hd|vd)/,                                   // write to block device
  // Power / system
  /\b(shutdown|reboot|halt|poweroff)\b/,                          // power off
  /\binit\s+[06]\b/,                                              // init 0/6
  /:\(\)\s*\{\s*:\|:&\s*\};:/,                                   // fork bomb
  // Privilege escalation
  /(?:^|[;&|]+|`|\$\()\s*(sudo|su)\b/,                            // privilege escalation
  // Dangerous chmod/chown
  /\bchmod\s+(-R\s+)?[0-7]*7[0-7]*\s+\//,                         // chmod 777 on root
  /\bchown\s+-R\s+.*\s+\//,                                       // chown -R on root
  // Git destructive (ported from Claude Code destructiveCommandWarning.ts)
  /\bgit\s+push\s+.*--force.*\b(main|master)\b/,                  // force push to main
  /\bgit\s+reset\s+--hard/,                                       // git reset --hard
  /\bgit\s+clean\s+(-[a-zA-Z]*[fd])/,                             // git clean -fd
  /\bgit\s+checkout\s+\./,                                        // git checkout . (discard all)
  /\bgit\s+restore\s+\./,                                         // git restore . (discard all)
  /\bgit\s+stash\s+(drop|clear)\b/,                               // git stash drop/clear
  /\bgit\s+branch\s+-D\b/,                                        // git branch -D (force delete)
  /\bgit\s+commit\s+--amend/,                                     // git commit --amend
  /\bgit\s+.*--no-verify/,                                        // skip git hooks
  // Database destruction
  /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA|INDEX)\b/i,        // DROP/TRUNCATE
  /\bDELETE\s+FROM\b(?=.*[^;]*$)(?!.*\bWHERE\b)/i,                // DELETE without WHERE
  // Infrastructure
  /\bkubectl\s+delete\b/,                                         // kubectl delete
  /\bterraform\s+destroy\b/,                                      // terraform destroy
]

// Commands that are always safe to run
const SAFE_PREFIXES: Set<string> = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'fd', 'pwd', 'whoami',
  'echo', 'wc', 'file', 'stat', 'du', 'df', 'date', 'uname', 'hostname',
  'env', 'printenv', 'id', 'which', 'type', 'readlink', 'basename',
  'dirname', 'realpath', 'test', 'true', 'false', 'tree',
  'node', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'python', 'python3',
  'tsc', 'eslint', 'prettier', 'vitest', 'jest', 'cargo', 'go', 'rustc',
])

// Git subcommands that are safe (read-only)
const SAFE_GIT_SUBCOMMANDS: Set<string> = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'tag', 'remote',
  'describe', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file',
  'shortlog', 'blame', 'stash', 'config',
])

function extractFirstWord(segment: string): string {
  const stripped = segment.trim()
  if (!stripped) return ''
  return stripped.split(/\s+/)[0] ?? ''
}

function classifySegment(segment: string): RiskLevel {
  // Check dangerous patterns first
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(segment)) return 'dangerous'
  }

  const firstWord = extractFirstWord(segment)
  if (!firstWord) return 'needs_approval'

  // Safe prefixes
  if (SAFE_PREFIXES.has(firstWord)) {
    if (firstWord === 'git') return classifyGit(segment)
    return 'safe'
  }

  return 'needs_approval'
}

function classifyGit(segment: string): RiskLevel {
  const tokens = segment.split(/\s+/)
  for (const token of tokens.slice(1)) {
    if (!token.startsWith('-')) {
      return SAFE_GIT_SUBCOMMANDS.has(token) ? 'safe' : 'needs_approval'
    }
  }
  return 'safe'
}

/**
 * Classify a shell command's risk level.
 * Checks each segment (split by |, ;, &&) and returns the worst level.
 */
export function classifyCommandRisk(command: string): RiskLevel {
  if (!command.trim()) return 'needs_approval'

  // Check dangerous patterns on the whole command first (catches cross-line patterns)
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return 'dangerous'
  }

  // Split by command separators and check each segment
  const lines = command.trim().split('\n')
  let worst: RiskLevel = 'safe'

  for (const line of lines) {
    const segments = line.split(/\s*(?:\|\||&&|;|\||&)\s*/)
    for (const segment of segments) {
      const trimmed = segment.trim()
      if (!trimmed) continue
      // Strip leading env vars (FOO=bar cmd)
      const cleaned = trimmed.replace(/^[A-Z_][A-Z0-9_]*=\S+\s+/, '')
      const level = classifySegment(cleaned)
      if (level === 'dangerous') return 'dangerous'
      if (level === 'needs_approval') worst = 'needs_approval'
    }
  }

  return worst
}

/**
 * Check if a command should be blocked or warned based on permission mode.
 * Returns:
 *   - { allowed: true } — proceed
 *   - { allowed: false, reason } — blocked
 *   - { allowed: true, warning } — proceed with warning (ask mode for risky)
 */
export function checkCommandPermission(
  command: string,
  mode: 'auto' | 'ask' | 'deny',
): { allowed: true } | { allowed: false; reason: string } | { allowed: true; warning: string } {
  if (mode === 'auto') return { allowed: true }

  const risk = classifyCommandRisk(command)

  if (risk === 'dangerous') {
    return {
      allowed: false,
      reason: `Blocked (dangerous command): "${command.slice(0, 80)}". This command is irreversible or system-destroying. Set permissionMode to 'auto' to override.`,
    }
  }

  if (risk === 'needs_approval' && mode === 'deny') {
    return {
      allowed: false,
      reason: `Blocked (unrecognized command in deny mode): "${command.slice(0, 80)}". Only known-safe commands are allowed in deny mode.`,
    }
  }

  if (risk === 'needs_approval' && mode === 'ask') {
    return {
      allowed: true,
      warning: `Warning: command "${command.slice(0, 80)}" is not recognized as safe. Proceed with caution.`,
    }
  }

  return { allowed: true }
}
