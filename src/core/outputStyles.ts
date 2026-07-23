/**
 * Output Styles — configurable response formatting presets.
 *
 * Lets users control how the assistant formats responses. Each style
 * prepends a system-level directive to the system prompt.
 *
 * Built-in styles:
 *   - concise: short, direct answers
 *   - verbose: detailed explanations with examples
 *   - structured: bullet points and headers
 *   - socratic: ask clarifying questions before answering
 *   - code-focused: minimal prose, max code
 *
 * Config: .ovolv999/output-style.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

export interface OutputStyle {
  id: string
  name: string
  description: string
  /** Directive text appended to the system prompt */
  directive: string
}

export interface OutputStyleConfig {
  /** Currently active style ID */
  active: string
  /** Custom styles (merged with built-ins) */
  custom?: OutputStyle[]
}

// ── Built-in Styles ─────────────────────────────────────────────────────────

export const BUILT_IN_STYLES: OutputStyle[] = [
  {
    id: 'default',
    name: 'Default',
    description: 'Balanced responses with appropriate detail',
    directive: '',
  },
  {
    id: 'concise',
    name: 'Concise',
    description: 'Short, direct answers. Skip pleasantries.',
    directive: [
      'Be concise. Follow these rules strictly:',
      '- Answer in 1-3 sentences when possible',
      '- Skip introductions, conclusions, and pleasantries',
      '- Use code blocks only when essential',
      '- Prefer "yes/no" over explanations when the question is binary',
      '- Omit restating the question',
    ].join('\n'),
  },
  {
    id: 'verbose',
    name: 'Verbose',
    description: 'Detailed explanations with examples and context',
    directive: [
      'Be thorough and educational. Follow these rules:',
      '- Explain your reasoning step by step',
      '- Include relevant examples',
      '- Mention edge cases and pitfalls',
      '- Reference relevant documentation or patterns',
      '- Use headers and structure for longer responses',
    ].join('\n'),
  },
  {
    id: 'structured',
    name: 'Structured',
    description: 'Bullet points, headers, and tables',
    directive: [
      'Structure your response clearly:',
      '- Use markdown headers (##, ###) for sections',
      '- Use bullet points for lists',
      '- Use tables for comparisons',
      '- Use code blocks with language tags',
      '- Add a brief summary at the top, details below',
    ].join('\n'),
  },
  {
    id: 'socratic',
    name: 'Socratic',
    description: 'Ask clarifying questions before answering',
    directive: [
      'Take a Socratic approach:',
      '- If the request is ambiguous, ask 1-2 clarifying questions first',
      '- Identify assumptions and verify them',
      '- Offer 2-3 approaches when multiple solutions exist',
      '- Explain trade-offs rather than picking blindly',
      '- Be direct if the request is clear — do not ask unnecessary questions',
    ].join('\n'),
  },
  {
    id: 'code-focused',
    name: 'Code-Focused',
    description: 'Minimal prose, maximum code',
    directive: [
      'Focus on code. Follow these rules:',
      '- Lead with the code solution',
      '- Explain in comments within the code, not in prose',
      '- Keep prose explanations under 2 sentences',
      '- Show the minimal change needed, not the whole file',
      '- Use diffs when showing modifications',
    ].join('\n'),
  },
  {
    id: 'teaching',
    name: 'Teaching',
    description: 'Explain like teaching a junior developer',
    directive: [
      'Teach while you work:',
      '- Explain WHY, not just WHAT',
      '- Connect new concepts to fundamentals',
      '- Point out patterns the user should learn',
      '- Suggest related topics to explore',
      '- Be encouraging and patient',
    ].join('\n'),
  },
]

// ── Index ───────────────────────────────────────────────────────────────────

const STYLE_INDEX = new Map<string, OutputStyle>()
for (const s of BUILT_IN_STYLES) STYLE_INDEX.set(s.id, s)

// ── Loader ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = '.ovolv999/output-style.json'

export interface StyleLoadResult {
  /** All available styles (built-in + custom) */
  styles: OutputStyle[]
  /** Currently active style */
  active: OutputStyle
  /** Whether a config file was found */
  hasConfig: boolean
  /** Validation errors */
  errors: string[]
}

export function loadOutputStyles(cwd: string): StyleLoadResult {
  const configPath = join(resolve(cwd), CONFIG_PATH)
  const errors: string[] = []
  const customStyles: OutputStyle[] = []
  let activeId = 'default'
  let hasConfig = false

  if (existsSync(configPath)) {
    hasConfig = true
    try {
      const raw = readFileSync(configPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<OutputStyleConfig>

      if (typeof parsed.active === 'string') {
        activeId = parsed.active
      }

      if (Array.isArray(parsed.custom)) {
        for (const s of parsed.custom) {
          const validated = validateStyle(s)
          if (validated) {
            customStyles.push(validated)
          } else {
            errors.push(`Invalid custom style: ${JSON.stringify(s).slice(0, 80)}`)
          }
        }
      }
    } catch (err) {
      errors.push(`Failed to parse config: ${(err as Error).message}`)
    }
  }

  // Merge built-in + custom (custom overrides same-id built-ins)
  const merged = new Map<string, OutputStyle>()
  for (const s of BUILT_IN_STYLES) merged.set(s.id, s)
  for (const s of customStyles) merged.set(s.id, s)

  const styles = [...merged.values()]
  const active = merged.get(activeId) ?? BUILT_IN_STYLES[0]

  return { styles, active, hasConfig, errors }
}

// ── Validation ──────────────────────────────────────────────────────────────

export function validateStyle(data: unknown): OutputStyle | null {
  if (typeof data !== 'object' || data === null) return null
  const obj = data as Record<string, unknown>

  if (typeof obj.id !== 'string' || !obj.id.trim()) return null
  if (typeof obj.name !== 'string' || !obj.name.trim()) return null
  if (typeof obj.directive !== 'string') return null

  return {
    id: obj.id,
    name: obj.name,
    description: typeof obj.description === 'string' ? obj.description : '',
    directive: obj.directive,
  }
}

// ── Active Style ────────────────────────────────────────────────────────────

/**
 * Get the currently active output style for a project.
 */
export function getActiveStyle(cwd: string): OutputStyle {
  return loadOutputStyles(cwd).active
}

/**
 * Set the active style (persists to config file).
 */
export function setActiveStyle(cwd: string, styleId: string): { success: boolean; error?: string } {
  const result = loadOutputStyles(cwd)
  const style = result.styles.find(s => s.id === styleId)
  if (!style) {
    return {
      success: false,
      error: `Unknown style: "${styleId}". Available: ${result.styles.map(s => s.id).join(', ')}`,
    }
  }

  const configPath = join(resolve(cwd), CONFIG_PATH)
  const dir = join(resolve(cwd), '.ovolv999')
  mkdirSync(dir, { recursive: true })

  // Preserve existing custom styles
  const existing = result.hasConfig
    ? JSON.parse(readFileSync(configPath, 'utf8')) as OutputStyleConfig
    : {}
  const config: OutputStyleConfig = {
    ...existing,
    active: styleId,
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
  return { success: true }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function getStyleById(id: string): OutputStyle | null {
  return STYLE_INDEX.get(id) ?? null
}

export function listStyleIds(): string[] {
  return BUILT_IN_STYLES.map(s => s.id)
}

/**
 * Get the directive text to append to the system prompt.
 * Returns empty string for the default style.
 */
export function getDirective(cwd: string): string {
  const style = getActiveStyle(cwd)
  return style.directive
}
