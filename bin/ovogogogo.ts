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
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
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
        const val = t.slice(eq + 1).trim()
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
import { registerAgentFactory } from '../src/tools/agent.js'
import { loadSettings } from '../src/config/settings.js'
import { HookRunner, NoopHookRunner } from '../src/config/hooks.js'
import { loadSkills, expandSkillPrompt, formatSkillIndex } from '../src/skills/loader.js'
import type { Skill } from '../src/skills/loader.js'
import { loadOvogoMd } from '../src/config/ovogomd.js'
import { getMemoryDir, getMemoryStats } from '../src/memory/index.js'
import { buildFullSystemPrompt } from '../src/prompts/system.js'
import { EventLog } from '../src/core/eventLog.js'
import { SemanticMemory } from '../src/core/semanticMemory.js'
import { EpisodicMemory } from '../src/core/episodicMemory.js'
import { globalModuleRegistry } from '../src/core/moduleRegistry.js'
import { MemoryModule } from '../src/modules/memory.js'
import { CriticModule } from '../src/modules/critic.js'
import { WorkspaceModule } from '../src/modules/workspace.js'
import { ReflectionModule, consolidateSession } from '../src/modules/reflection.js'
import { createLoadSkillTool } from '../src/tools/loadSkill.js'
import { tmuxLayout } from '../src/ui/tmuxLayout.js'

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
}

const MAX_RECENT_HISTORY_MESSAGES = 120
const MAX_PINNED_USER_MESSAGES = 12

function trimHistoryForNextTurn(messages: OpenAIMessage[]): OpenAIMessage[] {
  if (messages.length <= MAX_RECENT_HISTORY_MESSAGES) return [...messages]

  const keepIndexes = new Set<number>()
  const recentStart = Math.max(0, messages.length - MAX_RECENT_HISTORY_MESSAGES)

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
  let model = process.env.OVOGO_MODEL ?? 'gpt-4o'
  let maxIter = parseInt(process.env.OVOGO_MAX_ITER ?? '200', 10)
  let cwd = process.env.OVOGO_CWD ?? process.cwd()
  let help = false
  let version = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--help': case '-h': help = true; break
      case '--version': case '-v': case '-V': version = true; break
      case '--model': case '-m': model = args[++i] ?? model; break
      case '--max-iter': maxIter = parseInt(args[++i] ?? '30', 10); break
      case '--cwd': cwd = args[++i] ?? cwd; break
      default:
        if (!arg.startsWith('-')) task = task ? task + ' ' + arg : arg
    }
  }
  return { task, model, maxIter, cwd, help, version }
}

// ─────────────────────────────────────────────────────────────
// Help text
// ─────────────────────────────────────────────────────────────

function printHelp(skills: Map<string, Skill>): void {
  const r = new Renderer()
  r.banner(VERSION, 'gpt-4o')
  process.stdout.write(`USAGE
  ovogogogo [options] [task]

OPTIONS
  -m, --model <model>    LLM model  (env: OVOGO_MODEL, default: gpt-4o)
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
// Session directory — 按目标+时间戳隔离扫描输出
// ─────────────────────────────────────────────────────────────

function createSessionDir(cwd: string): string {
  const ts = new Date()
    .toISOString()
    .replace('T', '_')
    .replace(/:/g, '')
    .slice(0, 15)   // YYYYMMDD_HHMMSS

  const dirName = `session_${ts}`
  const sessionDir = join(cwd, 'sessions', dirName)
  mkdirSync(sessionDir, { recursive: true })
  return sessionDir
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
// Built-in REPL commands
// ─────────────────────────────────────────────────────────────

function handleBuiltin(
  cmd: string,
  history: OpenAIMessage[],
  engine: ExecutionEngine,
  renderer: Renderer,
  cwd: string,
  skills: Map<string, Skill>,
): boolean | 'exit' | { skill: Skill; args: string } {
  const parts = cmd.split(/\s+/)
  const command = parts[0]
  const rest = parts.slice(1).join(' ')

  switch (command) {
    case '/exit':
    case '/quit':
      renderer.info('Goodbye.')
      return 'exit'

    case '/clear':
      history.length = 0
      renderer.success('History cleared.')
      return true

    case '/history':
      renderer.info(`Session: ${history.length} messages in history`)
      return true

    case '/model':
      renderer.info(`Model: ${engine.getModel()}`)
      return true

    case '/cwd':
      renderer.info(`Working directory: ${cwd}`)
      return true

    case '/skills': {
      renderer.newline()
      if (skills.size === 0) {
        renderer.info('No skills available.')
        return true
      }
      const bySource = new Map<string, Skill[]>()
      for (const s of skills.values()) {
        const list = bySource.get(s.source) ?? []
        list.push(s)
        bySource.set(s.source, list)
      }
      for (const [source, list] of bySource) {
        process.stdout.write(`  \x1b[2m── ${source} ──\x1b[0m\n`)
        for (const s of list) {
          process.stdout.write(`  \x1b[36m/${s.name.padEnd(16)}\x1b[0m \x1b[2m${s.description}\x1b[0m\n`)
        }
      }
      renderer.newline()
      return true
    }

    case '/help': {
      renderer.newline()
      const COMMANDS = {
        '/plan <task>': 'Plan mode — analyze then confirm before execute',
        '/skills':      'List available skills',
        '/<skill>':     'Run a skill (e.g. /commit, /review)',
        '/clear':       'Clear conversation history',
        '/history':     'Show message count in session',
        '/model':       'Show current model',
        '/cwd':         'Show working directory',
        '/help':        'Show this help',
        '/exit':        'Exit ovogogogo',
      }
      for (const [c, desc] of Object.entries(COMMANDS)) {
        process.stdout.write(`  \x1b[36m${c.padEnd(20)}\x1b[0m ${desc}\n`)
      }
      renderer.newline()
      return true
    }

    default: {
      // Check if command matches a loaded skill
      const skillName = command.slice(1) // strip leading /
      const skill = skills.get(skillName)
      if (skill) {
        return { skill, args: rest }
      }
      renderer.warn(`Unknown command: ${command}. Type /help for available commands.`)
      return true
    }
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
): Promise<void> {
  const input = new InputHandler()
  const history: OpenAIMessage[] = []

  renderer.info(`Type your task and press Enter · /plan /skills /help /exit`)
  renderer.info(`ESC to pause/inject · Ctrl+D to exit`)

  let running = false
  // Whether we are currently awaiting the user's interrupt-prompt input
  // (prevents a second ESC from re-triggering softAbort while reading feedback)
  let awaitingInput = false

  // ── ESC key: soft pause ───────────────────────────────────────
  // readline in terminal mode calls readline.emitKeypressEvents(stdin) internally,
  // so stdin already emits 'keypress' events by the time we get here.
  // Debounce: only one soft abort per 800ms to prevent rapid repeated triggers.
  let lastEscMs = 0
  process.stdin.on('keypress', (_str: unknown, key: { name?: string }) => {
    if (key?.name === 'escape' && running && !awaitingInput) {
      const now = Date.now()
      if (now - lastEscMs < 800) return
      lastEscMs = now
      engine.softAbort()
      renderer.stopSpinner()
      process.stdout.write('\n')
      renderer.warn('⚡ 正在暂停... 当前工具完成后停止，请稍候')
    }
  })

  // ── Ctrl+C: hard kill (no two-stage logic) ───────────────────
  process.on('SIGINT', () => {
    if (running) {
      engine.abort()
      renderer.stopSpinner()
      renderer.warn('已取消。')
      running = false
    } else {
      // 不在运行中：第二次 Ctrl+C = 真正退出（cleanup 由 process.on('exit') 处理）
      renderer.newline()
      renderer.info('Goodbye.')
      process.exit(0)
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

        if (result.reason === 'interrupted') {
          // ── Soft interrupt: ask user for guidance, then resume ──
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
            currentPrompt = `[用户中途介入]\n${trimmedFeedback}\n\n请根据以上建议继续执行任务。`
          } else {
            // Empty Enter = resume silently
            currentPrompt = '[继续] 请继续自主推进任务，无需等待进一步指示。'
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

    // ── Other /commands ───────────────────────────────────────
    if (trimmed.startsWith('/')) {
      const result = handleBuiltin(trimmed, history, engine, renderer, cwd, skills)

      if (result === 'exit') {
        input.close()
        break
      }

      // Skill matched — result is {skill, args}
      if (typeof result === 'object') {
        const { skill, args } = result
        const expandedPrompt = expandSkillPrompt(skill, args)
        renderer.info(`Running skill: /${skill.name}${args ? ' ' + args : ''}`)
        hookRunner.runUserPromptSubmit(trimmed)
        renderer.humanPrompt(expandedPrompt.split('\n')[0] + (expandedPrompt.includes('\n') ? ' …' : ''))
        updateProgressLog(cwd, 'running', `/${skill.name}`)

        await runTask(expandedPrompt, [...history], Date.now())
        updateProgressLog(cwd, 'idle', 'waiting for next task')
        continue
      }

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
): Promise<void> {
  renderer.humanPrompt(task)
  updateProgressLog(cwd, 'running', task.slice(0, 100))

  const startMs = Date.now()
  const { result } = await engine.runTurn(task, [])
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)

  renderer.info(`Done in ${elapsed}s · ${result.reason}`)
  updateProgressLog(cwd, 'complete', 'done')
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { task, model, maxIter, cwd: rawCwd, help, version } = parseArgs(process.argv)
  const cwd = resolve(rawCwd)

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

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    process.stderr.write(
      '\x1b[31mError:\x1b[0m OPENAI_API_KEY is not set.\n' +
        'Export it with: export OPENAI_API_KEY=sk-...\n',
    )
    process.exit(1)
  }

  const renderer = new Renderer()
  renderer.banner(VERSION, model)
  renderer.info(`cwd: ${cwd}`)

  // Load settings + hooks
  const settings = loadSettings(cwd)
  const hookRunner = settings.hooks
    ? new HookRunner(settings.hooks)
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

  // Create per-session output directory
  const sessionDir = createSessionDir(cwd)
  renderer.info(`Session dir: ${sessionDir}`)

  // Initialize sub-agent tmux monitor
  const agentLogDir = join(sessionDir, 'agent-logs')
  const layoutReady = tmuxLayout.init(agentLogDir)
  if (layoutReady) {
    renderer.info(`Agent 监控: ${tmuxLayout.sessionHint()}`)
  }

  // Build the full system prompt once (memory section injected by MemoryModule at boot)
  const skillIndex = formatSkillIndex(skills)
  const systemPrompt = buildFullSystemPrompt(cwd, ovogoMdFiles, '', taskContext, sessionDir, skillIndex)

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

  const maxCtxTokens = 200_000 // claude-sonnet-4-x default

  // Create load_skill tool bound to the loaded skills map
  const loadSkillTool = createLoadSkillTool(skills)

  const config: EngineConfig = {
    model,
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL,
    maxIterations: maxIter,
    cwd,
    permissionMode: 'auto',
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
  }

  // Plan-mode config: read-only analysis, no reflection (plans aren't completed work)
  const planConfig: EngineConfig = {
    ...config,
    planMode: true,
    enabledModules: ['memory', 'workspace'],
  }

  const engine = new ExecutionEngine(config, renderer)

  // Register agent factory so AgentTool can spawn child engines
  registerAgentFactory(
    (childConfig, childRenderer) => new ExecutionEngine(childConfig, childRenderer as Renderer),
    config,
    renderer,
  )

  // Cleanup tmux session on exit
  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    tmuxLayout.destroy()
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

  // Single task from args?
  if (task) {
    hookRunner.runUserPromptSubmit(task)
    await runTask(engine, renderer, task, cwd)
    return
  }

  // Interactive REPL
  await runRepl(engine, planConfig, renderer, cwd, skills, hookRunner, {
    config, semanticMemory, episodicMemory,
  })
}

main().catch((err: unknown) => {
  process.stderr.write(`\x1b[31mFatal:\x1b[0m ${(err as Error).message}\n`)
  process.exit(1)
})
