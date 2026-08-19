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
import { assembleEngine } from '../src/cli/engineAssembly.js'
import { ObservabilityServer, getSharedObservabilityServer } from '../src/server/httpServer.js'
import type { AssemblySession } from '../src/cli/engineAssembly.js'
import { isExecutionProfile, type ExecutionProfile } from '../src/core/effort.js'
import { Renderer } from '../src/ui/renderer.js'
import { InputHandler, readStdin, type SharedPrompt } from '../src/ui/input.js'
import { SlashSuggester } from '../src/ui/slashSuggest.js'
import { runWithDeadline } from '../src/ui/turnDeadline.js'
import { trimHistoryForNextTurn } from '../src/ui/historyTrimmer.js'
import { pipeExitCodeFor, isApiClassError, outcomeIsApiClassFailure } from '../src/ui/pipeRenderer.js'
import type { EngineConfig, OpenAIMessage } from '../src/core/types.js'
import { getProjectSettingsPath, saveProjectSettings, loadGlobalProvider } from '../src/config/settings.js'
import { runFirstRunWizard } from '../src/config/wizard.js'
import { loadSkills, expandSkillPrompt } from '../src/skills/loader.js'
import type { Skill } from '../src/skills/loader.js'
// consolidateSession removed in v0.5.3 Closure (P5).
import { dispatchSlashCommand, listCommands, type SlashCommandContext } from '../src/commands/index.js'
import '../src/commands/builtin.js' // register all built-in commands
import {
  AmbiguousSessionError,
  SessionNotFoundError,
  findLatestSession,
  formatSessionLoadDiagnostic,
  listSessions,
  loadSession,
  resolveSessionPath,
  saveSession,
  summarizeOutcome,
  type OutcomeSummary,
} from '../src/core/sessionManager.js'
import { appendCheckpoint } from '../src/core/conversationCheckpoints.js'
import type { TurnOutcome } from '../src/core/runtime/turnOutcome.js'
import { warnOnce } from '../src/utils/warnOnce.js'
import { formatErrorCardText } from '../src/utils/apiError.js'
import { renderOutcomeCard } from '../src/ui/turnOutcomeCard.js'
import { isInteractiveTerminal } from '../src/utils/tty.js'
import { probeProvider } from '../src/config/providerProbe.js'
import { createInterface } from 'readline'

// v0.3.5: single version source — read from package.json at build time.
// All CLI/checkpoint/telemetry/banner display uses this constant.
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const VERSION = (require('../package.json') as { version: string }).version

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
 * v0.4.1 WS7 (session truth): the verdict of the most recently COMPLETED
 * turn, summarized for the Envelope v2 `lastOutcome` field. Set by
 * runTask/runSingleTask on success; exit-path saves persist it so /resume
 * lists the real status instead of guessing. Mid-turn/error saves pass
 * `undefined` explicitly — an incomplete turn has no verdict, and a stale
 * one would lie.
 */
let lastOutcomeSummary: OutcomeSummary | undefined

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
  loopInitGoal?: string
  loopRestart: boolean
  continueSession: boolean
  resumeSession?: string
  ink: boolean
  pipe: boolean
  pipeFormat: 'text' | 'json'
  bg: boolean
  init: boolean
  /** v0.4.1 WS3: pipe flags promoted from the deleted pipeMode.parsePipeArgs. */
  maxStdinBytes?: number
  noContext: boolean
  baseURL?: string
  /** Hidden frozen v0.4.0 raw single-shot path (sshRemote's latency contract). */
  llmOnly: boolean
  /** v0.4.1 WS4: sticky execution-profile override (wins over intent/detection). */
  profile?: ExecutionProfile
  /** v0.5: ACP WebSocket transport. When set, runs as a WS server (no REPL). */
  acpWsPort?: number
  acpWsBind?: string
  serveEnabled?: boolean
  servePort?: number
  serveBind?: string
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
  // Windows system locations (resolve() keeps drive-relative forms like
  // "/etc" from matching the POSIX entries above, so list them explicitly).
  ...([] as string[]).concat(
    process.env.SystemRoot ?? [],
    process.env.ProgramFiles ?? [],
    process.env['ProgramFiles(x86)'] ?? [],
    join(homedir(), '..'),
  ).map((p) => resolve(p)),
  resolve('/'),
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

export function parseArgs(argv: string[]): Args {
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
  let loopMaxIters = parseInt(process.env.OVOGO_LOOP_MAX_ITERS ?? '12', 10)
  if (isNaN(loopMaxIters) || loopMaxIters <= 0) loopMaxIters = 12
  let loopInitGoal: string | undefined
  let loopRestart = false
  let continueSession = false
  let resumeSession: string | undefined
  let ink = isInteractiveTerminal()
  let pipe = false
  let pipeFormat: 'text' | 'json' = 'text'
  let bg = false
  let acpWsPort: number | undefined
  let acpWsBind: string | undefined
  let serveEnabled = false
  let servePort: number | undefined
  let serveBind: string | undefined
  let init = false
  let maxStdinBytes: number | undefined
  let noContext = false
  let baseURLFlag: string | undefined
  let llmOnly = false
  let profile: ExecutionProfile | undefined

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
        case '--loop-init':
          loopInitGoal = requireValue(arg, args[++i])
          break
        case '--loop-restart': loopRestart = true; loop = true; break
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
        case '--ink': ink = true; break
        case '--classic': ink = false; break
        case '--pipe': pipe = true; break
        case '--llm-only': llmOnly = true; break
        case '--bg': bg = true; break
        case '--acp-ws':
          {
            const raw = requireValue(arg, args[++i])
            const n = parseInt(raw, 10)
            if (isNaN(n) || n <= 0 || n > 65535) {
              throw new ArgError(`Error: --acp-ws requires a port number 1-65535 (got "${raw}")`)
            }
            acpWsPort = n
          }
          break
        case '--acp-ws-bind':
          acpWsBind = requireValue(arg, args[++i])
          break
        case '--serve':
          {
            // Optional port — a pure numeric token is consumed; omitted
            // falls back to the server's default range (7717+).
            serveEnabled = true
            const raw = args[i + 1]
            if (raw !== undefined && /^\d+$/.test(raw)) {
              const n = parseInt(raw, 10)
              if (n <= 0 || n > 65535) {
                throw new ArgError(`Error: --serve requires a port number 1-65535 (got "${raw}")`)
              }
              servePort = n
              i++
            }
          }
          break
        case '--serve-bind':
          serveBind = requireValue(arg, args[++i])
          break
        case '--init': init = true; break
        case '--no-context': noContext = true; break
        case '--max-stdin':
          {
            const raw = requireValue(arg, args[++i])
            const n = parseInt(raw, 10)
            if (isNaN(n) || n <= 0) {
              throw new ArgError(`Error: --max-stdin must be a positive integer (got "${raw}")`)
            }
            maxStdinBytes = n
          }
          break
        case '--base-url':
          baseURLFlag = requireValue(arg, args[++i])
          break
        case '--profile':
          {
            const raw = requireValue(arg, args[++i])
            if (!isExecutionProfile(raw)) {
              throw new ArgError(`Error: --profile must be one of: fast, standard, deep, autonomous (got "${raw}")`)
            }
            profile = raw
          }
          break
        case '--format':
          {
            const rawFormat = requireValue(arg, args[++i])
            if (rawFormat !== 'text' && rawFormat !== 'json') {
              throw new ArgError(`Error: --format must be "text" or "json" (got "${rawFormat}")`)
            }
            pipeFormat = rawFormat
          }
          break
        default:
          if (arg === 'init') init = true
          else if (arg.startsWith('-')) {
            // v0.4.1 WS3: unknown flags used to be silently dropped while
            // their VALUES leaked into the positional task text
            // (`--pipe --wat watval do x` ran task "watval do x"). Warn,
            // and for long flags consume the following non-dash token so
            // it cannot become task text either.
            process.stderr.write(`Warning: unknown option "${arg}" ignored\n`)
            if (arg.startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('-')) i++
          }
          else task = task ? task + ' ' + arg : arg
      }
    }
  } catch (err) {
    if (err instanceof ArgError) {
      process.stderr.write(err.message + '\n')
      process.exit(1)
    }
    throw err
  }
  return { task, model, maxIter, cwd, help, version, loop, loopMaxIters, loopInitGoal, loopRestart, continueSession, resumeSession, ink, pipe, pipeFormat, bg, init, maxStdinBytes, noContext, baseURL: baseURLFlag, llmOnly, profile, acpWsPort, acpWsBind, serveEnabled, servePort, serveBind }
}

interface ResolvedApiEnvironment {
  apiKey: string | undefined
  baseURL: string | undefined
  model: string
  provider: string
}

/**
 * MiniMax exposes both Anthropic- and OpenAI-compatible endpoints. Reuse the
 * Claude Code environment when it points at MiniMax so the CLI can share the
 * same account without copying credentials into another config file.
 */
function resolveApiEnvironment(): ResolvedApiEnvironment {
  // Priority: 1) explicit process env (power user)  2) first-run wizard
  // config in ~/.ovogo/settings.json  3) ~/.claude/settings.json (auto
  // reuse)  4) OpenAI default.

  // 1 + 3 merged for the Anthropic facade check: process env wins, then
  // the Claude settings.json fallback (the block claude code keeps under
  // "env", which is NOT exported to the shell).
  const claudeEnv = readClaudeSettingsEnv()
  const lookup = (k: string): string | undefined => process.env[k] ?? claudeEnv[k]

  const anthropicBaseURL = lookup('ANTHROPIC_BASE_URL')
  const anthropicApiKey = lookup('ANTHROPIC_AUTH_TOKEN') ?? lookup('ANTHROPIC_API_KEY')
  const isMiniMax = Boolean(
    anthropicApiKey &&
    anthropicBaseURL &&
    /^https:\/\/api\.(?:minimax\.io|minimaxi\.com)\/anthropic\/?$/i.test(anthropicBaseURL),
  )

  if (isMiniMax) {
    // MiniMax's OpenAI-compatible /v1 endpoint rejects the Anthropic-
    // protocol context-variant suffix (e.g. "MiniMax-M3[1m]"); strip it.
    const rawModel = process.env.OVOGO_MODEL ?? process.env.ANTHROPIC_MODEL ?? 'MiniMax-M3'
    return {
      apiKey: anthropicApiKey,
      baseURL: anthropicBaseURL!.replace(/\/anthropic\/?$/i, '/v1'),
      model: rawModel.replace(/\[[^\]]*\]$/, ''),
      provider: 'minimax',
    }
  }

  // 2) first-run wizard output (explicit user choice via `ovolv999 init`).
  // Beats the OpenAI default and any non-minimax Claude fallback.
  const wizard = loadGlobalProvider()
  if (wizard?.apiKey) {
    return {
      apiKey: wizard.apiKey,
      baseURL: wizard.baseURL,
      model: process.env.OVOGO_MODEL ?? wizard.model ?? 'gpt-4o',
      provider: wizard.provider ?? 'openai',
    }
  }

  return {
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
    model: process.env.OVOGO_MODEL ?? 'gpt-4o',
    provider: 'openai',
  }
}

/**
 * Read the `env` block from ~/.claude/settings.json (if present) so
 * ovolv999 can reuse the Claude Code provider config without the user
 * copying credentials into a second place. Returns {} on any error.
 */
function readClaudeSettingsEnv(): Record<string, string> {
  try {
    const path = join(homedir(), '.claude', 'settings.json')
    const raw = readFileSync(path, 'utf8')
    const env = (JSON.parse(raw) as { env?: Record<string, string> }).env
    return env && typeof env === 'object' ? env : {}
  } catch {
    return {}
  }
}

/**
 * v0.4.1 WS2: one yes/no before the first-run wizard. Questions go to
 * stderr (stdout stays clean for any consumer that captured it), and EOF
 * answers with the default instead of hanging — the readline 'close'
 * sentinel mirrors the wizard's own EOF handling.
 */
async function askYesNo(question: string, def = true): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const ans = await new Promise<string>((resolve) => {
      const onEnd = (): void => resolve('')
      rl.once('close', onEnd)
      rl.question(`${question} ${def ? '[Y/n]' : '[y/N]'} `, (a) => {
        rl.off('close', onEnd)
        resolve(a.trim())
      })
    })
    if (ans === '') return def
    return /^y(es)?$/i.test(ans)
  } finally {
    rl.close()
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
  --profile <name>          Execution profile: fast | standard | deep | autonomous  (default: auto per task)
  --serve [port]            Start the local observability server (default port 7717, binds 127.0.0.1)
  --serve-bind <host>       Bind address for --serve (default: 127.0.0.1)
  --cwd <path>              Working directory  (env: OVOGO_CWD, default: cwd, supports ~/)
  --loop                    Activate loop mode (reads .loop/ configuration)
  --loop-init <goal>        Create a safe .loop/ workspace without overwriting existing files
  --loop-restart            Discard the saved checkpoint before starting
  --loop-max-iters <n>      Cap on loop iterations  (env: OVOGO_LOOP_MAX_ITERS, default: 12)
  -c, --continue            Resume the most recent session under <cwd>/sessions/
  -r, --resume <ref>        Resume a specific session by name, prefix, dir, or history.json
  --ink                     Force the Ink/React UI
  --classic                 Use the legacy readline UI
  --pipe                    Pipe mode: read stdin as context, output to stdout (no UI)
  --format <text|json>      Output format for pipe mode (default: text)
  init                      First-run provider wizard (detects Claude Code / OpenAI; writes ~/.ovogo/settings.json)
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
${listCommands().map(c => `  /${c.name.padEnd(14)} ${c.description}`).join('\n')}
  /<skill> [args] Run a built-in or custom skill
  Plan mode: Ctrl+P (default binding) — read-only analysis, confirm before execute

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
  ovolv999 --loop-init "finish the migration"  # scaffold .loop/ contracts
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
      const { result, newHistory, outcome } = await engine.runTurn(task, history)
      history.length = 0
      history.push(...trimHistoryForNextTurn(newHistory))
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
      // v0.3.4: display the authoritative completion status, not just stop reason
      const statusDisplay = outcome?.completion?.status ?? result.reason
      const summary = `Done in ${elapsed}s · ${statusDisplay}${result.completionReasons?.length ? ' (' + result.completionReasons.join('; ') + ')' : ''}`
      if (statusDisplay === 'completed') renderer.success(summary)
      else renderer.info(summary)
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
  sessionDir?: string,
  resumedHistory?: OpenAIMessage[],
  loopMaxIters = 12,
): Promise<void> {
  const history: OpenAIMessage[] = resumedHistory ? [...resumedHistory] : []

  // Live slash suggester — see src/ui/slashSuggest.ts. Tab completes +
  // overlays filtered command/skill matches below the line as the user
  // types. Disabled automatically in non-TTY (pipe, CI) — the existing
  // post-Enter "Did you mean?" path still covers that case.
  //
  // We construct it BEFORE the InputHandler so we can pass its `complete`
  // method to readline's `completer` callback. The keypress listener
  // lives on `process.stdin` globally and would otherwise keep firing
  // across AskUserQuestion / ExitPlanMode prompts that share this
  // readline; we detach() on every prompt boundary.
  let getLineFn: () => string = () => ''
  const slashSuggester = new SlashSuggester({
    source: {
      isTTY: Boolean(process.stdout.isTTY),
      getCommands: () => listCommands().map((c) => ({ name: c.name, description: c.description })),
      getSkills: () => [...skills.values()].map((s) => ({ name: s.name, description: s.description })),
    },
    stream: process.stdout,
    getLine: () => getLineFn(),
  })

  const input = new InputHandler({ completer: slashSuggester.complete })
  // Wire this readline into the shared router so AskUserQuestion and
  // ExitPlanMode (configured on the engine in main()) use THIS readline
  // instead of creating their own. Without this wiring, tool prompts
  // would race the REPL for stdin and one would lose keystrokes.
  activePrompt = input.sharedPrompt()

  // Now that the readline exists, wire its line accessor into the suggester.
  getLineFn = () => input.getLine()

  // Idempotent save — wired into the cleanup() in main() so any exit
  // path (SIGINT, SIGTERM, normal end, Ctrl+D, /exit) persists the
  // latest history. We also call it directly on EOF and on force-exit
  // for safety, but the cleanup path is the real source of truth.
  // `currentSessionDir` is rebound on `/resume <name>` so future saves
  // land in the newly loaded session directory.
  let currentSessionDir = sessionDir
  saveOnExit = (): void => {
    if (!currentSessionDir) return
    try {
      saveSession(currentSessionDir, history, lastOutcomeSummary)
    } catch (err: unknown) {
      renderer.warn(`Failed to persist session: ${(err as Error).message}`)
    }
  }

  const loadSessionByRef = (ref: string): OpenAIMessage[] | null => {
    try {
      const dir = resolveSessionPath(cwd, ref)
      const msgs = loadSession(dir)
      currentSessionDir = dir
      return msgs
    } catch (err: unknown) {
      if (err instanceof SessionNotFoundError || err instanceof AmbiguousSessionError) {
        return null
      }
      throw err
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

  renderer.info(`ready       /help · Esc interrupt · Ctrl+D exit`)

  let running = false
  // Whether we are currently awaiting the user's interrupt-prompt input
  // (prevents a second ESC from re-triggering softAbort while reading feedback)
  let awaitingInput = false

  // ── ESC key: interrupt current turn ──────────
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
      renderer.warn('正在安全中断当前任务。可输入补充要求以开始新一轮。')
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
      // First SIGINT during a turn asks the engine to cancel cleanly.
      engine.abort()
      renderer.stopSpinner()
      renderer.warn('正在安全中断当前任务。1.5 秒内再次按 Ctrl+C 可强制退出。')
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

    // v0.4.1 WS8 (error truth): count this turn's real model call attempts
    // so a failure card reports "attempted N calls" instead of a fabricated
    // recovery claim. attemptId is the 0-based per-run call index.
    let turnApiAttempts = 0
    const unsubAttempts = engine.getEventEmitter().on('MODEL_ATTEMPT_STARTED', (e) => {
      turnApiAttempts = Math.max(turnApiAttempts, e.attemptId + 1)
    })

    try {
      while (true) {
        // Race the engine against a hard deadline. The timer handle
        // is owned by runWithDeadline and cleared in our finally —
        // NOT cancelled via setImmediate, which would fire on the
        // next tick and silently turn the 10-minute cap into a no-op.
        let result: {
          result: { reason: string; output: string }
          newHistory: OpenAIMessage[]
          outcome?: TurnOutcome
        }
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
            // Save the partial history so the user can resume. The turn is
            // INCOMPLETE here, so no verdict is persisted (v0.4.1 WS7) —
            // /resume will report this session's status as unknown rather
            // than showing a stale verdict from an earlier turn.
            if (sessionDir) {
              try {
                saveSession(sessionDir, history, undefined)
              } catch (err: unknown) {
                warnOnce('session:save:interrupt', `Failed to persist session: ${(err as Error).message}`)
              }
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

        // v0.4.1 WS7: remember this turn's verdict for exit-path saves.
        if (result.outcome) {
          lastOutcomeSummary = summarizeOutcome(result.outcome)
        }

        // Persist session after each turn — with the turn's verdict so the
        // envelope carries the persisted status (v0.4.1 WS7).
        if (sessionDir) {
          try {
            saveSession(sessionDir, history, lastOutcomeSummary)
            // Round 28 (conversation rewind): anchor this turn — /rewind
            // turn N can then restore BOTH the conversation prefix and
            // the file state as of this moment.
            appendCheckpoint(sessionDir, history, engine.getFileHistory(), currentPrompt, cwd)
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
            // Mid-interrupt history → no verdict persisted (v0.4.1 WS7).
            if (sessionDir) {
              try {
                saveSession(sessionDir, history, undefined)
              } catch (err: unknown) {
                warnOnce('session:save:interrupt', `Failed to persist session: ${(err as Error).message}`)
              }
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

        // Normal finish (stop / max_iterations / error). v0.4.1 WS8: the
        // classic REPL's FIRST structured result card — pre-WS8 it printed
        // only "Done in Xs · status" while the Ink frontend had a full card.
        const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
        if (result.outcome) {
          renderOutcomeCard(renderer, {
            outcome: result.outcome,
            elapsedSec: elapsed,
            model: engine.getModel(),
            costStr: `$${engine.getCostTracker().getTotalCost().toFixed(4)}`,
          })
        } else {
          const status = result.result.reason
          if (status === 'completed') renderer.success(`Done in ${elapsed}s`)
          else renderer.info(`Done in ${elapsed}s · ${status}`)
        }
        break
      }
    } catch (err: unknown) {
      const error = err as Error
      if (error.name !== 'AbortError') {
        // v0.4.1 WS8 (render-once): the SINGLE classic error renderer —
        // 5-section card with the session log path and the real attempt
        // count. The coordinator no longer self-renders, so this prints
        // exactly once.
        renderer.error(formatErrorCardText(err, currentSessionDir, turnApiAttempts))
      }
    } finally {
      unsubAttempts()
      running = false
    }
  }

  while (true) {
    // writePrompt draws the prompt box's top border only. The `│ › ` cursor
    // line is obtained separately via promptPrefix() and passed to readline
    // as the question prompt, so the user's typed text appears on the same
    // line as the glyph (fix(ui) 1b4353c). Round 16 changed writePrompt to
    // return void for interface uniformity and dropped this argument,
    // leaving readLine('') — the cursor line was never shown and closePrompt
    // miscounted rows. Restore the contract: draw the box, hand readline the
    // cursor-line prefix. PipeRenderer/InkRenderer are no-ops for both.
    renderer.writePrompt()
    slashSuggester.attach()
    const { text, eof } = await input.readLine(renderer.promptPrefix())
    slashSuggester.detach()
    renderer.closePrompt(text, input.isTTY)

    if (eof) {
      // Ctrl+D at the prompt — save the session before exiting so the
      // user can resume with `--continue` or `--resume <session>`.
      // saveOnExit is also wired into cleanup() in main(), but we save
      // here too for a tight, deterministic path. Idle at the prompt
      // means the last turn completed, so its verdict is persisted
      // (v0.4.1 WS7).
      if (currentSessionDir) {
        try {
          saveSession(currentSessionDir, history, lastOutcomeSummary)
        } catch (err: unknown) {
          warnOnce('session:save:repl', `Failed to persist session: ${(err as Error).message}`)
        }
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
        process.stdout.write('\n  \x1b[2mAlso: /<skill_name> runs a loaded skill; Ctrl+P toggles plan mode.\x1b[0m\n\n')
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
        runLoop: async ({ restart }) => {
          const { runLoop } = await import('../src/core/loopEngine.js')
          running = true
          try {
            await runLoop(engine, renderer, {
              cwd,
              loopDir: join(cwd, '.loop'),
              maxIters: loopMaxIters,
              restart,
            })
          } finally {
            running = false
          }
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
        loadSession: (name: string) => loadSessionByRef(name),
      }

      const slashResult = await dispatchSlashCommand(trimmed, slashCtx)

      if (slashResult !== null) {
        // Handle new command system result
        if (slashResult.type === 'exit') {
          if (currentSessionDir) {
            try {
              saveSession(currentSessionDir, history, lastOutcomeSummary)
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
          if (currentSessionDir) {
            // /clear: atomically persist the empty history so the cleared state
            // survives a crash. No tmp file should remain afterwards.
            try {
              saveSession(currentSessionDir, history)
            } catch (err: unknown) {
              renderer.warn(`Failed to persist cleared history: ${(err as Error).message}`)
            }
          }
          renderer.info('Conversation history cleared.')
        }
        if (pendingPrompt) {
          renderer.humanPrompt(pendingPrompt.slice(0, 80) + (pendingPrompt.length > 80 ? ' ...' : ''))
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
    // Round 27 (@-mention parity): the Ink frontend expands @file.path
    // references into inline <file_content> blocks — the classic REPL
    // silently passed them through as literal text. Same expansion here
    // (text-only; classic prompts don't carry images).
    let expandedPrompt = trimmed
    try {
      const { expandAtMentions } = await import('../src/ui/ink/expandAtMentions.js')
      const { text: expanded } = expandAtMentions(trimmed, cwd)
      expandedPrompt = expanded
    } catch { /* best-effort — raw prompt on failure */ }

    updateProgressLog(cwd, 'running', trimmed.slice(0, 100))

    await runTask(expandedPrompt, [...history], Date.now())
    updateProgressLog(cwd, 'idle', 'waiting for next task')
  }

  // v0.5.3 Closure (P5): consolidateSession was removed per spec
  // Option A — it duplicated LongTermMemory R5 with no independent
  // value. sessionRunIds / lastUserPrompt / lastTurnOutcome no
  // longer need to be tracked; LTM R5 already merges by
  // contentKey + RevisionBinding. See CLOSURE_NOTES.

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
  let completionStatus: string | undefined
  // v0.4.1 WS7: this turn's verdict, persisted on the success save below.
  let taskOutcomeSummary: OutcomeSummary | undefined
  // v0.4.1 WS8: the full outcome (for the result card) and the real model
  // call attempt count (for the error card's auto-recovery line).
  let finalOutcome: TurnOutcome | undefined
  let turnApiAttempts = 0
  const unsubAttempts = engine.getEventEmitter().on('MODEL_ATTEMPT_STARTED', (e) => {
    turnApiAttempts = Math.max(turnApiAttempts, e.attemptId + 1)
  })
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
    completionStatus = out.outcome?.completion.status
    if (out.outcome) {
      finalOutcome = out.outcome
      taskOutcomeSummary = summarizeOutcome(out.outcome)
      lastOutcomeSummary = taskOutcomeSummary
    }
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
      // v0.4.1 WS8 (render-once): the SINGLE classic error renderer for
      // single-shot mode — 5-section card, real session log path, real
      // attempt count. The coordinator no longer self-renders.
      renderer.error(formatErrorCardText(err, sessionDir, turnApiAttempts))
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
      // Error/deadline: the turn never produced a verdict — persist the
      // partial history WITHOUT a stale outcome (v0.4.1 WS7).
      try {
        saveSession(sessionDir, historyRef, undefined)
      } catch (err: unknown) {
        warnOnce('session:save:singleTask', `Failed to persist session: ${(err as Error).message}`)
      }
    }
    // v0.4.1 C4 (entry-semantics parity): single-shot doors must report
    // failure to the shell exactly like --pipe — same ladder, same
    // classifiers (pipeRenderer.ts). Pre-C4 this path returned normally
    // after rendering the error card, so scripts saw exit 0 off a dead
    // API key while --pipe exited 2.
    if (deadlineExceeded) {
      process.exitCode = 1
    } else if (error.name !== 'AbortError') {
      process.exitCode = isApiClassError(err) ? 2 : 1
    }
    updateProgressLog(cwd, 'complete', 'done')
    return
  } finally {
    unsubAttempts()
    dl.clear()
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
  if (finalOutcome) {
    // v0.4.1 WS8: the classic frontend's FIRST structured result card
    // (pre-WS8 single-shot mode printed only "Done in Xs · status").
    // Same twin the Ink frontend renders — one card component per frontend.
    renderOutcomeCard(renderer, {
      outcome: finalOutcome,
      elapsedSec: elapsed,
      model: engine.getModel(),
      costStr: `$${engine.getCostTracker().getTotalCost().toFixed(4)}`,
    })
  } else {
    const status = completionStatus ?? result.reason
    if (status === 'completed') renderer.success(`Done in ${elapsed}s`)
    else renderer.info(`Done in ${elapsed}s · ${status}`)
  }

  // v0.4.1 C4: the verdict the card shows IS the exit code the shell sees —
  // identical ladder to --pipe (completed→0; other verdicts→1; API-class
  // terminal failures→2). Pre-C4 a failed single-shot turn exited 0.
  if (finalOutcome) {
    let code: number = pipeExitCodeFor(finalOutcome.completion.status)
    if (code !== 0 && outcomeIsApiClassFailure(finalOutcome)) code = 2
    process.exitCode = code
  } else if (completionStatus !== undefined && completionStatus !== 'completed') {
    process.exitCode = 1
  } else if (result.reason.startsWith('completion_')) {
    process.exitCode = 1
  }

  // Persist the final history so --continue / --resume can pick it up.
  // saveOnExit (set by main() for single-shot mode) covers most cases,
  // but we save here too — the engine may have appended messages after
  // the last runTask check, and a deterministic save on success is
  // easier to reason about than relying on the exit handler. The turn's
  // verdict rides along so /resume shows the real status (v0.4.1 WS7).
  if (sessionDir && historyRef.length > 0) {
    try {
      saveSession(sessionDir, historyRef, taskOutcomeSummary)
      // Round 30: single-shot runs get a rewind anchor too (the REPL's
      // runTask already appends one per turn). Non-interactive turns are
      // resumable, so they must be rewound to a consistent anchor as well.
      appendCheckpoint(sessionDir, historyRef, engine.getFileHistory(), task.slice(0, 80), cwd)
    } catch (err: unknown) {
      warnOnce('session:save:singleTask', `Failed to persist session: ${(err as Error).message}`)
    }
  }
  updateProgressLog(cwd, 'complete', 'done')
}

// ─────────────────────────────────────────────────────────────
// Background session subcommand handler
// ─────────────────────────────────────────────────────────────
interface DaemonSubOptions {
  apiKey: string | undefined
  cwd: string
  model: string | undefined
  baseURL: string | undefined
  provider: string | undefined
}

async function handleDaemonSubcommand(args: string[], opts: DaemonSubOptions): Promise<void> {
  const sub = args[0]
  if (sub === 'start' || sub === 'run') {
    const { startAcpWebSocketServer } = await import('../src/cli/acpServer.js')
    await startAcpWebSocketServer({
      port: 8765,
      host: '127.0.0.1',
      cwd: opts.cwd,
      apiKey: opts.apiKey,
      model: opts.model,
      baseURL: opts.baseURL,
      provider: opts.provider,
    })
    return
  }
  if (sub === 'ps' || sub === 'list') {
    // Round 26 daemon consolidation: the HTTP daemon trio
    // (daemonServer/daemonClient/sessionStore) was production-dead — the
    // server was never started, so `daemon ps` always listed an empty
    // JSONL store and `daemon attach` always failed on a missing
    // OVOGO_DAEMON_PORT. These subcommands now alias the REAL session
    // system (core/backgroundSession.ts) used by the top-level
    // ps/attach/logs/stop/rm commands.
    const { listSessions, formatSessionList } = await import('../src/core/backgroundSession.js')
    const sessions = listSessions()
    process.stdout.write(formatSessionList(sessions) + '\n')
    return
  }
  if (sub === 'attach') {
    const sessionId = args[1]
    if (!sessionId) {
      process.stderr.write('Usage: ovolv999 daemon attach <sessionId>\n')
      process.exit(1)
    }
    const { attachToSession, formatSessionDetail } = await import('../src/core/backgroundSession.js')
    const handle = attachToSession(sessionId)
    if (!handle) {
      process.stderr.write(`Error: no session with id "${sessionId}"\n`)
      process.exit(1)
    }
    process.stdout.write(formatSessionDetail(handle.metadata) + '\n\n--- streaming logs (Ctrl-C to detach) ---\n')
    for await (const line of handle.stream) {
      process.stdout.write(line + '\n')
    }
    process.stdout.write('\n[session ended]\n')
    process.exit(0)
    return
  }
  if (sub === 'kill' || sub === 'rm') {
    const sessionId = args[1]
    if (!sessionId) {
      process.stderr.write('Usage: ovolv999 daemon kill <sessionId>\n')
      process.exit(1)
    }
    const { stopSession, removeSession } = await import('../src/core/backgroundSession.js')
    // Stop any live process first (plain removeSession would orphan it),
    // then delete the metadata.
    stopSession(sessionId)
    const ok = removeSession(sessionId, true)
    process.stdout.write(ok ? `deleted ${sessionId}\n` : `not found: ${sessionId}\n`)
    return
  }
  if (sub === 'help' || sub === '--help' || sub === '-h' || !sub) {
    process.stdout.write(`ovolv999 daemon <subcommand>

Subcommands:
  start                  Start the daemon (alias: run)
  ps, list               List persisted sessions
  attach <sessionId>     Attach to a running session
  kill <sessionId>       Delete a persisted session (alias: rm)

Daemon config: ~/.ovolv999/daemon.sock (start/stop)
Sessions:      background sessions (ps/attach/logs/stop/rm — same data as top-level commands)
`)
    return
  }
  process.stderr.write(`Unknown daemon subcommand: ${sub}\nRun 'ovolv999 daemon help' for usage.\n`)
  process.exit(1)
}

async function handleSessionSubcommand(cmd: string, args: string[]): Promise<void> {
  const {
    listSessions, getSession, readSessionLogs, attachToSession,
    stopSession, removeSession, cleanStaleSessions,
    formatSessionList, formatSessionDetail,
  } = await import('../src/core/backgroundSession.js')

  switch (cmd) {
    case 'ps': {
      const sessions = listSessions()
      process.stdout.write(formatSessionList(sessions) + '\n')
      process.exit(0)
      break
    }
    case 'logs': {
      const id = args[0]
      if (!id) {
        process.stderr.write('Usage: ovolv999 logs <session-id> [--tail N]\n')
        process.exit(1)
      }
      const tailIdx = args.indexOf('--tail')
      const tail = tailIdx >= 0 ? parseInt(args[tailIdx + 1] ?? '50', 10) : undefined
      const meta = getSession(id)
      if (!meta) {
        process.stderr.write(`Error: no session with id "${id}"\n`)
        process.exit(1)
      }
      const logs = readSessionLogs(id, tail ? { tailLines: tail } : {})
      process.stdout.write(logs)
      if (!logs.endsWith('\n')) process.stdout.write('\n')
      process.exit(0)
      break
    }
    case 'attach': {
      const id = args[0]
      if (!id) {
        process.stderr.write('Usage: ovolv999 attach <session-id>\n')
        process.exit(1)
      }
      const handle = attachToSession(id)
      if (!handle) {
        process.stderr.write(`Error: no session with id "${id}"\n`)
        process.exit(1)
      }
      process.stdout.write(formatSessionDetail(handle.metadata) + '\n\n--- streaming logs (Ctrl-C to detach) ---\n')
      for await (const line of handle.stream) {
        process.stdout.write(line + '\n')
      }
      process.stdout.write('\n[session ended]\n')
      process.exit(0)
      break
    }
    case 'stop': {
      const id = args[0]
      if (!id) {
        process.stderr.write('Usage: ovolv999 stop <session-id>\n')
        process.exit(1)
      }
      const ok = stopSession(id)
      if (!ok) {
        process.stderr.write(`Error: could not stop session "${id}"\n`)
        process.exit(1)
      }
      process.stdout.write(`Stopped session ${id}\n`)
      process.exit(0)
      break
    }
    case 'rm': {
      const id = args[0]
      if (!id) {
        process.stderr.write('Usage: ovolv999 rm <session-id> [--force]\n')
        process.exit(1)
      }
      const force = args.includes('--force')
      const ok = removeSession(id, force)
      if (!ok) {
        process.stderr.write(`Error: could not remove session "${id}" (running? use --force)\n`)
        process.exit(1)
      }
      process.stdout.write(`Removed session ${id}\n`)
      process.exit(0)
      break
    }
    case 'clean': {
      const n = cleanStaleSessions()
      process.stdout.write(`Cleaned ${n} stale session(s)\n`)
      process.exit(0)
      break
    }
    default:
      process.stderr.write(`Unknown session subcommand: ${cmd}\n`)
      process.exit(1)
  }
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // ── Background session subcommands (ps / attach / logs / stop / rm) ──────
  // Routed before parseArgs because bare subcommands would otherwise be
  // swallowed as the task argument.
  const sub = process.argv[2]
  if (sub === 'ps' || sub === 'sessions') {
    await handleSessionSubcommand('ps', process.argv.slice(3))
    return
  }
  if (sub === 'attach') {
    await handleSessionSubcommand('attach', process.argv.slice(3))
    return
  }
  if (sub === 'logs') {
    await handleSessionSubcommand('logs', process.argv.slice(3))
    return
  }
  if (sub === 'stop') {
    await handleSessionSubcommand('stop', process.argv.slice(3))
    return
  }

  // R6: Daemon subcommand (`ovolv999 daemon <sub>`). Distinct from
  // the bg-session subcommands above — daemon is the long-running
  // supervisor (Round 4 + Round 6). Run before parseArgs so bare
  // subcommands aren't swallowed as the task argument.
  if (sub === 'daemon') {
    const apiKey = process.env.OPENAI_API_KEY
      ?? process.env.ANTHROPIC_API_KEY
      ?? process.env.OVOGO_API_KEY
    await handleDaemonSubcommand(process.argv.slice(3), {
      apiKey,
      cwd: process.cwd(),
      model: process.env.OVOGO_MODEL,
      baseURL: process.env.OPENAI_BASE_URL,
      provider: process.env.OVOGO_PROVIDER,
    })
    return
  }
  if (sub === 'rm' || sub === 'remove') {
    await handleSessionSubcommand('rm', process.argv.slice(3))
    return
  }
  if (sub === 'clean') {
    await handleSessionSubcommand('clean', process.argv.slice(3))
    return
  }

  // If we're a background-session child, redirect output to the log file.
  const { initChildLogCapture } = await import('../src/core/backgroundSession.js')
  initChildLogCapture()

  const { task, model, maxIter, cwd: rawCwd, help, version, loop, loopMaxIters, loopInitGoal, loopRestart, continueSession, resumeSession, ink, pipe, pipeFormat, bg, init, maxStdinBytes, noContext, baseURL: baseURLFlag, llmOnly, profile, acpWsPort, acpWsBind, serveEnabled, servePort, serveBind } = parseArgs(process.argv)

  const cwd = resolve(rawCwd)
  const apiEnvironment = resolveApiEnvironment()

  // `ovolv999 init` / `--init`: interactive first-run provider wizard.
  // Writes ~/.ovogo/settings.json (provider block); resolveApiEnvironment
  // reads it next launch (process env still wins).
  if (init) {
    const { configured } = await runFirstRunWizard({})
    if (!configured) process.exit(1)
    process.exit(0)
  }

  // Load skills early so --help can list them
  const skills = loadSkills(cwd)

  if (version) {
    process.stdout.write(`${VERSION} (ovolv999)\n`)
    process.exit(0)
  }

  if (help && !pipe) {
    printHelp(skills)
    process.exit(0)
  }

  if (loopInitGoal) {
    const { initializeLoopWorkspace } = await import('../src/core/loopScaffold.js')
    const result = initializeLoopWorkspace(cwd, loopInitGoal)
    process.stdout.write(
      `Loop workspace ready: ${join(cwd, '.loop')}\n` +
      `Created ${result.created.length} file(s); preserved ${result.preserved.length} existing file(s).\n` +
      (result.acceptanceCount > 0
        ? `Detected ${result.acceptanceCount} project verification command(s).\n`
        : 'Edit .loop/ACCEPTANCE.md and replace the placeholder with a verifiable command.\n') +
      `Start with: ovolv999 --cwd ${JSON.stringify(cwd)} --loop\n`,
    )
    return
  }

  // ── LLM-only mode: frozen v0.4.0 raw single-shot path ────────────────────
  // Hidden escape hatch for latency-sensitive automation (sshRemote.ts is
  // the standing consumer — see src/core/sshRemote.ts). Bypasses the
  // execution engine: no tools, no modules, one raw chat completion.
  // v0.4.0 exposed exactly this behavior as --pipe; --pipe now runs the
  // full engine (Breaking — see CHANGELOG v0.4.1). Deliberately NOT in
  // --help: new users should get the real engine.
  if (llmOnly) {
    if (help) {
      const { getPipeHelp } = await import('../src/integrations/pipeMode.js')
      process.stdout.write(getPipeHelp() + '\n')
      process.exit(0)
    }

    const apiKey = apiEnvironment.apiKey
    if (!apiKey) {
      process.stderr.write('Error: no API key configured for pipe mode\n')
      process.exit(1)
    }

    const { readStdin, buildPrompt, estimateTokens, formatPipeOutput } = await import('../src/integrations/pipeMode.js')

    let stdinContent = ''
    if (!process.stdin.isTTY) {
      try {
        stdinContent = await readStdin(maxStdinBytes)
      } catch (err) {
        process.stderr.write(`Error reading stdin: ${(err as Error).message}\n`)
        process.exit(1)
      }
    }

    if (!task && !stdinContent.trim()) {
      process.stderr.write('Error: no prompt or stdin input provided\n')
      process.exit(1)
    }

    const OpenAI = (await import('openai')).default
    const client = new OpenAI({ apiKey, baseURL: baseURLFlag ?? apiEnvironment.baseURL })

    const fullPrompt = buildPrompt(task, stdinContent, { cwd, includeContext: !noContext })
    const startedAt = Date.now()
    let response = ''
    try {
      const resp = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: 'You are a helpful coding assistant. Respond concisely.' },
          { role: 'user', content: fullPrompt },
        ],
      })
      response = resp.choices[0]?.message?.content ?? ''
    } catch (err) {
      process.stderr.write(`API error: ${(err as Error).message}\n`)
      process.exit(2)
    }

    process.stdout.write(formatPipeOutput({
      response,
      stdinContent,
      fullPrompt,
      estimatedInputTokens: estimateTokens(fullPrompt),
      estimatedOutputTokens: estimateTokens(response),
      durationMs: Date.now() - startedAt,
    }, pipeFormat))
    if (!process.stdout.write('\n')) { /* best-effort flush */ }
    process.exit(0)
  }

  // ── Pipe mode: full engine, headless, clean stdout ───────────────────────
  // v0.4.1 WS3: --pipe now runs the SAME ExecutionEngine as every other
  // front door (tools enabled, identical permission/model precedence —
  // consistency matrix C4). The PipeRenderer enforces stdout = answer
  // only; diagnostics go to stderr. Exit ladder:
  //   0 completed · 1 partial/blocked/exhausted/cancelled/failed · 2 API throw
  // No project session dir is written and no durable session state remains
  // (assembleEngine gives this path a scratch dir it removes on dispose).
  if (serveEnabled && (pipe || acpWsPort !== undefined || llmOnly || bg)) {
    // Round 41: these modes exit before the observability server starts —
    // say so instead of silently dropping --serve.
    process.stderr.write('[serve] --serve is ignored in --pipe / --acp-ws / --llm-only / --bg modes\n')
  }

  if (acpWsPort !== undefined) {
    if (help) {
      const { getAcpWsHelp } = await import('../src/cli/acpServer.js')
      process.stdout.write(getAcpWsHelp() + '\n')
      process.exit(0)
    }
    const { startAcpWebSocketServer } = await import('../src/cli/acpServer.js')
    await startAcpWebSocketServer({
      port: acpWsPort,
      host: acpWsBind ?? '127.0.0.1',
      cwd,
      apiKey: apiEnvironment.apiKey,
      model,
      baseURL: baseURLFlag ?? apiEnvironment.baseURL,
      provider: process.env.OVOGO_PROVIDER,
    })
    return
  }

  if (pipe) {
    if (help) {
      const { getPipeHelp } = await import('../src/integrations/pipeMode.js')
      process.stdout.write(getPipeHelp() + '\n')
      process.exit(0)
    }

    const apiKey = apiEnvironment.apiKey
    if (!apiKey) {
      process.stderr.write('Error: no API key configured for pipe mode\n')
      process.exit(1)
    }

    const { readStdin, buildPrompt, formatPipeOutput } = await import('../src/integrations/pipeMode.js')

    let stdinContent = ''
    if (!process.stdin.isTTY) {
      try {
        stdinContent = await readStdin(maxStdinBytes)
      } catch (err) {
        process.stderr.write(`Error reading stdin: ${(err as Error).message}\n`)
        process.exit(1)
      }
    }

    if (!task && !stdinContent.trim()) {
      process.stderr.write('Error: no prompt or stdin input provided\n')
      process.exit(1)
    }

    const { PipeRenderer, pipeExitCodeFor, isApiClassError, outcomeIsApiClassFailure } = await import('../src/ui/pipeRenderer.js')
    const pipeRenderer = new PipeRenderer({ format: pipeFormat })
    const assembled = await assembleEngine({
      cwd,
      apiKey,
      baseURL: baseURLFlag ?? apiEnvironment.baseURL,
      provider: apiEnvironment.provider,
      model,
      maxIterations: maxIter,
      frontend: 'headless',
      session: false,
      version: VERSION,
      skills,
      quiet: true,
      getActivePrompt: () => activePrompt,
      renderer: pipeRenderer,
      profileOverride: profile,
    })

    let exitCode: number
    try {
      const fullPrompt = buildPrompt(task, stdinContent, { cwd, includeContext: !noContext })
      const { outcome } = await assembled.engine.runTurn(fullPrompt, [])
      const costTracker = assembled.engine.getCostTracker()
      const response = pipeRenderer.responseText || outcome.output
      if (pipeFormat === 'json') {
        // Frozen sshRemote envelope — keys pinned by tests/pipeMode.test.ts.
        // Stats are REAL costTracker values now (no more chars/4 estimates).
        process.stdout.write(formatPipeOutput({
          response,
          stdinContent,
          fullPrompt,
          estimatedInputTokens: costTracker.getTotalInputTokens(),
          estimatedOutputTokens: costTracker.getTotalOutputTokens(),
          durationMs: costTracker.getTotalAPIDurationMs(),
        }, 'json'))
        process.stdout.write('\n')
      } else if (pipeRenderer.responseText === '') {
        // Nothing streamed (e.g. a non-streaming transport fell back) —
        // emit the coordinator's final output instead of printing nothing,
        // but ONLY for a completed turn: on a failed turn outcome.output
        // is the error text (`[Error: ...]`), and stdout stays answer-only.
        if (outcome.completion.status === 'completed') {
          process.stdout.write(response + '\n')
        }
      } else {
        process.stdout.write('\n')
      }
      exitCode = pipeExitCodeFor(outcome.completion.status)
      if (exitCode !== 0 && outcomeIsApiClassFailure(outcome)) {
        // The coordinator absorbs API failures into a `failed` outcome
        // (circuit breaker) instead of throwing — escalate here so a dead
        // provider / bad key is still distinguishable from a failed task.
        exitCode = 2
      }
      if (exitCode !== 0) {
        const attempts = outcome.modelAttempts ?? []
        const lastError = attempts.length > 0 ? attempts[attempts.length - 1].error : undefined
        process.stderr.write(exitCode === 2 && lastError
          ? `pipe: API error: ${lastError}\n`
          : `pipe: task ended with status "${outcome.completion.status}"\n`)
      }
    } catch (err) {
      process.stderr.write(`pipe: ${(err as Error).message}\n`)
      exitCode = isApiClassError(err) ? 2 : 1
    } finally {
      assembled.dispose()
    }
    process.exit(exitCode)
  }

  // v0.4.1 WS2 (first-run closure): a missing API key is no longer a dead
  // end. Interactive terminals get ONE question → the first-run wizard →
  // a real provider probe → fall-through into the main UI (no exit, no
  // "re-run to continue" dance). Non-TTY callers (CI, pipes, cron) get an
  // actionable stderr block and exit 1 — the wizard's readline would hang
  // on their closed stdin.
  if (!apiEnvironment.apiKey) {
    if (!isInteractiveTerminal()) {
      process.stderr.write(
        '\x1b[31mError:\x1b[0m no API key is configured.\n\n' +
          'Configure one, then re-run:\n' +
          '  export OPENAI_API_KEY=<your key>      # or run: ovolv999 init\n\n' +
          'MiniMax users: set ANTHROPIC_AUTH_TOKEN (+ ANTHROPIC_BASE_URL).\n',
      )
      process.exit(1)
    }
    const proceed = await askYesNo('\nNo API key configured. Run first-time setup now?', true)
    if (proceed) {
      const { configured } = await runFirstRunWizard({})
      // Re-resolve: loadGlobalProvider() now reads the just-saved key.
      if (configured) Object.assign(apiEnvironment, resolveApiEnvironment())
    }
    if (!apiEnvironment.apiKey) {
      process.stderr.write('\x1b[31mError:\x1b[0m no API key configured. Re-run `ovolv999 init` when ready.\n')
      process.exit(1)
    }
    // Prove the freshly-saved config reaches a model BEFORE the user sits
    // down at the UI — streaming + tool calling, the two capabilities every
    // turn depends on. Failure renders the honest five-section card but
    // KEEPS the saved config (an offline user is not locked out: fix the
    // network and re-run, no re-setup).
    process.stderr.write(`Probing provider (${model ?? apiEnvironment.model})…\n`)
    const probe = await probeProvider({
      apiKey: apiEnvironment.apiKey,
      baseURL: baseURLFlag ?? apiEnvironment.baseURL,
      model: model ?? apiEnvironment.model,
    })
    if (!probe.ok) {
      process.stderr.write(formatErrorCardText(probe.error ?? new Error('provider probe failed'), undefined, 1) + '\n')
      process.stderr.write('\x1b[33m⚠\x1b[0m Config kept in ~/.ovogo/settings.json — fix the key or network and re-run `ovolv999`.\n')
      process.exit(1)
    }
    process.stderr.write(`✓ Provider reachable (${probe.model}, ${probe.latencyMs}ms) — starting ovolv999.\n`)
  }
  const apiKey = apiEnvironment.apiKey

  // ── Background mode: spawn a detached session and exit ───────────────────
  if (bg) {
    if (!task) {
      process.stderr.write('Error: --bg requires a task to run in the background\n')
      process.exit(1)
    }
    const { startBackgroundSession, formatSessionDetail, loadMetadata } = await import('../src/core/backgroundSession.js')
    const result = startBackgroundSession({ task, cwd, model })
    const meta = loadMetadata(result.sessionId)
    if (meta) {
      process.stdout.write(formatSessionDetail(meta) + '\n')
      process.stdout.write(`\nSession ${result.sessionId} started in the background.\n`)
      process.stdout.write(`Use 'ovolv999 logs ${result.sessionId}' to view output.\n`)
      process.stdout.write(`Use 'ovolv999 ps' to list sessions.\n`)
    }
    process.exit(0)
  }

  // Resolve session inputs here — the CLI layer owns exit codes, so
  // ambiguous/not-found resume errors surface before assembly. The
  // assembly consumes the resolved dir/history (see engineAssembly.ts).
  let assemblySession: AssemblySession
  if (resumeSession) {
    let resumedDir: string
    try {
      // resolveResumePath validates path inputs (session dirs only,
      // history.json normalization, dangerous-root refusal) before
      // delegating session-name lookups to the existing resolver.
      resumedDir = resolveResumePath(cwd, resumeSession)
    } catch (err: unknown) {
      if (err instanceof AmbiguousSessionError) {
        process.stderr.write(err.message + '\n')
        for (const m of err.matches) process.stderr.write(`  - ${m}\n`)
        process.exit(1)
      }
      if (err instanceof SessionNotFoundError) {
        process.stderr.write(err.message + '\n')
        process.exit(1)
      }
      throw err
    }
    try {
      assemblySession = { mode: 'existing', dir: resumedDir, history: loadSession(resumedDir), label: 'resumed' }
    } catch (err) {
      process.stderr.write(formatSessionLoadDiagnostic(err, resumedDir) + '\n')
      process.exit(1)
    }
  } else if (continueSession) {
    const latest = findLatestSession(cwd)
    if (latest) {
      try {
        assemblySession = { mode: 'existing', dir: latest, history: loadSession(latest), label: 'continued' }
      } catch (err) {
        process.stderr.write(formatSessionLoadDiagnostic(err, latest) + '\n')
        process.exit(1)
      }
    } else {
      assemblySession = { mode: 'new' }
    }
  } else {
    assemblySession = { mode: 'new' }
  }

  // v0.4.1 WS3: ONE shared assembly for every front door — interactive,
  // single-shot, piped stdin, --pipe (above), --bg child re-entry, --loop.
  // Settings/hooks/permissions/model-preference/module wiring cannot drift
  // between entry paths anymore.
  const assembled = await assembleEngine({
    cwd,
    apiKey,
    baseURL: baseURLFlag ?? apiEnvironment.baseURL,
    provider: apiEnvironment.provider,
    model,
    maxIterations: maxIter,
    frontend: ink ? 'ink' : 'classic',
    loop,
    session: assemblySession,
    version: VERSION,
    skills,
    getActivePrompt: () => activePrompt,
    profileOverride: profile,
  })
  const {
    engine,
    planConfig,
    renderer,
    uiStore,
    inkRenderer: inkRendererInstance,
    sessionDir,
    resumedHistory,
    maxContextTokens: maxCtxTokens,
    model: effectiveModel,
  } = assembled

  // Round 38 (--serve): local observability server — /health /sessions
  // /session/<name> /events (SSE of every RunEvent). Zero-dep, binds
  // 127.0.0.1 by default; walks the port range on EADDRINUSE. Attached
  // to the live engine so model switches / tool calls / routing decisions
  // stream out in real time.
  let obsServer: ObservabilityServer | null = null
  if (serveEnabled) {
    // Round 41 audit fix: use the SHARED instance — a private `new` here
    // made --serve and /serve operate two invisible servers (status lied,
    // stop couldn't stop, a second server started on a walked port).
    obsServer = getSharedObservabilityServer(cwd, servePort, serveBind)
    await obsServer.start()
    obsServer.attachEngine(engine)
    const url = obsServer.url ?? '(unknown)'
    process.stderr.write(`[serve] observability server on ${url} — /health · /sessions · /events (SSE)\n`)
  }

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
    try { void obsServer?.stop() } catch { /* best-effort */ }
    try { saveOnExit?.() } catch { /* best-effort */ }
    // Idempotent: engine.dispose + tmux teardown (+ scratch dir removal
    // for headless runs) — see engineAssembly.ts.
    try { assembled.dispose() } catch { /* best-effort — never let cleanup throw */ }
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

  // Crash handlers for non-Ink modes. The Ink REPL registers its own
  // comprehensive set via registerCleanup(); pipe, single-shot, loop, and
  // the vim REPL do not. Without these, an unhandled rejection (e.g. a
  // daemon socket error, a stream consumer race) would tear the process
  // down without running `cleanup()` — leaking background tasks, the tmux
  // worker, and skipping the session save. Wire them unconditionally;
  // they are idempotent alongside the Ink registration (both call into
  // the same best-effort `cleanup`, which early-returns once cleanedUp).
  const crashHandler = (): void => { cleanup(); process.exit(1) }
  process.on('uncaughtException', crashHandler)
  process.on('unhandledRejection', crashHandler)

  // Wire saveOnExit for non-REPL modes so cleanup() persists the
  // session on every exit path. The REPL wires its own (history-mutating)
  // version; for pipe/loop/single-shot we save the static history we
  // have at exit time. v0.4.1 WS7: the last completed turn's verdict
  // (set by runSingleTask) rides along when present.
  saveOnExit = (): void => {
    if (!sessionDir) return
    try {
      saveSession(sessionDir, resumedHistory, lastOutcomeSummary)
    } catch (err: unknown) {
      warnOnce('session:save:exit', `Failed to persist session: ${(err as Error).message}`)
    }
  }

  // Pipe input?
  if (!process.stdin.isTTY) {
    const piped = await readStdin()
    if (piped) {
      // Update saveOnExit to capture the post-turn history snapshot
      saveOnExit = (): void => {
        if (!sessionDir) return
        try {
          saveSession(sessionDir, resumedHistory, lastOutcomeSummary)
        } catch (err: unknown) {
          warnOnce('session:save:exit', `Failed to persist session: ${(err as Error).message}`)
        }
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
      restart: loopRestart,
    })
    return
  }

  // Single task from args?
  if (task) {
    await runSingleTask(engine, renderer, task, cwd, resumedHistory, sessionDir, resumedHistory)
    return
  }

  // Interactive REPL
  if (ink && uiStore && inkRendererInstance) {
    const { runInkRepl } = await import('../src/ui/ink/runInkRepl.js')
    const skillsArray = [...skills.values()].map((s) => ({ name: s.name, description: s.description }))
    await runInkRepl({
      store: uiStore,
      engine,
      inkRenderer: inkRendererInstance,
      version: VERSION,
      model: effectiveModel,
      skills: skillsArray,
      cwd,
      sessionDir,
      resumedHistory,
      maxContextTokens: maxCtxTokens,
      loopMaxIters,
    })
    return
  }

  await runRepl(engine, planConfig, renderer, cwd, skills, sessionDir, resumedHistory, loopMaxIters)
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
