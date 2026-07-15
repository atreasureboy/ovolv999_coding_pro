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

import { resolve, join, dirname, basename } from 'path'
import { writeFileSync, readFileSync, existsSync, statSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { fileURLToPath, pathToFileURL } from 'url'

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
import { InputHandler, readStdin, type SharedPrompt } from '../src/ui/input.js'
import { runWithDeadline } from '../src/ui/turnDeadline.js'
import { trimHistoryForNextTurn } from '../src/ui/historyTrimmer.js'
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
// Shared prompt router — single source of truth for stdin reads.
//
// The REPL, AskUserQuestion, and ExitPlanMode ALL share one readline
// (owned by the REPL's InputHandler). They talk to that readline
// through this router instead of creating their own. This prevents
// the classic "second readline eats my keystrokes" bug.
//
// Before the REPL has started (pipe mode, single-shot mode, before
// runRepl creates its InputHandler), `activePrompt` is null — callers
// fall back to auto-approve (e.g. ExitPlanMode in non-TTY), which is
// exactly the contract sub-agents and piped mode already want.
// ─────────────────────────────────────────────────────────────
let activePrompt: SharedPrompt | null = null

/**
 * Save the latest session state on exit. Wired by runRepl so the
 * cleanup() in main() can persist the final history even when exit
 * is triggered by SIGINT, SIGTERM, SIGHUP, or a non-0 exit path.
 */
let saveOnExit: (() => void) | null = null

/**
 * Hard deadline for a single engine turn. If a turn exceeds this,
 * we abort the engine and treat it as a normal interrupt (the user
 * gets a chance to provide feedback before the next iteration).
 * Prevents the CLI from hanging indefinitely on a stuck turn.
 */
const HARD_TURN_DEADLINE_MS = 10 * 60 * 1000  // 10 minutes

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

/**
 * Argv parser — error on missing values instead of silently defaulting.
 *
 * The previous parser used `args[++i] ?? defaultValue`, which meant
 * `ovogogogo --model` (no value, e.g. the user forgot the argument)
 * silently kept the previous model. Same problem for `--max-iter`,
 * `--cwd`, `--loop-max-iters`. We now require an explicit value and
 * write a clear error to stderr before exiting.
 */
class ArgError extends Error {}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value === '' || value.startsWith('-')) {
    throw new ArgError(`Error: ${flag} requires a value`)
  }
  return value
}

/**
 * Expand a leading `~` or `~/...` to the current user's home directory.
 * Other `~user` forms are NOT expanded (we have no user-DB lookup here)
 * and are passed through unchanged so callers see a clear "no such
 * directory" error from the OS rather than a silent mis-anchor.
 *
 * This is applied to --cwd and --resume paths so a user can write
 * `--cwd ~/projects/foo` instead of forcing an absolute path.
 */
export function expandHome(p: string): string {
  if (typeof p !== 'string' || p.length === 0) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/**
 * Normalize a user-supplied working directory: expand `~`, then resolve
 * to an absolute path. Called once on --cwd and once on the implicit
 * `process.cwd()` default so subsequent code can rely on cwd being
 * absolute (the engine, session dir creation, settings path, etc.).
 */
export function normalizeCwd(p: string): string {
  return resolve(expandHome(p))
}

/**
 * Directory roots we refuse to use as a session directory, even if
 * `--resume <path>` points at one. Walking into `/etc` (or any other
 * system root) as a session would let a stray flag inject ovogo
 * session metadata into a location that almost certainly should not
 * hold it — and would surface later as a permissions error from a
 * `--continue` that then tries to write history.json there.
 *
 * The check is strict equality against `resolve()`d paths so a path
 * like `/etc/foo` is NOT automatically blocked (the caller probably
 * meant something specific) — only the bare system roots are refused.
 */
const DANGEROUS_SESSION_ROOTS: ReadonlySet<string> = new Set([
  '/',
  '/etc',
  '/usr',
  '/var',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/opt',
  '/root',
  '/boot',
  '/sys',
  '/proc',
  '/dev',
  '/run',
  '/srv',
])

/**
 * Resolve a `--resume <arg>` to an absolute session directory.
 *
 * Accepted forms:
 *   1. Absolute path to a `sessions/session_*` directory   → returned as-is.
 *   2. Absolute path to a `history.json` file              → normalized to its parent.
 *   3. Session name / unique prefix under `<cwd>/sessions/` → delegates to
 *      resolveSessionPath (the existing session-name lookup path).
 *
 * Rejected with SessionNotFoundError:
 *   - paths that resolve to a dangerous system root (e.g. /, /etc)
 *   - paths that resolve to a directory whose basename doesn't start with
 *     the `session_` prefix (e.g. /home/user, /tmp)
 *   - any regular file whose basename is not exactly `history.json`
 *
 * This is the gate that keeps a stray `--resume /etc` from treating
 * the OS root as a session and trying to read or write history.json
 * inside it. Without it, resolveSessionPath would happily `existsSync`
 * the path and return it — and the engine would then try to save the
 * conversation history there.
 */
export function resolveResumePath(cwd: string, input: string): string {
  assertNonEmptyString(input, 'resume input')

  // Form 3: no separators → session name / unique-prefix lookup.
  if (!input.includes('/') && !input.includes('\\')) {
    return resolveSessionPath(cwd, input)
  }

  // Form 1 + 2: an explicit path. Anchor to cwd for relative paths so
  // --resume behaves the same regardless of process.cwd().
  const abs = resolve(cwd, expandHome(input))
  if (!existsSync(abs)) {
    throw new SessionNotFoundError(`Session path does not exist: ${abs}`)
  }

  // Reject system roots BEFORE checking dir/file: a user typing
  // `--resume /` or `--resume /etc` should fail with a clear refusal,
  // not get silently accepted because some unrelated file happened to
  // exist there.
  const normalized = resolve(abs)
  if (DANGEROUS_SESSION_ROOTS.has(normalized)) {
    throw new SessionNotFoundError(
      `Refusing to use system directory as a session: ${normalized}`,
    )
  }

  let stat
  try {
    stat = statSync(abs)
  } catch (err) {
    throw new SessionNotFoundError(`Cannot stat session path: ${abs} (${(err as Error).message})`)
  }

  if (stat.isDirectory()) {
    // Accept ONLY directories whose name matches the session_ prefix.
    // Walking into `/home/user` or `/tmp` as a "session" would silently
    // accept an arbitrary directory and pollute it with history.json.
    const base = basename(normalized)
    if (!base.startsWith('session_')) {
      throw new SessionNotFoundError(
        `Not a session directory (basename must start with "session_"): ${normalized}`,
      )
    }
    // Structural check: a real session directory MUST contain a readable
    // history.json. Relying on the basename alone is too permissive —
    // any directory the user (or an attacker) names "session_xxx" would
    // be accepted, even if it holds arbitrary unrelated content. We use
    // openSync(O_RDONLY) so a permission error surfaces as a clear refusal
    // rather than being swallowed by a higher-level read.
    const historyPath = join(normalized, 'history.json')
    if (!existsSync(historyPath)) {
      throw new SessionNotFoundError(
        `Session directory missing history.json: ${normalized}`,
      )
    }
    try {
      readFileSync(historyPath)
    } catch (err) {
      throw new SessionNotFoundError(
        `Cannot read session history.json: ${historyPath} (${(err as Error).message})`,
      )
    }
    return normalized
  }

  if (stat.isFile()) {
    // Only `history.json` is a valid session handle — never a stray
    // text file or anything else.
    if (basename(normalized) !== 'history.json') {
      throw new SessionNotFoundError(
        `Not a session history file (must be named "history.json"): ${normalized}`,
      )
    }
    // Structural check: a history.json file is only meaningful when its
    // parent directory is itself a session_*-style directory. A bare
    // history.json dropped in /etc or /tmp is NOT a session — refusing
    // here means `--resume /etc/passwd.json` cannot sneak past us just
    // because the user (or a misconfigured hook) renamed the file.
    const parentDir = dirname(normalized)
    if (!basename(parentDir).startsWith('session_')) {
      throw new SessionNotFoundError(
        `History file's parent directory must be a session directory (basename must start with "session_"): ${parentDir}`,
      )
    }
    return parentDir
  }

  throw new SessionNotFoundError(`Not a regular file or directory: ${normalized}`)
}

function assertNonEmptyString(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2)
  let task: string | undefined
  let model = resolveApiEnvironment().model
  let maxIter = parseInt(process.env.OVOGO_MAX_ITER ?? '200', 10)
  if (isNaN(maxIter) || maxIter <= 0) maxIter = 200
  // OVOGO_CWD honors `~` / `~/...` just like the `--cwd` flag — both
  // paths converge through normalizeCwd before any code touches cwd.
  let cwd = normalizeCwd(process.env.OVOGO_CWD ?? process.cwd())
  let help = false
  let version = false
  let loop = false
  let loopMaxIters = 12
  let continueSession = false
  let resumeSession: string | undefined

  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      switch (arg) {
        case '--help': case '-h': help = true; break
        case '--version': case '-v': case '-V': version = true; break
        case '--model': case '-m':
          model = requireValue(arg, args[++i])
          break
        case '--max-iter':
          {
            const raw = requireValue(arg, args[++i])
            const n = parseInt(raw, 10)
            if (isNaN(n) || n <= 0) {
              throw new ArgError(`Error: --max-iter must be a positive integer (got "${raw}")`)
            }
            maxIter = n
          }
          break
        case '--cwd':
          // `~` / `~/...` are expanded here, not deferred to the OS layer
          // — that way the resolved absolute path is the one used for
          // settings, session dirs, and project-context detection.
          cwd = normalizeCwd(requireValue(arg, args[++i]))
          break
        case '--loop': loop = true; break
        case '--loop-max-iters':
          {
            const raw = requireValue(arg, args[++i])
            const n = parseInt(raw, 10)
            if (isNaN(n) || n <= 0) {
              throw new ArgError(`Error: --loop-max-iters must be a positive integer (got "${raw}")`)
            }
            loopMaxIters = n
          }
          break
        case '--continue': case '-c': continueSession = true; break
        case '--resume': case '-r':
          resumeSession = requireValue(arg, args[++i])
          break
        default:
          if (!arg.startsWith('-')) task = task ? task + ' ' + arg : arg
      }
    }
  } catch (err) {
    if (err instanceof ArgError) {
      process.stderr.write(err.message + '\n')
      process.exit(1)
    }
    throw err
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

export function printHelp(skills: Map<string, Skill>): void {
  const r = new Renderer()
  const defaultModel = resolveApiEnvironment().model
  r.banner(VERSION, defaultModel)
  process.stdout.write(`USAGE
  ovolv999 [options] [task]

OPTIONS
  -m, --model <model>       LLM model  (env: OVOGO_MODEL, default: ${defaultModel})
  --max-iter <n>            Think-Act-Observe max cycles  (env: OVOGO_MAX_ITER, default: 200)
  --cwd <path>              Working directory  (env: OVOGO_CWD, default: cwd, supports ~/)
  --loop                    Activate loop mode (reads .loop/ configuration)
  --loop-max-iters <n>      Cap on loop iterations  (env: OVOGO_LOOP_MAX_ITERS, default: 12)
  -c, --continue            Resume the most recent session under <cwd>/sessions/
  -r, --resume <ref>        Resume a specific session by name, prefix, dir, or history.json
  -v, --version             Print version and exit
  -h, --help                Show this help

ENVIRONMENT
  OPENAI_API_KEY            Required for OpenAI-compatible endpoints — API key
  OPENAI_BASE_URL           Optional — compatible endpoint URL
  ANTHROPIC_BASE_URL        Optional — when pointing at api.minimax.io/minimaxi.com/anthropic,
                            MiniMax is auto-detected and ANTHROPIC_AUTH_TOKEN is used
  ANTHROPIC_AUTH_TOKEN      MiniMax API token (replaces OPENAI_API_KEY when MiniMax is active)
  ANTHROPIC_API_KEY         Same as ANTHROPIC_AUTH_TOKEN
  ANTHROPIC_MODEL           Default model override for MiniMax (falls back to OVOGO_MODEL)
  OVOGO_MODEL               Default model when no ANTHROPIC env vars are present
  OVOGO_MAX_ITER            Default for --max-iter
  OVOGO_CWD                 Default for --cwd (supports ~ expansion)
  OVOGO_LOOP_MAX_ITERS      Default for --loop-max-iters
  OVOGO_MAX_CONTEXT_TOKENS  Context window size (default: 200000)
  OVOGO_TEMPERATURE         Sampling temperature
  OVOGO_MAX_OUTPUT_TOKENS   Cap on completion tokens

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
  /exit          Exit ovolv999

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
  ovolv999
  ovolv999 "fix the type errors in src/core"
  ovolv999 -m gpt-4o --cwd ~/projects/foo "add unit tests for engine.ts"
  echo "refactor the tool registry" | ovolv999
  ovolv999 --continue                          # resume latest session
  ovolv999 --resume session_2026-07-14_120000  # resume by name
  ovolv999 --loop --loop-max-iters 20          # activate loop mode
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
  // Wire this readline into the shared router so AskUserQuestion and
  // ExitPlanMode (configured on the engine in main()) use THIS readline
  // instead of creating their own. Without this wiring, tool prompts
  // would race the REPL for stdin and one would lose keystrokes.
  activePrompt = input.sharedPrompt()

  const history: OpenAIMessage[] = resumedHistory ? [...resumedHistory] : []

  // Idempotent save — wired into the cleanup() in main() so any exit
  // path (SIGINT, SIGTERM, normal end, Ctrl+D, /exit) persists the
  // latest history. We also call it directly on EOF and on force-exit
  // for safety, but the cleanup path is the real source of truth.
  saveOnExit = (): void => {
    if (!sessionDir) return
    try {
      saveSession(sessionDir, history)
    } catch (err: unknown) {
      renderer.warn(`Failed to persist session: ${(err as Error).message}`)
    }
  }

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
  // 2nd SIGINT (or any SIGINT after a 1.5s grace window) force-exits
  // REGARDLESS of whether a turn is running. This is the user-visible
  // "stuck turn" escape hatch — without it, a runaway tool loop that
  // ignores engine.abort() would trap the user.
  let sigintCount = 0
  let lastSigintMs = 0
  process.on('SIGINT', () => {
    sigintCount++
    const now = Date.now()
    const rapid = now - lastSigintMs < 1500
    lastSigintMs = now
    if (running && !rapid) {
      // First SIGINT during a turn: ask the engine to abort. Soft cancel —
      // the runTask loop will surface the interrupt, let the user provide
      // feedback, then resume.
      engine.abort()
      renderer.stopSpinner()
      renderer.warn('Cancelled. Press Ctrl+C again within 1.5s to force exit.')
      return
    }
    // Either we're idle, OR the user just hit Ctrl+C a second time quickly.
    // Either way: force-exit. cleanup() (registered on `process.exit` AND
    // `SIGTERM`/SIGHUP) will save the session before the process dies.
    renderer.newline()
    renderer.info('Force exit (Ctrl+C x' + sigintCount + '). Saving session...')
    try { saveOnExit?.() } catch { /* best-effort */ }
    try { input.close() } catch { /* best-effort */ }
    // Use SIGINT exit code (130) so callers can distinguish from a clean exit.
    process.exit(130)
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
        // Race the engine against a hard deadline. The timer handle
        // is owned by runWithDeadline and cleared in our finally —
        // NOT cancelled via setImmediate, which would fire on the
        // next tick and silently turn the 10-minute cap into a no-op.
        let result: { result: { reason: string; output: string }; newHistory: OpenAIMessage[] }
        let deadlineExceeded = false
        const dl = runWithDeadline(
          () => engine.runTurn(currentPrompt, currentHistory),
          {
            deadlineMs: HARD_TURN_DEADLINE_MS,
            onDeadline: () => {
              deadlineExceeded = true
              engine.abort()
            },
          },
        )
        try {
          result = await dl.promise
        } catch (err: unknown) {
          const error = err as Error
          if (error.name === 'AbortError' || deadlineExceeded) {
            renderer.warn(deadlineExceeded
              ? `Turn hit the ${HARD_TURN_DEADLINE_MS / 1000}s hard deadline — aborting.`
              : 'Turn aborted.')
            // CRITICAL — REENTRANCY: the engine's `runTurn` sets
            // `_turnInFlight = true` on entry and clears it in a
            // `finally`. The deadline fired, so we caught the
            // deadline-error first, but the engine's `runTurn` is
            // STILL settling (it observed the abort and is unwinding
            // through its own `finally`). If we prompt the user for
            // feedback and immediately loop into another `runTurn`,
            // the reentrancy guard rejects with
            // "another turn is already in progress". Awaiting
            // `dl.taskSettled` waits for the original runTurn's
            // `finally` to clear the flag. This is a never-rejecting
            // observer of the underlying task — it surfaces the
            // original task's value via `dl.taskSettled.value`
            // (e.g. partial `newHistory`) for any cleanup work.
            const settled = await dl.taskSettled
            if (settled.status === 'fulfilled' && settled.value) {
              history.length = 0
              history.push(...trimHistoryForNextTurn(settled.value.newHistory))
            }
            // Save the partial history so the user can resume.
            if (sessionDir) {
              try { saveSession(sessionDir, history) } catch { /* best-effort */ }
            }
            // Fall through to the interrupt prompt so the user can give
            // feedback (e.g. "skip this step") or just hit Enter to continue.
            renderer.writeInterruptPrompt()
            awaitingInput = true
            const { text: feedback, eof } = await input.readLine('')
            awaitingInput = false
            if (eof) break
            const trimmedFeedback = feedback.trim()
            currentPrompt = trimmedFeedback
              ? `[User Interrupt]\n${trimmedFeedback}\n\nThe previous turn exceeded a safety deadline. Adjust your actions and continue.`
              : '[Resume] The previous turn hit a safety deadline. Try a simpler approach.'
            continue
          }
          throw err
        } finally {
          // Clear the deadline timer in BOTH the success and error paths,
          // AFTER the inner promise has settled. clear() is idempotent
          // and safe to call even if the timer already fired.
          dl.clear()
        }

        // Update shared history with latest turn
        history.length = 0
        history.push(...trimHistoryForNextTurn(result.newHistory))
        currentHistory = [...history]

        // Persist session after each turn (best-effort — warn on disk failure)
        if (sessionDir) {
          try {
            saveSession(sessionDir, history)
          } catch (err: unknown) {
            renderer.warn(`Failed to persist session: ${(err as Error).message}`)
          }
        }

        if (result.result.reason === 'interrupted' || result.result.reason === 'error') {
          // ESC interrupted or error — ask for feedback, then resume
          renderer.writeInterruptPrompt()
          awaitingInput = true
          const { text: feedback, eof } = await input.readLine('')
          awaitingInput = false

          if (eof) {
            // Ctrl+D during interrupt prompt = hard exit
            // Save first so the interrupt can be resumed in a later session.
            if (sessionDir) {
              try { saveSession(sessionDir, history) } catch { /* best-effort */ }
            }
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
        renderer.info(`Done in ${elapsed}s · ${result.result.reason}`)
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
      // Ctrl+D at the prompt — save the session before exiting so the
      // user can resume with `--continue` or `--resume <session>`.
      // saveOnExit is also wired into cleanup() in main(), but we save
      // here too for a tight, deterministic path.
      if (sessionDir) {
        try { saveSession(sessionDir, history) } catch { /* best-effort */ }
      }
      renderer.newline()
      renderer.info('Goodbye.')
      input.close()
      break
    }

    const trimmed = text.trim()
    if (!trimmed) continue
    let pendingPrompt: string | null = null

    // ── /plan command ─────────────────────────────────────────
    // Match EXACTLY: `/plan` or `/plan <args>`. Previously this was
    // `trimmed.startsWith('/plan')`, which incorrectly accepted
    // `/planner`, `/planning`, `/planet`, etc. The user typed a
    // command that doesn't exist, and we silently treated it as
    // "/plan ner <task>". Now we only match the command itself.
    if (trimmed === '/plan' || trimmed.startsWith('/plan ')) {
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

  // Final save before exit — covers /exit, EOF (after we save above too
  // for safety), and the normal REPL-loop-end case. saveOnExit wired in
  // cleanup() ALSO runs (process.on('exit')) — calling it twice is safe
  // because saveSession is idempotent (the second write overwrites the
  // first with the same data).
  try { saveOnExit?.() } catch { /* best-effort */ }
  // Release the shared-prompt router so a future runRepl (in the same
  // process — unusual, but the framework supports it) starts clean.
  activePrompt = null
  saveOnExit = null
  try { input.close() } catch { /* best-effort */ }
  process.exit(0)
}

// ─────────────────────────────────────────────────────────────
// Single-shot task
//
// Used for `ovogogogo "fix the type errors"` and `echo "x" | ovogogogo`.
// After the turn completes (for any reason — including the hard
// deadline, an engine abort, or a successful stop), we persist the
// final history. Without this, a single-shot run never wrote
// history.json and `--continue` / `--resume` couldn't see it.
// ─────────────────────────────────────────────────────────────

async function runSingleTask(
  engine: ExecutionEngine,
  renderer: Renderer,
  task: string,
  cwd: string,
  historyRef: OpenAIMessage[],
  sessionDir: string | undefined,
  resumedHistory?: OpenAIMessage[],
): Promise<void> {
  renderer.humanPrompt(task)
  updateProgressLog(cwd, 'running', task.slice(0, 100))

  const startMs = Date.now()
  let result: { reason: string; output: string }
  let deadlineExceeded = false
  const dl = runWithDeadline(
    () => engine.runTurn(task, resumedHistory ?? historyRef),
    {
      deadlineMs: HARD_TURN_DEADLINE_MS,
      onDeadline: () => {
        deadlineExceeded = true
        engine.abort()
      },
    },
  )
  try {
    const out = await dl.promise
    result = out.result
    // CRITICAL: take the engine's `newHistory`, trim it for next-turn
    // budget, and write it back into the caller's `historyRef` so the
    // /continue and /resume flows see THIS turn. The previous
    // implementation discarded `out.newHistory` and saved the
    // pre-turn snapshot, meaning `echo "x" | ovogogogo` and
    // `ovogogogo "..."` never persisted the response and the user
    // could not resume.
    if (Array.isArray(out.newHistory)) {
      const trimmed = trimHistoryForNextTurn(out.newHistory)
      historyRef.length = 0
      historyRef.push(...trimmed)
    }
  } catch (err: unknown) {
    const error = err as Error
    if (deadlineExceeded) {
      renderer.warn(`Turn hit the ${HARD_TURN_DEADLINE_MS / 1000}s hard deadline.`)
    } else if (error.name !== 'AbortError') {
      renderer.error(`Error: ${error.message}`)
    }
    // Even on error/deadline, the engine may have appended messages
    // before bailing. Trim whatever is in `out.newHistory` (if
    // available via the underlying task's settled state — see
    // dl.taskSettled) and update historyRef so the partial turn
    // survives a --continue.
    const partialNewHistory = await dl.taskSettled
      .then((v) => (v.status === 'fulfilled' ? v.value?.newHistory : undefined))
      .catch(() => undefined)
    if (Array.isArray(partialNewHistory)) {
      const trimmed = trimHistoryForNextTurn(partialNewHistory)
      historyRef.length = 0
      historyRef.push(...trimmed)
    }
    if (sessionDir && historyRef.length > 0) {
      try { saveSession(sessionDir, historyRef) } catch { /* best-effort */ }
    }
    updateProgressLog(cwd, 'complete', 'done')
    return
  } finally {
    dl.clear()
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
  renderer.info(`Done in ${elapsed}s · ${result.reason}`)

  // Persist the final history so --continue / --resume can pick it up.
  // saveOnExit (set by main() for single-shot mode) covers most cases,
  // but we save here too — the engine may have appended messages after
  // the last runTask check, and a deterministic save on success is
  // easier to reason about than relying on the exit handler.
  if (sessionDir && historyRef.length > 0) {
    try { saveSession(sessionDir, historyRef) } catch { /* best-effort */ }
  }
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
    process.stdout.write(`${VERSION} (ovolv999)\n`)
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
      // resolveResumePath validates path inputs (session dirs only,
      // history.json normalization, dangerous-root refusal) before
      // delegating session-name lookups to the existing resolver.
      sessionDir = resolveResumePath(cwd, resumeSession)
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
    askUserQuestion: createTerminalAskUserHandler({
      // The handler reads `activePrompt` lazily (it can be null before
      // the REPL has wired up its readline) and falls back to
      // non-TTY auto-answers in that case.
      //
      // The TTY gate considers BOTH stdout AND stdin. Checking only
      // stdout.isTTY gives a false positive when the user redirects
      // stdout to a file/pipe but keeps stdin attached (so the program
      // thinks it can prompt, but the prompt would never reach the user).
      // We require stdin to look like a terminal too — a redirected
      // stdout is usually paired with a redirected stdin, but if it's
      // not, asking the user is still the wrong call (we'd block).
      prompt: {
        get isTTY(): boolean {
          if (activePrompt) return activePrompt.isTTY
          return Boolean(process.stdout.isTTY && process.stdin.isTTY)
        },
        readLine: (p, signal) => activePrompt
          ? activePrompt.readLine(p, signal)
          : Promise.resolve({ text: '', eof: true }),
        close: () => activePrompt?.close(),
      },
      writeOut: (s) => process.stdout.write(s),
    }),
    exitPlanMode: async (plan: string): Promise<boolean> => {
      // Non-TTY (pipe mode, sub-agent, before REPL has wired its readline):
      // auto-approve. This is the explicit, documented contract — we do NOT
      // wait for stdin to produce a "y" because nobody is typing.
      if (!activePrompt || !activePrompt.isTTY) {
        process.stdout.write('\n\x1b[95m❯❯ Plan (auto-approved in non-interactive mode):\x1b[0m\n')
        process.stdout.write(plan + '\n')
        return true
      }
      // Interactive: use the REPL's readline, not a second readline.
      process.stdout.write('\n\x1b[95m❯❯ Plan:\x1b[0m\n')
      process.stdout.write(plan + '\n')
      process.stdout.write('\n\x1b[93mApprove this plan? (y/n):\x1b[0m ')
      const { text: answer, eof } = await activePrompt.readLine('')
      if (eof) {
        // Ctrl+D during approval — treat as rejection so the LLM revises
        process.stdout.write('\n')
        return false
      }
      return answer.trim().toLowerCase().startsWith('y')
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

  // Cleanup on any exit path — must be IDEMPOTENT (signal handlers may fire
  // alongside the natural `exit` event). Order matters: save session first
  // (sync fs), then dispose engine (kills any background tasks spawned
  // via `run_in_background`), then tear down tmux, then print cost.
  //
  // The previous version feature-detected `engine.shutdown`, but
  // `ExecutionEngine` actually exposes `dispose()` — it tears down the
  // BackgroundTaskManager so a Bash `run_in_background` task that
  // outlives a turn (or the whole CLI) does not leak. We now call
  // `engine.dispose()` directly. It is documented as idempotent and
  // never-throws.
  let cleanedUp = false
  const cleanup = (): void => {
    if (cleanedUp) return
    cleanedUp = true
    try { saveOnExit?.() } catch { /* best-effort */ }
    try { engine.dispose() } catch { /* best-effort — never let cleanup throw */ }
    try { tmuxLayout.destroy() } catch { /* best-effort */ }
    // Display cost summary if any API calls were made
    try {
      const costTracker = engine.getCostTracker()
      if (costTracker.getTotalAPICalls() > 0) {
        process.stdout.write('\n' + costTracker.formatSummary() + '\n')
      }
    } catch { /* best-effort */ }
  }
  process.on('exit', cleanup)
  process.on('SIGTERM', () => { cleanup(); process.exit(0) })
  process.on('SIGHUP',  () => { cleanup(); process.exit(0) })

  // Wire saveOnExit for non-REPL modes so cleanup() persists the
  // session on every exit path. The REPL wires its own (history-mutating)
  // version; for pipe/loop/single-shot we save the static history we
  // have at exit time.
  saveOnExit = (): void => {
    if (!sessionDir) return
    try { saveSession(sessionDir, resumedHistory) } catch { /* best-effort */ }
  }

  // Pipe input?
  if (!process.stdin.isTTY) {
    const piped = await readStdin()
    if (piped) {
      hookRunner.runUserPromptSubmit(piped)
      // Update saveOnExit to capture the post-turn history snapshot
      saveOnExit = (): void => {
        if (!sessionDir) return
        try { saveSession(sessionDir, resumedHistory) } catch { /* best-effort */ }
      }
      await runSingleTask(engine, renderer, piped, cwd, resumedHistory, sessionDir, resumedHistory)
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
    await runSingleTask(engine, renderer, task, cwd, resumedHistory, sessionDir, resumedHistory)
    return
  }

  // Interactive REPL
  await runRepl(engine, planConfig, renderer, cwd, skills, hookRunner, {
    config, semanticMemory, episodicMemory,
  }, sessionDir, resumedHistory)
}

/**
 * ESM entry guard: only run main() when this file is the script invoked
 * directly by Node. When the file is imported by a test (vitest, etc.)
 * we want only the exported helpers (expandHome, normalizeCwd,
 * resolveResumePath, printHelp) — NOT the side-effecting CLI bootstrap.
 *
 * Without this guard, `import { expandHome } from '../bin/ovogogogo.js'`
 * in a test would unconditionally execute main(), banner and all, which
 * would block on stdin and spawn child engines. Vitest would still pass
 * if main() somehow completes, but tests would observe banner output,
 * session dir creation, and tmux init as side effects — and any test
 * that mocks process.exit would silently mask a real crash.
 *
 * The standard ESM guard compares import.meta.url to the URL of
 * process.argv[1] (the script Node was asked to run). On
 * `node bin/ovogogogo.ts` they match. On `import '...'` from a test
 * they don't — the test runner's own URL is in argv[1] (or argv[1]
 * is undefined when vitest runs in-process).
 *
 * **Symlink awareness**: when the CLI is shipped as a symlink
 * (e.g. `/usr/local/bin/ovolv999` → `dist/bin/ovogogogo.js`), the
 * argv[1] path is the symlink, but import.meta.url is the resolved
 * target. Without realpath, the guard would report false and the CLI
 * would silently do nothing. We realpath BOTH sides (the entry script
 * AND the import URL) so the comparison survives symlink hops. If
 * realpath fails (e.g. file deleted between argv capture and this
 * check), we fall back to the unresolved path so a transient stat
 * failure doesn't permanently disable the CLI.
 */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

const isMainModule = ((): boolean => {
  if (!process.argv[1]) return false
  try {
    // realpath argv[1] so symlink invocations like
    // `/usr/local/bin/ovolv999` → `dist/bin/ovogogogo.js` still match
    // the import URL of the resolved target. If realpath fails (e.g.
    // the file was deleted between argv capture and this check), fall
    // back to the unresolved path so a transient stat error doesn't
    // permanently disable the CLI.
    const argvResolved = safeRealpath(resolve(process.argv[1]))
    const target = pathToFileURL(argvResolved).href
    const importUrlPath = safeRealpath(fileURLToPath(import.meta.url))
    return target === import.meta.url
      || pathToFileURL(importUrlPath).href === target
  } catch {
    return false
  }
})()

if (isMainModule) {
  main().catch((err: unknown) => {
    process.stderr.write(`\x1b[31mFatal:\x1b[0m ${(err as Error).message}\n`)
    process.exit(1)
  })
}
