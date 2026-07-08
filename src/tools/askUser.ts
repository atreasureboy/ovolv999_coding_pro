/**
 * AskUserQuestion Tool — let the Agent ask the user clarifying questions
 *
 * Inspired by Claude Code's AskUserQuestionTool.
 *
 * During execution, the Agent may need to:
 *   1. Clarify ambiguous instructions
 *   2. Get a decision on implementation choices
 *   3. Offer the user choices about direction
 *
 * This tool pauses the LLM loop, displays a multiple-choice prompt to the
 * user, and returns their selection. The user can always pick "Other" to
 * type a custom answer.
 *
 * Architecture: The tool itself is stateless — it calls a callback
 * (`ctx.askUserQuestion`) provided by the REPL. This keeps the tool
 * testable (mock the callback) and decoupled from the terminal I/O layer.
 * Sub-agents / piped mode (no callback provided) get a graceful fallback.
 */

import { createInterface } from 'readline'
import type {
  Tool,
  ToolContext,
  ToolDefinition,
  ToolResult,
  AskUserOption,
  AskUserQuestionInput,
  AskUserQuestionHandler,
} from '../core/types.js'

// Re-export for convenience (terminal handler consumers import from here)
export type { AskUserOption, AskUserQuestionInput, AskUserQuestionHandler }

// ── Validation ──────────────────────────────────────────────────────────────

interface RawQuestion {
  question?: unknown
  header?: unknown
  options?: unknown
  multiSelect?: unknown
}

interface RawOption {
  label?: unknown
  description?: unknown
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function validateQuestions(questions: unknown): string | null {
  if (!Array.isArray(questions) || questions.length === 0) {
    return 'questions must be a non-empty array (1-4 questions)'
  }
  if (questions.length > 4) {
    return 'Maximum 4 questions allowed'
  }

  const seenQuestions = new Set<string>()
  for (const rawQ of questions) {
    if (!isObject(rawQ)) return 'Each question must be an object'
    const q = rawQ as RawQuestion
    if (typeof q.question !== 'string' || !q.question) {
      return 'Each question must have a non-empty "question" string'
    }
    if (typeof q.header !== 'string' || !q.header) {
      return 'Each question must have a non-empty "header" string'
    }
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
      return `Question "${q.question}" must have 2-4 options`
    }
    if (seenQuestions.has(q.question)) {
      return `Duplicate question: "${q.question}"`
    }
    seenQuestions.add(q.question)

    const seenLabels = new Set<string>()
    for (const rawOpt of q.options) {
      if (!isObject(rawOpt)) return `Option in question "${q.question}" must be an object`
      const opt = rawOpt as RawOption
      if (typeof opt.label !== 'string' || !opt.label) {
        return `Option in question "${q.question}" must have a non-empty "label"`
      }
      if (seenLabels.has(opt.label)) {
        return `Duplicate option label "${opt.label}" in question "${q.question}"`
      }
      seenLabels.add(opt.label)
    }
  }
  return null
}

// ── Tool ────────────────────────────────────────────────────────────────────

export class AskUserQuestionTool implements Tool {
  name = 'AskUserQuestion'

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'AskUserQuestion',
      description: `Ask the user multiple-choice questions to gather information, clarify ambiguity, or get decisions. The user can always select "Other" to type a custom answer.

## When to Use
- Clarify ambiguous instructions before starting work
- Get a decision on implementation choices (e.g., "Which library?" "Which approach?")
- Offer the user choices about direction
- Gather preferences or requirements

## When NOT to Use
- The answer is obvious from context — just proceed
- You can determine the answer by reading files — use Read instead
- Asking "should I proceed?" — just proceed if confident

## Question Fields
- question: The full question text (must end with "?")
- header: Very short label (max 12 chars, e.g., "Auth method", "Library")
- options: 2-4 choices, each with:
  - label: Short display text (1-5 words)
  - description: Explanation of what this option means
- multiSelect: Set true to allow multiple selections (default: false)

## Tips
- If you recommend an option, make it first and add "(Recommended)" to the label
- 2-3 options is usually best — don't overwhelm the user
- "Other" is always available — don't add it as an explicit option`,
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: '1-4 questions to ask the user',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                question: {
                  type: 'string',
                  description: 'The complete question to ask (end with "?")',
                },
                header: {
                  type: 'string',
                  description: 'Very short label (max 12 chars)',
                },
                options: {
                  type: 'array',
                  description: '2-4 options (do NOT include "Other" — it is automatic)',
                  minItems: 2,
                  maxItems: 4,
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'Short display text (1-5 words)' },
                      description: { type: 'string', description: 'What this option means' },
                    },
                    required: ['label', 'description'],
                  },
                },
                multiSelect: {
                  type: 'boolean',
                  description: 'Allow multiple selections (default: false)',
                },
              },
              required: ['question', 'header', 'options'],
            },
          },
        },
        required: ['questions'],
      },
    },
  }

  isConcurrencySafe(): boolean {
    return false // Requires user interaction — must not run in parallel
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const questionsRaw = input.questions
    const error = validateQuestions(questionsRaw)
    if (error) {
      return { content: `Error: ${error}`, isError: true }
    }

    const questions = questionsRaw as AskUserQuestionInput[]

    // No callback available — sub-agent or piped mode
    if (!ctx.askUserQuestion) {
      // Graceful fallback: return a note so the LLM can proceed with best judgment
      const questionTexts = questions.map((q) => q.question).join('; ')
      return {
        content: `Unable to ask the user (non-interactive mode). Questions were: "${questionTexts}". Proceed with your best judgment based on available context.`,
        isError: false,
      }
    }

    try {
      const answers = await ctx.askUserQuestion(questions)

      // Format answers for the LLM
      const formatted = Object.entries(answers)
        .map(([q, a]) => `Q: ${q}\nA: ${a}`)
        .join('\n\n')

      return {
        content: `The user answered your questions:\n\n${formatted}`,
        isError: false,
      }
    } catch (err) {
      return {
        content: `Failed to get user response: ${(err as Error).message}`,
        isError: true,
      }
    }
  }
}

// ── Terminal handler factory ────────────────────────────────────────────────
//
// Creates an AskUserQuestionHandler backed by terminal I/O.
// Used by the REPL to wire the tool to the user's keyboard.
//
// Display format:
//   ❯❯ [Header] Which approach should we use?
//       1. Option A — Description of A
//       2. Option B — Description of B
//       3. Other (type your own answer)
//     ❯ 
//
// For multiSelect, the prompt accepts comma-separated numbers.

export function createTerminalAskUserHandler(
  writeOut: (s: string) => void,
): AskUserQuestionHandler {
  return async (questions: AskUserQuestionInput[]): Promise<Record<string, string>> => {
    const answers: Record<string, string> = {}
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdout.isTTY,
    })

    // Prevent readline from closing on Ctrl+C
    rl.on('SIGINT', () => {})

    try {
      for (const q of questions) {
        const multi = q.multiSelect === true
        const header = q.header.slice(0, 12)
        const prompt = multi
          ? `  ${'\x1b[95m'}❯❯ ${'\x1b[0m'}[${header}] ${q.question} (comma-separated numbers)`
          : `  ${'\x1b[95m'}❯❯ ${'\x1b[0m'}[${header}] ${q.question}`

        writeOut('\n' + prompt + '\n')
        q.options.forEach((opt, i) => {
          writeOut(`      ${i + 1}. ${opt.label} — ${opt.description}\n`)
        })
        writeOut(`      0. Other (type your own answer)\n`)

        const answer: string = await new Promise((resolve) => {
          // Handle Ctrl+D (EOF) — rl.question callback won't fire on close
          const onClose = (): void => resolve('')
          rl.once('close', onClose)
          rl.question('  ❯ ', (resp) => {
            rl.removeListener('close', onClose)
            resolve(resp.trim())
          })
        })

        // Parse the response
        if (multi) {
          const selections = answer
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
          const labels: string[] = []
          for (const sel of selections) {
            const idx = parseInt(sel, 10)
            if (!isNaN(idx) && idx >= 1 && idx <= q.options.length) {
              labels.push(q.options[idx - 1].label)
            } else if (sel === '0' || isNaN(idx)) {
              // "0" or non-numeric → treat as custom text
              if (sel !== '0') labels.push(sel)
            }
          }
          answers[q.question] = labels.length > 0 ? labels.join(', ') : answer
        } else {
          const idx = parseInt(answer, 10)
          if (!isNaN(idx) && idx >= 1 && idx <= q.options.length) {
            answers[q.question] = q.options[idx - 1].label
          } else {
            // Non-numeric or "0" → custom text
            answers[q.question] = answer
          }
        }
      }
    } finally {
      rl.close()
    }

    return answers
  }
}
