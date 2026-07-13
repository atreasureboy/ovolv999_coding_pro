#!/usr/bin/env node
/**
 * ovogogogo — Autonomous Code Execution Engine
 *
 * ovogogogo-style interactive CLI. No React, no Ink — pure terminal.
 *
 * Usage:
 *   ovogogogo                              # interactive REPL
 *   ovogogogo "fix the type errors"        # single task
 *   echo "task" | ovogogogo               # pipe input
 *   ovogogogo -m gpt-4o --max-iter 20     # with options
 *
 * Environment:
 *   OPENAI_API_KEY     (required)
 *   OPENAI_BASE_URL    (optional, for compatible endpoints)
 *   OVOGO_MODEL        (default: gpt-4o)
 *   OVOGO_MAX_ITER     (default: 30)
 *   OVOGO_CWD          (default: process.cwd())
 *
 * Config:
 *   .ovogo/settings.json  — hooks and other settings (project-level)
 *   ~/.ovogo/settings.json — user-level defaults
 *
 * Skills:
 *   .ovogo/skills/*.md    — project-specific slash commands
 *   ~/.ovogo/skills/*.md  — global user slash commands
 */

import { resolve, join, dirname } from 'path'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { fileURLToPath } from 'url'

// ── .env auto-loader (no external dep, never overrides existing env vars) ──
{
  const __scriptDir = dirname(fileURLToPath(import.meta.url))
  const __projectRoot = resolve(__scriptDir, '..', '..')
  for (const dir of [process.cwd(), __projectRoot]) {
    const envPath = join(dir, '.env')
    if (!existsSync(envPath)) continue
    try {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const t = line.trim()
        if (!t || t.startsWith('#')) continue
        const eq = t.indexOf('=')
        if (eq <= 0) continue
        const key = t.slice(0, eq).trim()
        let val = t.slice(eq + 1).trim()
        // Strip surrounding quotes (dotenv convention: KEY="value")
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1)
        }
        if (!process.env[key]) process.env[key] = val
      }
    } catch { /* best-effort */ }
    break
  }
}
import { ExecutionEngine } from '../src/core/engine.js'
import { Renderer } from '../src/ui/renderer.js'
import { InputHandler, readStdin } from '../src/ui/input.js'
import type { EngineConfig, OpenAIMessage } from '../src/core/types.js'
import { getProjectSettingsPath, loadSettings, saveProjectSettings } from '../src/config/settings.js'
import { HookRunner, NoopHookRunner } from '../src/config/hooks.js'
import { loadSkills, expandSkillPrompt, formatSkillIndex } from '../src/skills/loader.js'
import type { Skill } from '../src/skills/loader.js'
import { loadOvogoMd } from '../src/config/ovogomd.js'
import { getMemoryDir, getMemoryStats } from '../src/memory/index.js'
import { buildFullSystemPrompt } from '../src/prompts/system.js'
import { getCurrentMode, getVerbosityPrompt } from '../src/core/modes.js'
import { EventLog } from '../src/core/eventLog.js'
import { SemanticMemory } from '../src/core/semanticMemory.js'
import { EpisodicMemory } from '../src/core/episodicMemory.js'
import { globalModuleRegistry } from '../src/core/moduleRegistry.js'
import { MemoryModule } from '../src/modules/memory.js'
import { CriticModule } from '../src/modules/critic.js'
import { WorkspaceModule } from '../src/modules/workspace.js'
import { ReflectionModule, consolidateSession } from '../src/modules/reflection.js'
import { detectProjectContext, formatProjectContext } from '../src/config/projectContext.js'
import { createLoadSkillTool } from '../src/tools/loadSkill.js'
import { createTerminalAskUserHandler } from '../src/tools/askUser.js'
import { dispatchSlashCommand, type SlashCommandContext } from '../src/commands/index.js'
import '../src/commands/builtin.js' // register all built-in commands
import { tmuxLayout } from '../src/ui/tmuxLayout.js'
import { PermissionManager } from '../src/core/permissionSystem.js'
import {
  AmbiguousSessionError,
  SessionNotFoundError,
  createSessionDir,
  findLatestSession,
  listSessions,
  loadSession,
  resolveSessionPath,
  saveSession,
} from '../src/core/sessionManager.js'
import type { AgentChildEngineFactory } from '../src/core/types.js'

const VERSION = '0.1.0'

// ─────────────────────────────────────────────────────────────
// Arg parsing
// ─────────────────────────────────────────────────────────────

interface Args {
  task?: string
  model: string
  maxIter: number
  cwd: string
  help: boolean
  version: boolean
  loop: boolean
  loopMaxIters: number
  continueSession: boolean
  resumeSession?: string
}

const MAX_RECENT_HISTORY_MESSAGES = 120
const MAX_PINNED_USER_MESSAGES = 12

function trimHistoryForNextTurn(messages: OpenAIMessage[]): OpenAIMessage[] {
  if (messages.length <= MAX_RECENT_HISTORY_MESSAGES) return [...messages]

  const keepIndexes = new Set<number>()
  let recentStart = Math.max(0, messages.length - MAX_RECENT_HISTORY_MESSAGES)

  // Walk forward past orphaned tool results (prevents API 400 on resume)
  if (recentStart > 0) {
    const maxSplit = messages.length - 2
    while (recentStart < maxSplit && messages[recentStart]?.role === 'tool') {
      recentStart++
    }
  }

  for (let i = recentStart; i < messages.length; i++) {
    keepIndexes.add(i)
  }

  const pinnedUserIndexes = messages
    .map((msg, idx) => ({ msg, idx }))
    .filter(({ msg }) => {
      if (msg.role !== 'user' || typeof msg.content !== 'string') return false
      // Skip synthetic compaction summaries; keep real user instructions.
      return !msg.content.startsWith('[CONVERSATION SUMMARY')
    })
    .slice(-MAX_PINNED_USER_MESSAGES)
    .map(({ idx }) => idx)

  for (const idx of pinnedUserIndexes) {
    keepIndexes.add(idx)
  }

  return Array.from(keepIndexes)
    .sort((a, b) => a - b)
    .map((idx) => messages[idx])
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2)
  let task: string | undefined
  let model = resolveApiEnvironment().model
  let maxIter = parseInt(process.env.OVOGO_MAX_ITER ?? '200', 10)
  if (isNaN(maxIter) || maxIter <= 0) maxIter = 200
  let cwd = process.env.OVOGO_CWD ?? process.cwd()
  let help = false
  let version = false
  let loop = false
  let loopMaxIters = 12
  let continueSession = false
  let resumeSession: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--help': case '-h': help = true; break
      case '--version': case '-v': case '-V': version = true; break
      case '--model': case '-m': model = args[++i] ?? model; break
      case '--max-iter': maxIter = parseInt(args[++i] ?? '200', 10); if (isNaN(maxIter) || maxIter <= 0) maxIter = 200; break
      case '--cwd': cwd = args[++i] ?? cwd; break
      case '--loop': loop = true; break
      case '--loop-max-iters': loopMaxIters = parseInt(args[++i] ?? '12', 10); break
      case '--continue': case '-c': continueSession = true; break
      case '--resume': case '-r':
        resumeSession = args[++i]
        if (!resumeSession) {
          process.stderr.write('Error: --resume requires a session name\n')
          process.exit(1)
        }
        break
      default:
        if (!arg.startsWith('-')) task = task ? task + ' ' + arg : arg
    }
  }
  return { task, model, maxIter, cwd, help, version, loop, loopMaxIters, continueSession, resumeSession }
}

interface ResolvedApiEnvironment {
  apiKey: string | undefined
  baseURL: string | undefined
  model: string
  provider: 'minimax' | 'openai'
}

/**
 * MiniMax exposes both Anthropic- and OpenAI-compatible endpoints. Reuse the
 * Claude Code environment when it points at MiniMax so the CLI can share the
 * same account without copying credentials into another config file.
 */
function resolveApiEnvironment(): ResolvedApiEnvironment {
  const anthropicBaseURL = process.env.ANTHROPIC_BASE_URL
  const anthropicApiKey = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY
  const isMiniMax = Boolean(
    anthropicApiKey &&
    anthropicBaseURL &&
    /^https:\/\/api\.(?:minimax\.io|minimaxi\.com)\/anthropic\/?$/i.test(anthropicBaseURL),
  )

  if (isMiniMax) {
    return {
      apiKey: anthropicApiKey,
      baseURL: anthropicBaseURL!.replace(/\/anthropic\/?$/i, '/v1'),
      model: process.env.OVOGO_MODEL ?? process.env.ANTHROPIC_MODEL ?? 'MiniMax-M3',
      provider: 'minimax',
    }
  }

  return {
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
    model: process.env.OVOGO_MODEL ?? 'gpt-4o',
    provider: 'openai',
  }
}

// ─────────────────────────────────────────────────────────────
// Help text
// ─────────────────────────────────────────────────────────────

function printHelp(skills: Map<string, Skill>): void {
  const r = new Renderer()
  const defaultModel = resolveApiEnvironment().model
  r.banner(VERSION, defaultModel)
  process.stdout.write(`USAGE
  ovogogogo [options] [task]

OPTIONS
  -m, --model <model>    LLM model  (env: OVOGO_MODEL, default: ${defaultModel})
  --max-iter <n>         Think-Act-Observe max cycles  (env: OVOGO_MAX_ITER, default: 200)
  --cwd <path>           Working directory  (env: OVOGO_CWD, default: cwd)
  -v, --version          Print version and exit
  -h, --help             Show this help

ENVIRONMENT
  OPENAI_API_KEY         Required — OpenAI API key
  OPENAI_BASE_URL        Optional — compatible endpoint URL

TOOLS
  Bash          Execute shell commands
  Read          Read file contents
  Write         Write/create files
  Edit          Precise string replacement in files
  Glob          Find files by glob pattern
  Grep          Search file contents with regex
  TodoWrite     Task checklist management
  WebFetch      Fetch URL content as plain text
  WebSearch     Search the web
  Agent         Spawn a sub-agent (preset or custom AgentConfig)
  load_skill    Lazily load a skill's full prompt
  TmuxSession   Manage local interactive processes (tmux)
  ShellSession  Manage inbound persistent shell sessions

REPL COMMANDS
  /plan <task>   Run task in plan mode (read-only analysis + confirm before execute)
  /skills        List available skills
  /<skill> [args] Run a built-in or custom skill
  /sessions      List saved sessions (resume with --continue or --resume)
  /clear         Clear conversation history
  /history       Show message count
  /model         Show current model
  /cwd           Show working directory
  /help          Show this help
  /exit          Exit ovogogogo

SKILLS (${skills.size} available)
${[...skills.values()].map(s => `  /${s.name.padEnd(14)} ${s.description}`).join('\n')}

HOOKS (configure in .ovogo/settings.json)
  PreToolCall       Runs before each tool call   (env: OVOGO_TOOL_NAME, OVOGO_TOOL_INPUT)
  PostToolCall      Runs after each tool call    (env: OVOGO_TOOL_NAME, OVOGO_TOOL_RESULT, OVOGO_TOOL_IS_ERROR)
  UserPromptSubmit  Runs when user submits input (env: OVOGO_PROMPT)
  OnError           Runs on unrecoverable error  (env: OVOGO_ERROR_MESSAGE, OVOGO_TURN_NUMBER)
  OnComplete        Runs when a turn completes   (env: OVOGO_RUN_REASON, OVOGO_RUN_OUTPUT)
  OnContextOverflow Runs after context compaction (env: OVOGO_TOKENS_BEFORE, OVOGO_TOKENS_AFTER)

EXAMPLES
  ovogogogo
  ovogogogo "fix the type errors in src/core"
  ovogogogo -m gpt-4o --cwd /my/project "add unit tests for engine.ts"
  echo "refactor the tool registry" | ovogogogo
`)
}

// ─────────────────────────────────────────────────────────────
// Progress log (断点续传)
// ─────────────────────────────────────────────────────────────

function updateProgressLog(cwd: string, step: string, nextAction: string): void {
  try {
    const log = {
      current_step: step,
      next_action: nextAction,
      timestamp: new Date().toISOString(),
      cwd,
    }
    writeFileSync(
      resolve(cwd, 'ovogo_progress.json'),
      JSON.stringify(log, null, 2),
      'utf8',
    )
  } catch {
    // best-effort
  }
}

// ─────────────────────────────────────────────────────────────
// Plan mode handler
// ─────────────────────────────────────────────────────────────

async function runPlanMode(
  task: string,
  engine: ExecutionEngine,
  planConfig: EngineConfig,
  renderer: Renderer,
  input: InputHandler,
  history: OpenAIMessage[],
  cwd: string,
): Promise<void> {
  renderer.planModeStart()
  renderer.humanPrompt(`[PLAN] ${task}`)
  updateProgressLog(cwd, 'planning', task.slice(0, 100))

  // Run with read-only plan engine (copy of history so it stays pristine)
  const planEngine = new ExecutionEngine(planConfig, renderer)
  try {
    await planEngine.runTurn(task, [...history])
  } catch (err: unknown) {
    renderer.error(`Plan error: ${(err as Error).message}`)
    return
  }

  // Ask for confirmation
  renderer.planConfirmPrompt()
  const { text: answer, eof } = await input.readLine('')
  if (eof) return

  const confirmed = answer.trim().toLowerCase()
  if (confirmed === 'y' || confirmed === 'yes') {
    renderer.info('Executing plan...')
    renderer.humanPrompt(task)
    updateProgressLog(cwd, 'running', task.slice(0, 100))

    const startMs = Date.now()
    try {
      const { result, newHistory } = await engine.runTurn(task, history)
      history.length = 0
      history.push(...trimHistoryForNextTurn(newHistory))
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
      renderer.info(`Done in ${elapsed}s · ${result.reason}`)
    } catch (err: unknown) {
      renderer.error(`Execution error: ${(err as Error).message}`)
    }
    updateProgressLog(cwd, 'idle', 'waiting for next task')
  } else {
    renderer.info('Plan cancelled.')
    updateProgressLog(cwd, 'idle', 'waiting for next task')
  }
}

// ─────────────────────────────────────────────────────────────
// REPL — interactive conversation loop
// ─────────────────────────────────────────────────────────────

async function runRepl(
  engine: ExecutionEngine,
  planConfig: EngineConfig,
  renderer: Renderer,
  cwd: string,
  skills: Map<string, Skill>,
  hookRunner: { runUserPromptSubmit: (p: string) => void },
  consolidate?: { config: EngineConfig; semanticMemory: SemanticMemory; episodicMemory: EpisodicMemory },
  sessionDir?: string,
  resumedHistory?: OpenAIMessage[],
): Promise<void> {
  const input = new InputHandler()
  const history: OpenAIMessage[] = resumedHistory ? [...resumedHistory] : []

  const getSkillsText = (): string => {
    if (skills.size === 0) return 'No skills available.'
    const bySource = new Map<string, Skill[]>()
    for (const s of skills.values()) {
      const list = bySource.get(s.source) ?? []
      list.push(s)
      bySource.set(s.source, list)
    }
    const lines: string[] = []
    for (const [source, list] of bySource) {
      lines.push(`-- ${source} --`)
      for (const s of list) {
        lines.push(`/${s.name.padEnd(16)} ${s.description}`)
      }
    }
    return lines.join('\n')
  }

  const getSessionsText = (): string => {
    const sessions = listSessions(cwd)
    if (sessions.length === 0) return 'No saved sessions found.'
    const lines = [`Found ${sessions.length} session(s):`]
    for (const s of sessions.slice(0, 10)) {
      lines.push(`  ${s.name}  ${s.messages} msgs`)
    }
    if (sessions.length > 10) lines.push(`  ... and ${sessions.length - 10} more`)
    lines.push('', 'Resume with: ovolv999 --continue  or  ovolv999 --resume <session_name>')
    return lines.join('\n')
  }

  renderer.info(`Commands: /compact /cost /context /mode /doctor /rewind /tasks /workers /diff /commit /init /help`)
  renderer.info(`ESC to interrupt · Ctrl+D to exit`)

  let running = false
  // Whether we are currently awaiting the user's interrupt-prompt input
  // (prevents a second ESC from re-triggering softAbort while reading feedback)
  let awaitingInput = false

  // ── ESC key: soft pause — now interrupts immediately ──────────
  let lastEscMs = 0
  process.stdin.on('keypress', (_str: unknown, key: { name?: string }) => {
    if (key?.name === 'escape' && running && !awaitingInput) {
      const now = Date.now()
      if (now - lastEscMs < 800) return
      lastEscMs = now
      // Hard-abort the current tool/API call immediately (don't wait for it to finish)
      engine.abort()
      renderer.stopSpinner()
      process.stdout.write('\n')
      renderer.warn('Interrupted. Type feedback or press Enter to resume.')
    }
  })

  // ── Ctrl+C: exit ─────────────────────────────────────────────
  let sigintCount = 0
  process.on('SIGINT', () => {
    sigintCount++
    if (running) {
      engine.abort()
      renderer.stopSpinner()
      renderer.warn('Cancelled.')
      running = false
      return
    }
    // Not running
    if (sigintCount >= 2) {
      // Double Ctrl+C = force exit
      renderer.newline()
      renderer.info('Goodbye.')
      process.exit(0)
    } else {
      // First Ctrl+C when idle — warn, second exits
      renderer.warn('Press Ctrl+C again to exit, or type a command.')
      setTimeout(() => { sigintCount = 0 }, 2000)
    }
  })

  /**
   * Run one task (or task continuation) through the engine.
   * Handles the soft-interrupt resume loop internally.
   */
  async function runTask(prompt: string, taskHistory: OpenAIMessage[], startMs: number): Promise<void> {
    running = true

    let currentPrompt   = prompt
    let currentHistory  = taskHistory

    try {
      while (true) {

        const { result, newHistory } = await engine.runTurn(currentPrompt, currentHistory)

        // Update shared history with latest turn
        history.length = 0
        history.push(...trimHistoryForNextTurn(newHistory))
        currentHistory = [...history]

        // Persist session after each turn (best-effort — warn on disk failure)
        if (sessionDir) {
          try {
            saveSession(sessionDir, history)
          } catch (err: unknown) {
            renderer.warn(`Failed to persist session: ${(err as Error).message}`)
          }
        }

        if (result.reason === 'interrupted' || result.reason === 'error') {
          // ESC interrupted or error — ask for feedback, then resume
          renderer.writeInterruptPrompt()
          awaitingInput = true
          const { text: feedback, eof } = await input.readLine('')
          awaitingInput = false

          if (eof) {
            // Ctrl+D during interrupt prompt = hard exit
            break
          }

          const trimmedFeedback = feedback.trim()
          if (trimmedFeedback) {
            renderer.interruptInjected(trimmedFeedback)
            currentPrompt = `[User Interrupt]\n${trimmedFeedback}\n\nAdjust your actions based on the above feedback and continue the task.`
          } else {
            // Empty Enter = resume silently
            currentPrompt = '[Resume] Continue the task autonomously. Do not wait for further instructions.'
          }
          // Continue the while loop → runTurn again with new message
          continue
        }

        // Normal finish (stop / max_iterations / error)
        const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
        renderer.info(`Done in ${elapsed}s · ${result.reason}`)
        break
      }
    } catch (err: unknown) {
      const error = err as Error
      if (error.name !== 'AbortError') {
        renderer.error(`Error: ${error.message}`)
      }
    } finally {
      running = false
    }
  }

  while (true) {
    renderer.writePrompt()
    const { text, eof } = await input.readLine('')

    if (eof) {
      renderer.newline()
      renderer.info('Goodbye.')
      input.close()
      break
    }

    const trimmed = text.trim()
    if (!trimmed) continue
    let pendingPrompt: string | null = null

    // ── /plan command ─────────────────────────────────────────
    if (trimmed.startsWith('/plan')) {
      const planTask = trimmed.slice(5).trim()
      if (!planTask) {
        renderer.warn('Usage: /plan <task description>')
        continue
      }
      hookRunner.runUserPromptSubmit(trimmed)
      await runPlanMode(planTask, engine, planConfig, renderer, input, history, cwd)
      continue
    }

    // ── /commands ─────────────────────────────────────────────
    if (trimmed.startsWith('/')) {
      // typing "/" alone → show all commands
      if (trimmed === '/') {
        const { listCommands } = await import('../src/commands/index.js')
        const cmds = listCommands()
        renderer.newline()
        for (const cmd of cmds) {
          process.stdout.write('  \x1b[36m/' + cmd.name.padEnd(16) + '\x1b[0m \x1b[2m' + cmd.description + '\x1b[0m\n')
        }
        process.stdout.write('\n  \x1b[2mAlso: /plan <task>, /<skill_name>\x1b[0m\n\n')
        continue
      }

      // partial match: "/co" when not an exact command → show suggestions
      const partialName = trimmed.slice(1).split(/\s+/)[0] ?? ''
      const { getCommand: _getCmd, listCommands: _listCmds } = await import('../src/commands/index.js')
      const exactCmd = _getCmd(partialName)
      if (!exactCmd && partialName && !trimmed.includes(' ')) {
        // Show matching commands
        const allCmds = _listCmds()
        const matches = allCmds.filter(c => c.name.startsWith(partialName) || (c.aliases ?? []).some(a => a.startsWith(partialName)))
        const skillMatches = [...skills.values()].filter(s => s.name.startsWith(partialName))
        if (matches.length > 0) {
          renderer.newline()
          process.stdout.write('  \x1b[2mDid you mean?\x1b[0m\n')
          for (const m of matches) {
            process.stdout.write('  \x1b[36m/' + m.name.padEnd(16) + '\x1b[0m \x1b[2m' + m.description + '\x1b[0m\n')
          }
          for (const s of skillMatches) {
            process.stdout.write('  \x1b[36m/' + s.name.padEnd(16) + '\x1b[0m \x1b[2m' + s.description + '\x1b[0m\n')
          }
          renderer.newline()
        } else if (skillMatches.length > 0) {
          renderer.newline()
          process.stdout.write('  \x1b[2mDid you mean?\x1b[0m\n')
          for (const s of skillMatches) {
            process.stdout.write('  \x1b[36m/' + s.name.padEnd(16) + '\x1b[0m \x1b[2m' + s.description + '\x1b[0m\n')
          }
          renderer.newline()
        } else {
          renderer.warn('Unknown command: ' + trimmed + '. Type / for available commands.')
        }
        continue
      }

      // Try the new modular command system
      const slashCtx: SlashCommandContext = {
        engine,
        renderer,
        history,
        cwd,
        sessionDir,
        setHistory: (msgs: OpenAIMessage[]) => {
          history.length = 0
          history.push(...msgs)
        },
        runPrompt: (p: string) => {
          pendingPrompt = p
        },
        getSkillsText,
        getSessionsText,
        persistPermissions: (mode, rules) => {
          saveProjectSettings(cwd, { permissions: { mode, rules } })
          return getProjectSettingsPath(cwd)
        },
        resolveSkillPrompt: (name, args) => {
          const skill = skills.get(name)
          return skill ? expandSkillPrompt(skill, args) : null
        },
      }

      const slashResult = await dispatchSlashCommand(trimmed, slashCtx)

      if (slashResult !== null) {
        // Handle new command system result
        if (slashResult.type === 'exit') {
          if (sessionDir) {
            try {
              saveSession(sessionDir, history)
            } catch (err: unknown) {
              renderer.warn(`Failed to persist session on exit: ${(err as Error).message}`)
            }
          }
          input.close()
          break
        }
        if (slashResult.type === 'text') {
          renderer.info(slashResult.value)
        }
        if (slashResult.type === 'prompt') {
          pendingPrompt = slashResult.value
        }
        if (slashResult.type === 'clear-history') {
          history.length = 0
          if (sessionDir) {
            // /clear: atomically persist the empty history so the cleared state
            // survives a crash. No tmp file should remain afterwards.
            try {
              saveSession(sessionDir, history)
            } catch (err: unknown) {
              renderer.warn(`Failed to persist cleared history: ${(err as Error).message}`)
            }
          }
          renderer.info('Conversation history cleared.')
        }
        if (pendingPrompt) {
          renderer.humanPrompt(pendingPrompt.slice(0, 80) + (pendingPrompt.length > 80 ? ' ...' : ''))
          hookRunner.runUserPromptSubmit(pendingPrompt)
          updateProgressLog(cwd, 'running', pendingPrompt.slice(0, 100))
          await runTask(pendingPrompt, [...history], Date.now())
          updateProgressLog(cwd, 'idle', 'waiting for next task')
        }
        continue
      }

      renderer.warn('Unknown command: ' + trimmed + '. Type / for available commands.')
      continue
    }

    // ── Regular task ──────────────────────────────────────────
    renderer.humanPrompt(trimmed)
    hookRunner.runUserPromptSubmit(trimmed)
    updateProgressLog(cwd, 'running', trimmed.slice(0, 100))

    await runTask(trimmed, [...history], Date.now())
    updateProgressLog(cwd, 'idle', 'waiting for next task')
  }

  // Session consolidation (AgentOS §8 — close the learning loop)
  if (consolidate) {
    try {
      renderer.info('Consolidating memory...')
      const OpenAI = (await import('openai')).default
      const client = new OpenAI({ apiKey: consolidate.config.apiKey, baseURL: consolidate.config.baseURL })
      const result = await consolidateSession(
        client, consolidate.config.model,
        consolidate.episodicMemory, consolidate.semanticMemory,
      )
      if (result.knowledgeExtracted > 0) {
        renderer.info(`Memory consolidated: ${result.knowledgeExtracted} entries from ${result.episodes} episodes`)
      }
    } catch { /* best-effort */ }
  }

  process.exit(0)
}

// ─────────────────────────────────────────────────────────────
// Single-shot task
// ─────────────────────────────────────────────────────────────

async function runTask(
  engine: ExecutionEngine,
  renderer: Renderer,
  task: string,
  cwd: string,
  history?: OpenAIMessage[],
): Promise<void> {
  renderer.humanPrompt(task)
  updateProgressLog(cwd, 'running', task.slice(0, 100))

  const startMs = Date.now()
  const { result } = await engine.runTurn(task, history ?? [])
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)

  renderer.info(`Done in ${elapsed}s · ${result.reason}`)
  updateProgressLog(cwd, 'complete', 'done')
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { task, model, maxIter, cwd: rawCwd, help, version, loop, loopMaxIters, continueSession, resumeSession } = parseArgs(process.argv)
  const cwd = resolve(rawCwd)
  const apiEnvironment = resolveApiEnvironment()

  // Load skills early so --help can list them
  const skills = loadSkills(cwd)

  if (version) {
    process.stdout.write(`${VERSION} (ovogogogo)\n`)
    process.exit(0)
  }

  if (help) {
    printHelp(skills)
    process.exit(0)
  }

  const apiKey = apiEnvironment.apiKey
  if (!apiKey) {
    process.stderr.write(
      '\x1b[31mError:\x1b[0m no API key is configured.\n' +
        'Set OPENAI_API_KEY, or configure MiniMax through ANTHROPIC_AUTH_TOKEN.\n',
    )
    process.exit(1)
  }

  const renderer = new Renderer()
  renderer.banner(VERSION, model)
  renderer.info(`cwd: ${cwd}`)

  // Load settings + hooks
  const settings = loadSettings(cwd)
  const hookRunner = settings.hooks
    ? new HookRunner(settings.hooks, { sink: { warn: (m) => renderer.warn(m) } })
    : new NoopHookRunner()

  const hookTypes = ['PreToolCall', 'PostToolCall', 'UserPromptSubmit', 'OnError', 'OnComplete', 'OnContextOverflow'] as const
  const hasHooks = hookTypes.some(t => (settings.hooks?.[t]?.length ?? 0) > 0)
  if (hasHooks) {
    const count = hookTypes.reduce((sum, t) => sum + (settings.hooks?.[t]?.length ?? 0), 0)
    renderer.info(`Hooks: ${count} hook(s) loaded from .ovogo/settings.json`)
  }

  // Show loaded skills (project/global only, not builtins)
  const customSkills = [...skills.values()].filter((s) => s.source !== 'builtin')
  if (customSkills.length > 0) {
    renderer.info(`Skills: ${customSkills.length} custom skill(s) loaded — type /skills to list`)
  }

  // Load OVOGO.md files (project + user instructions)
  const ovogoMdFiles = loadOvogoMd(cwd)
  if (ovogoMdFiles.length > 0) {
    const labels = ovogoMdFiles.map((f) => f.type).join(', ')
    renderer.info(`OVOGO.md: ${ovogoMdFiles.length} file(s) loaded (${labels})`)
  }

  // Initialize memory system
  const memoryDir = getMemoryDir(cwd)
  const memStats = getMemoryStats(memoryDir)
  if (memStats.hasIndex) {
    renderer.info(`Memory: ${memStats.entryCount} entr${memStats.entryCount !== 1 ? 'ies' : 'y'} — ${memoryDir}`)
  } else {
    renderer.info(`Memory: initialized — ${memoryDir}`)
  }

  // Show task context if configured
  const taskContext = settings.taskContext
  if (taskContext) {
    renderer.info(`Task: ${taskContext.name ?? '未命名'} · 阶段: ${taskContext.phase ?? '未设置'}`)
    if (taskContext.scope && taskContext.scope.length > 0) {
      renderer.info(`Scope: ${taskContext.scope.join(', ')}`)
    }
  }

  const permissionManager = new PermissionManager()
  permissionManager.setMode(settings.permissions?.mode ?? 'bypassPermissions')
  for (const rule of settings.permissions?.rules ?? []) {
    permissionManager.addRule(rule)
  }
  if (settings.permissions?.mode || (settings.permissions?.rules?.length ?? 0) > 0) {
    renderer.info(`Permissions: ${permissionManager.formatMode()}`)
  }

  // Create per-session output directory (or reuse existing for --continue/--resume)
  let sessionDir: string
  let resumedHistory: OpenAIMessage[] = []
  if (resumeSession) {
    try {
      sessionDir = resolveSessionPath(cwd, resumeSession)
    } catch (err: unknown) {
      if (err instanceof AmbiguousSessionError) {
        renderer.error(err.message)
        for (const m of err.matches) renderer.error(`  - ${m}`)
        process.exit(1)
      }
      if (err instanceof SessionNotFoundError) {
        renderer.error(err.message)
        process.exit(1)
      }
      throw err
    }
    resumedHistory = loadSession(sessionDir)
    renderer.info(`Resumed session: ${sessionDir} (${resumedHistory.length} messages)`)
  } else if (continueSession) {
    const latest = findLatestSession(cwd)
    if (latest) {
      sessionDir = latest
      resumedHistory = loadSession(sessionDir)
      renderer.info(`Continued session: ${sessionDir} (${resumedHistory.length} messages)`)
    } else {
      sessionDir = createSessionDir(cwd)
      renderer.info(`No previous session found — starting new: ${sessionDir}`)
    }
  } else {
    sessionDir = createSessionDir(cwd)
  }
  renderer.info(`Session dir: ${sessionDir}`)

  // Initialize sub-agent tmux monitor
  const agentLogDir = join(sessionDir, 'agent-logs')
  const layoutReady = tmuxLayout.init(agentLogDir)
  if (layoutReady) {
    renderer.info(`Agent 监控: ${tmuxLayout.sessionHint()}`)
  }

  // Detect project context (language, framework, git status, scripts)
  const projectCtx = detectProjectContext(cwd)
  const projectCtxSection = formatProjectContext(projectCtx)
  if (projectCtx.git?.branch) {
    renderer.info(`Git: ${projectCtx.git.branch} · ${projectCtx.git.modifiedCount ?? 0} modified · ${projectCtx.git.stagedCount ?? 0} staged`)
  }

  // Build the full system prompt once (memory section injected by MemoryModule at boot)
  const skillIndex = formatSkillIndex(skills)
  // Load current mode persona — prepends its system prompt + verbosity guidance
  const modesDir = join(homedir(), '.ovogo', 'modes')
  const mode = getCurrentMode(modesDir)
  const verbosityPrompt = getVerbosityPrompt(mode.verbosity)
  const modePrompt = [mode.systemPrompt, verbosityPrompt].filter(Boolean).join('\n\n')
  const systemPrompt = buildFullSystemPrompt(cwd, ovogoMdFiles, modePrompt, taskContext, sessionDir, skillIndex, projectCtxSection)

  // Initialize optimization components
  const eventLog = new EventLog(sessionDir)
  renderer.info(`EventLog: ${eventLog.getFilePath()}`)

  const projectSlug = cwd.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 32)
  const semanticMemory = new SemanticMemory(join(homedir(), '.ovogo', 'projects', projectSlug))
  const episodicMemory = new EpisodicMemory(join(homedir(), '.ovogo', 'projects', projectSlug))

  // Register capability modules (factories read from EngineConfig at resolve time)
  globalModuleRegistry.register('memory', (ctx) =>
    new MemoryModule(ctx.config.semanticMemory!, ctx.config.episodicMemory!))
  globalModuleRegistry.register('critic', (ctx) =>
    new CriticModule(ctx.client, ctx.model, ctx.config.planMode ?? false))
  globalModuleRegistry.register('workspace', (ctx) =>
    new WorkspaceModule(ctx.config.sessionDir))
  globalModuleRegistry.register('reflection', (ctx) =>
    new ReflectionModule(ctx.client, ctx.model, ctx.config.semanticMemory!))

  const maxCtxTokens = process.env.OVOGO_MAX_CONTEXT_TOKENS
    ? parseInt(process.env.OVOGO_MAX_CONTEXT_TOKENS, 10)
    : 200_000 // default: claude-sonnet-4-x 200k; DeepSeek: set to 64000 or 128000

  // Create load_skill tool bound to the loaded skills map
  const loadSkillTool = createLoadSkillTool(skills)

  // Sub-agent factory lives on the engine config so it's owned by THIS
  // engine instance. No module-level mutable state — concurrent engines or
  // parallel Agent calls don't clobber each other. The factory closure is
  // the stable key (see src/tools/agent.ts). MUST be set on config BEFORE
  // any ExecutionEngine (or planEngine) is constructed, because the engine
  // reads `config.agentFactory` inside its constructor to wire its AgentTool.
  const agentFactory: AgentChildEngineFactory = (childConfig, childRenderer) =>
    new ExecutionEngine(childConfig, childRenderer as Renderer)

  const config: EngineConfig = {
    model,
    apiKey,
    baseURL: apiEnvironment.baseURL,
    maxIterations: maxIter,
    cwd,
    permissionMode: 'auto',
    permissionManager,
    hookRunner,
    systemPrompt,
    sessionDir,
    maxContextTokens: maxCtxTokens,
    temperature: process.env.OVOGO_TEMPERATURE ? parseFloat(process.env.OVOGO_TEMPERATURE) : undefined,
    maxOutputTokens: process.env.OVOGO_MAX_OUTPUT_TOKENS ? parseInt(process.env.OVOGO_MAX_OUTPUT_TOKENS, 10) : undefined,
    eventLog,
    semanticMemory,
    episodicMemory,
    extraTools: skills.size > 0 ? [loadSkillTool] : [],
    enabledModules: ['memory', 'critic', 'workspace', 'reflection'],
    agentFactory,
    askUserQuestion: createTerminalAskUserHandler((s) => process.stdout.write(s)),
    exitPlanMode: async (plan: string): Promise<boolean> => {
      process.stdout.write('\n\x1b[95m❯❯ Plan:\x1b[0m\n')
      process.stdout.write(plan + '\n')
      process.stdout.write('\n\x1b[93mApprove this plan? (y/n):\x1b[0m ')
      const rl = await import('readline')
      const rlInterface = rl.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdout.isTTY })
      return new Promise<boolean>((resolve) => {
        rlInterface.question('', (answer) => {
          rlInterface.close()
          resolve(answer.trim().toLowerCase().startsWith('y'))
        })
      })
    },
  }

  // Plan-mode config: read-only analysis, no reflection (plans aren't completed work).
  // Inherits the same agentFactory via spread so /plan also has a fully-wired AgentTool.
  const planPermissionManager = new PermissionManager()
  planPermissionManager.setMode('plan')
  const planConfig: EngineConfig = {
    ...config,
    planMode: true,
    permissionManager: planPermissionManager,
    enabledModules: ['memory', 'workspace'],
  }

  const engine = new ExecutionEngine(config, renderer)

  // Cleanup tmux session on exit
  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    tmuxLayout.destroy()
    // Display cost summary if any API calls were made
    const costTracker = engine.getCostTracker()
    if (costTracker.getTotalAPICalls() > 0) {
      process.stdout.write('\n' + costTracker.formatSummary() + '\n')
    }
  }
  process.on('exit', cleanup)
  process.on('SIGTERM', () => { cleanup(); process.exit(0) })
  process.on('SIGHUP',  () => { cleanup(); process.exit(0) })

  // Pipe input?
  if (!process.stdin.isTTY) {
    const piped = await readStdin()
    if (piped) {
      hookRunner.runUserPromptSubmit(piped)
      await runTask(engine, renderer, piped, cwd)
      return
    }
  }

  // Loop mode?
  if (loop) {
    const { runLoop } = await import('../src/core/loopEngine.js')
    renderer.info('Loop mode activated — reading .loop/ configuration')
    await runLoop(engine, renderer, {
      cwd,
      loopDir: join(cwd, '.loop'),
      maxIters: loopMaxIters,
    })
    return
  }

  // Single task from args?
  if (task) {
    hookRunner.runUserPromptSubmit(task)
    await runTask(engine, renderer, task, cwd, resumedHistory)
    return
  }

  // Interactive REPL
  await runRepl(engine, planConfig, renderer, cwd, skills, hookRunner, {
    config, semanticMemory, episodicMemory,
  }, sessionDir, resumedHistory)
}

main().catch((err: unknown) => {
  process.stderr.write(`\x1b[31mFatal:\x1b[0m ${(err as Error).message}\n`)
  process.exit(1)
})
