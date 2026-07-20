/**
 * Auto-Mode Classifier
 *
 * Automatically classifies tool calls as safe or dangerous
 * to decide whether to auto-approve or ask the user.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type SafetyLevel = 'safe' | 'low-risk' | 'medium-risk' | 'high-risk' | 'dangerous'

export interface ClassificationResult {
  level: SafetyLevel
  autoApprove: boolean
  reason: string
  confidence: number
  patterns: string[]
}

// ── Pattern Definitions ─────────────────────────────────────────────────────

interface RiskPattern {
  regex: RegExp
  level: SafetyLevel
  reason: string
}

const BASH_PATTERNS: RiskPattern[] = [
  // Dangerous
  { regex: /rm\s+-rf?\s+[/~]/i, level: 'dangerous', reason: 'Recursive delete of root/home' },
  { regex: /rm\s+-rf?\s+\*/i, level: 'dangerous', reason: 'Recursive delete with wildcard' },
  { regex: /mkfs/i, level: 'dangerous', reason: 'Filesystem format' },
  { regex: /dd\s+.*of=\/dev\//i, level: 'dangerous', reason: 'Writing to device' },
  { regex: /:\(\)\s*\{.*\|.*&\s*\};/i, level: 'dangerous', reason: 'Fork bomb' },
  { regex: /chmod\s+-R?\s+777\s+\//i, level: 'dangerous', reason: 'World-writable root' },
  { regex: />\s*\/dev\/sda/i, level: 'dangerous', reason: 'Overwriting disk device' },

  // High risk
  { regex: /sudo\s+/i, level: 'high-risk', reason: 'Privilege escalation' },
  { regex: /git\s+push\s+.*--force/i, level: 'high-risk', reason: 'Force push' },
  { regex: /git\s+push\s+.*--no-verify/i, level: 'high-risk', reason: 'Push without verification' },
  { regex: /git\s+reset\s+--hard/i, level: 'high-risk', reason: 'Hard reset' },
  { regex: /git\s+clean\s+-fd/i, level: 'high-risk', reason: 'Force clean' },
  { regex: /npm\s+publish/i, level: 'high-risk', reason: 'Publishing package' },
  { regex: /docker\s+rm\s+-f/i, level: 'high-risk', reason: 'Force remove container' },
  { regex: /kill\s+-9/i, level: 'high-risk', reason: 'Force kill process' },
  { regex: /curl\s+.*\|\s*sh/i, level: 'high-risk', reason: 'Pipe to shell' },
  { regex: /wget\s+.*\|\s*sh/i, level: 'high-risk', reason: 'Pipe to shell' },
  { regex: /eval\s*\(/i, level: 'high-risk', reason: 'Eval expression' },

  // Medium risk
  { regex: /npm\s+install/i, level: 'medium-risk', reason: 'Installing packages' },
  { regex: /pip\s+install/i, level: 'medium-risk', reason: 'Installing packages' },
  { regex: /yarn\s+add/i, level: 'medium-risk', reason: 'Installing packages' },
  { regex: /docker\s+run/i, level: 'medium-risk', reason: 'Running container' },
  { regex: /docker\s+build/i, level: 'medium-risk', reason: 'Building image' },
  { regex: /git\s+merge/i, level: 'medium-risk', reason: 'Merging branches' },
  { regex: /git\s+rebase/i, level: 'medium-risk', reason: 'Rebasing' },
  { regex: /git\s+cherry-pick/i, level: 'medium-risk', reason: 'Cherry-picking' },
  { regex: /terraform\s+apply/i, level: 'medium-risk', reason: 'Applying infrastructure changes' },

  // Low risk
  { regex: /^git\s+(status|log|diff|show|branch|remote)/i, level: 'safe', reason: 'Read-only git' },
  { regex: /^ls\b/i, level: 'safe', reason: 'List directory' },
  { regex: /^cat\b/i, level: 'safe', reason: 'Read file' },
  { regex: /^pwd\b/i, level: 'safe', reason: 'Print directory' },
  { regex: /^echo\b/i, level: 'safe', reason: 'Echo text' },
  { regex: /^head\b/i, level: 'safe', reason: 'Read file head' },
  { regex: /^tail\b/i, level: 'safe', reason: 'Read file tail' },
  { regex: /^wc\b/i, level: 'safe', reason: 'Count lines' },
  { regex: /^grep\b/i, level: 'safe', reason: 'Search text' },
  { regex: /^find\b/i, level: 'safe', reason: 'Find files' },
  { regex: /^which\b/i, level: 'safe', reason: 'Find command' },
  { regex: /^file\b/i, level: 'safe', reason: 'Check file type' },
  { regex: /^date\b/i, level: 'safe', reason: 'Show date' },
  { regex: /^env\b/i, level: 'safe', reason: 'Show environment' },
  { regex: /^node\s+--version/i, level: 'safe', reason: 'Check version' },
  { regex: /^npm\s+(list|ls|outdated|view)/i, level: 'safe', reason: 'Read npm info' },
  { regex: /^npx\s+.*--dry-run/i, level: 'safe', reason: 'Dry run' },
  { regex: /^make\s+clean/i, level: 'low-risk', reason: 'Clean build artifacts' },
]

const FILE_WRITE_PATTERNS: RiskPattern[] = [
  { regex: /\.env/i, level: 'high-risk', reason: 'Environment file' },
  { regex: /\.pem$/i, level: 'high-risk', reason: 'Private key file' },
  { regex: /\.key$/i, level: 'high-risk', reason: 'Key file' },
  { regex: /id_rsa/i, level: 'high-risk', reason: 'SSH private key' },
  { regex: /\.ssh\//i, level: 'high-risk', reason: 'SSH directory' },
  { regex: /\.git\/config/i, level: 'high-risk', reason: 'Git config' },
  { regex: /package\.json$/i, level: 'medium-risk', reason: 'Package manifest' },
  { regex: /package-lock\.json$/i, level: 'medium-risk', reason: 'Lock file' },
  { regex: /tsconfig\.json$/i, level: 'medium-risk', reason: 'TypeScript config' },
  { regex: /\.github\/workflows\//i, level: 'medium-risk', reason: 'CI/CD config' },
]

// ── Classification ──────────────────────────────────────────────────────────

export function classifyBashCommand(command: string): ClassificationResult {
  const trimmed = command.trim()
  const matchedPatterns: string[] = []
  let highestLevel: SafetyLevel = 'safe'
  let matched = false

  for (const pattern of BASH_PATTERNS) {
    if (pattern.regex.test(trimmed)) {
      matched = true
      matchedPatterns.push(pattern.reason)
      if (compareSafety(pattern.level, highestLevel) > 0) {
        highestLevel = pattern.level
      }
    }
  }

  // Default classification
  if (!matched) {
    // Unknown command — treat as medium risk
    highestLevel = 'medium-risk'
    matchedPatterns.push('Unknown command')
  }

  const autoApprove = shouldAutoApprove(highestLevel)
  const confidence = calculateConfidence(matchedPatterns.length, highestLevel)

  return {
    level: highestLevel,
    autoApprove,
    reason: matchedPatterns[0],
    confidence,
    patterns: matchedPatterns,
  }
}

export function classifyFileWrite(path: string): ClassificationResult {
  const matchedPatterns: string[] = []
  let highestLevel: SafetyLevel = 'safe'

  for (const pattern of FILE_WRITE_PATTERNS) {
    if (pattern.regex.test(path)) {
      matchedPatterns.push(pattern.reason)
      if (compareSafety(pattern.level, highestLevel) > 0) {
        highestLevel = pattern.level
      }
    }
  }

  if (matchedPatterns.length === 0) {
    highestLevel = 'safe'
    matchedPatterns.push('Regular file write')
  }

  return {
    level: highestLevel,
    autoApprove: shouldAutoApprove(highestLevel),
    reason: matchedPatterns[0],
    confidence: calculateConfidence(matchedPatterns.length, highestLevel),
    patterns: matchedPatterns,
  }
}

export function classifyToolCall(tool: string, input: string): ClassificationResult {
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return classifyBashCommand(input)
    case 'Write':
    case 'Edit':
      return classifyFileWrite(input)
    case 'Read':
    case 'Glob':
    case 'Grep':
      return { level: 'safe', autoApprove: true, reason: 'Read-only operation', confidence: 1, patterns: [] }
    default:
      return { level: 'low-risk', autoApprove: false, reason: 'Unknown tool', confidence: 0.5, patterns: [] }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const SAFETY_ORDER: Record<SafetyLevel, number> = {
  'safe': 0,
  'low-risk': 1,
  'medium-risk': 2,
  'high-risk': 3,
  'dangerous': 4,
}

function compareSafety(a: SafetyLevel, b: SafetyLevel): number {
  return SAFETY_ORDER[a] - SAFETY_ORDER[b]
}

function shouldAutoApprove(level: SafetyLevel): boolean {
  switch (level) {
    case 'safe':
    case 'low-risk':
      return true
    default:
      return false
  }
}

function calculateConfidence(patternCount: number, level: SafetyLevel): number {
  const baseConfidence = Math.min(1, 0.5 + patternCount * 0.2)
  // Dangerous patterns are more certain
  if (level === 'dangerous') return Math.min(1, baseConfidence + 0.2)
  return baseConfidence
}

// ── YOLO Mode ───────────────────────────────────────────────────────────────

export function classifyYolo(tool: string, input: string): ClassificationResult {
  const baseResult = classifyToolCall(tool, input)

  // In YOLO mode, approve everything except truly dangerous
  if (baseResult.level === 'dangerous') {
    return baseResult
  }

  return {
    ...baseResult,
    autoApprove: true,
    reason: `YOLO mode: ${baseResult.reason}`,
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

const LEVEL_ICONS: Record<SafetyLevel, string> = {
  'safe': '✓',
  'low-risk': '○',
  'medium-risk': '⚠',
  'high-risk': '⚠!',
  'dangerous': '✗',
}

export function formatClassification(result: ClassificationResult): string {
  const icon = LEVEL_ICONS[result.level]
  const approve = result.autoApprove ? 'AUTO-APPROVE' : 'ASK USER'
  return `${icon} ${result.level.toUpperCase()} → ${approve} (${(result.confidence * 100).toFixed(0)}%)\n  ${result.reason}`
}
