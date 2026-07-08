/**
 * Modes / Personas System — user-configurable agent personalities
 *
 * Inspired by claude-code-best v2.8.2's src/modes/.
 *
 * A Mode bundles together system prompt, verbosity, and behavior flags
 * into a single switchable personality. Users can cycle through built-in
 * modes or define custom ones via markdown files in the modes directory.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

export type Verbosity = 'minimal' | 'normal' | 'verbose'

export interface Mode {
  name: string
  slug: string
  description: string
  icon: string
  /** Extra system prompt prepended to the base prompt */
  systemPrompt: string
  /** Response verbosity — affects how the LLM formats output */
  verbosity: Verbosity
  /** Whether to auto-approve file edits (skip read-before-edit gate) */
  autoApproveEdits: boolean
  /** Whether memory extraction is active for this mode */
  memoryExtract: boolean
}

// ── Built-in Modes ──────────────────────────────────────────────────────────

const DR_SHARP_PROMPT = `You are Dr. Sharp, a meticulous code reviewer and diagnostician.

## Core Principles

1. **Diagnose before acting.** Never jump to a fix. Understand the root cause first.
2. **Minimal effective change.** The smallest diff that fully solves the problem wins.
3. **Evidence-based.** Every claim must be backed by code, logs, or behavior you can point to.
4. **No assumptions.** If you're unsure, ask. Never guess about behavior you haven't verified.

## Three-Phase Workflow

### Phase 1: Deep Diagnosis
- Read the relevant code paths end-to-end
- Trace the execution flow from input to output
- Identify the exact point where behavior diverges from expectation
- State your diagnosis clearly before proceeding

### Phase 2: Action Strategy
- List 2-3 possible approaches with trade-offs
- Recommend the minimal effective approach
- Consider: side effects, edge cases, regression risks
- Explain WHY this approach over alternatives

### Phase 3: Mirror Self
- After implementing, re-read the original problem statement
- Verify your fix addresses the root cause, not just the symptom
- Check for related issues the same root cause might trigger
- Run relevant tests to confirm

## Communication Style

- Be direct and specific. No filler.
- Use code references (file:line) when pointing to issues.
- When reviewing: "This will break when X because Y. Fix: Z."
- When diagnosing: "The bug is at X:42. The condition Y evaluates to Z because..."
- Never apologize for finding problems — that's the job.

## Red Flags to Always Check

- Error handling: are errors caught, logged, and propagated correctly?
- Edge cases: null, empty, boundary values, concurrent access
- Security: injection, auth bypass, data leaks
- Performance: N+1 queries, unnecessary allocations, missing indexes
- Type safety: any \`as any\` casts, missing null checks, loose types`

export const DEFAULT_MODES: Mode[] = [
  {
    name: 'Default',
    slug: 'default',
    description: 'Balanced mode for everyday development',
    icon: '⚡',
    systemPrompt: '',
    verbosity: 'normal',
    autoApproveEdits: false,
    memoryExtract: true,
  },
  {
    name: 'Gentle',
    slug: 'gentle',
    description: 'Patient explanations, great for learning',
    icon: '🌸',
    systemPrompt:
      'You are in gentle learning mode. Explain concepts clearly with examples. ' +
      'When correcting mistakes, be encouraging and explain why. ' +
      'Offer to show alternatives before making changes. ' +
      'Use analogies to help understand complex concepts.',
    verbosity: 'verbose',
    autoApproveEdits: false,
    memoryExtract: true,
  },
  {
    name: 'Dr. Sharp',
    slug: 'sharp',
    description: 'Strict review, focused on code quality',
    icon: '🔍',
    systemPrompt: DR_SHARP_PROMPT,
    verbosity: 'normal',
    autoApproveEdits: false,
    memoryExtract: true,
  },
  {
    name: 'Workhorse',
    slug: 'workhorse',
    description: 'Auto-execute, minimal confirmations',
    icon: '🐴',
    systemPrompt:
      'You are in workhorse mode. Execute tasks efficiently with minimal back-and-forth. ' +
      'Make reasonable assumptions and proceed. ' +
      'Only ask for clarification when truly ambiguous. ' +
      'Batch related changes together.',
    verbosity: 'minimal',
    autoApproveEdits: true,
    memoryExtract: false,
  },
  {
    name: 'Token Saver',
    slug: 'token-saver',
    description: 'Minimal replies, save tokens',
    icon: '💰',
    systemPrompt:
      'You are in token-saving mode. ' +
      'Give the shortest correct answer. ' +
      'Skip explanations unless asked. ' +
      'Use code blocks directly without preamble. ' +
      'No pleasantries or filler.',
    verbosity: 'minimal',
    autoApproveEdits: true,
    memoryExtract: false,
  },
  {
    name: 'Super AI',
    slug: 'super-ai',
    description: 'Deep thinking, comprehensive analysis',
    icon: '🧠',
    systemPrompt:
      'You are in super AI mode. Think deeply before responding. ' +
      'Consider multiple approaches and explain trade-offs. ' +
      'Proactively identify related issues and suggest improvements. ' +
      'Use structured analysis for complex problems. ' +
      'Reference relevant best practices and patterns.',
    verbosity: 'verbose',
    autoApproveEdits: false,
    memoryExtract: true,
  },
]

// ── Frontmatter Parser (no yaml dependency) ─────────────────────────────────

/**
 * Parse a simple `---` delimited frontmatter from a markdown file.
 * Supports flat key: value pairs only (no nested objects/arrays).
 *
 * Example:
 *   ---
 *   name: My Mode
 *   slug: my-mode
 *   verbosity: minimal
 *   ---
 *   You are a custom mode...
 */
function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const parts = raw.split(/^---$/m)
  if (parts.length < 3) {
    return { frontmatter: {}, body: raw.trim() }
  }
  const fmRaw = parts[1] ?? ''
  const body = parts.slice(2).join('---').trim()
  const frontmatter: Record<string, string> = {}
  for (const line of fmRaw.split('\n')) {
    const match = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/)
    if (match) {
      frontmatter[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return { frontmatter, body }
}

function kebabCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ── Mode Store ──────────────────────────────────────────────────────────────

let currentModeSlug = 'default'
let customModesCache: Mode[] | null = null

/**
 * Load custom modes from the given directory.
 * Expects .md files with frontmatter (name, slug, verbosity, auto_approve_edits).
 * Results are cached after first load.
 */
export function loadCustomModes(modesDir: string): Mode[] {
  if (customModesCache !== null) return customModesCache
  customModesCache = []

  try {
    if (!existsSync(modesDir)) {
      try { mkdirSync(modesDir, { recursive: true }) } catch { /* best-effort */ }
    }

    const files = readdirSync(modesDir).filter(f => f.endsWith('.md'))
    for (const file of files) {
      try {
        const raw = readFileSync(join(modesDir, file), 'utf8')
        const { frontmatter, body } = parseFrontmatter(raw)
        if (!frontmatter.name) continue

        const slug = frontmatter.slug || kebabCase(frontmatter.name)
        const verbosity = (frontmatter.verbosity as Verbosity) || 'normal'

        customModesCache.push({
          name: frontmatter.name,
          slug,
          description: frontmatter.description || '',
          icon: frontmatter.icon || '🔧',
          systemPrompt: body,
          verbosity: ['minimal', 'normal', 'verbose'].includes(verbosity) ? verbosity : 'normal',
          autoApproveEdits: frontmatter.auto_approve_edits === 'true',
          memoryExtract: frontmatter.memory_extract !== 'false',
        })
      } catch {
        /* skip invalid files */
      }
    }
  } catch {
    /* modes directory not accessible */
  }

  return customModesCache
}

/** Get all modes: custom + defaults (custom overrides defaults with same slug). */
export function getAllModes(modesDir?: string): Mode[] {
  const custom = modesDir ? loadCustomModes(modesDir) : []
  if (custom.length === 0) return DEFAULT_MODES
  const slugs = new Set(custom.map(m => m.slug))
  return [...custom, ...DEFAULT_MODES.filter(m => !slugs.has(m.slug))]
}

/** Get the currently active mode. */
export function getCurrentMode(modesDir?: string): Mode {
  const modes = getAllModes(modesDir)
  return modes.find(m => m.slug === currentModeSlug) ?? DEFAULT_MODES[0]
}

/** Set the current mode by slug. Throws on unknown slug. */
export function setCurrentMode(slug: string, modesDir?: string): Mode {
  const modes = getAllModes(modesDir)
  const mode = modes.find(m => m.slug === slug)
  if (!mode) {
    throw new Error(
      `Unknown mode: "${slug}". Available: ${modes.map(m => m.slug).join(', ')}`,
    )
  }
  currentModeSlug = slug
  return mode
}

/** Cycle to the next mode (wraps around). Returns the new mode. */
export function cycleMode(modesDir?: string): Mode {
  const modes = getAllModes(modesDir)
  const idx = modes.findIndex(m => m.slug === currentModeSlug)
  const next = modes[(idx + 1) % modes.length]
  currentModeSlug = next.slug
  return next
}

/** Reset mode cache (for tests). */
export function resetModeCache(): void {
  customModesCache = null
  currentModeSlug = 'default'
}

/** Get a verbosity-specific system prompt addition. */
export function getVerbosityPrompt(verbosity: Verbosity): string {
  switch (verbosity) {
    case 'minimal':
      return 'Respond with the shortest correct answer. Skip explanations unless asked.'
    case 'verbose':
      return 'Provide detailed explanations and context. Include alternative approaches and trade-offs.'
    default:
      return ''
  }
}
