/**
 * Engine assembly — the ONE place an ExecutionEngine is wired for CLI use.
 *
 * Extracted verbatim from bin/ovogogogo.ts (v0.4.1 WS3) so every front
 * door — interactive REPL, single-shot, piped stdin, --pipe, --bg child
 * re-entry, --loop — shares identical settings/hooks/permissions/model/
 * module wiring. Before this extraction, --pipe bypassed the engine
 * entirely (a raw one-shot OpenAI call) while `echo x | ovolv999` without
 * the flag ran the FULL engine — the same input got two different runtimes
 * depending on a flag.
 *
 * Contract:
 *   - session:false   → scratch sessionDir under the OS tmpdir (removed by
 *                       dispose()); NO project .ovogo/sessions dir, no
 *                       durable session state. This is the --pipe contract.
 *   - session:{new}   → createSessionDir(cwd) as before.
 *   - session:{existing} → caller-resolved resume/continue (error handling
 *                          stays in the CLI layer, which owns exit codes).
 *   - quiet:true      → suppresses the startup `renderer.info` chrome
 *                       (functional loading is unchanged).
 */

import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { createHash } from 'crypto'
import { Writable } from 'stream'
import { ExecutionEngine } from '../core/engine.js'
import type { ExecutionProfile } from '../core/effort.js'
import { Renderer } from '../ui/renderer.js'
import type { UIStore } from '../ui/ink/store.js'
import type { InkRenderer } from '../ui/ink/inkRenderer.js'
import type { SharedPrompt } from '../ui/input.js'
import type { EngineConfig, OpenAIMessage, AgentChildEngineFactory } from '../core/types.js'
import { loadSettings } from '../config/settings.js'
import type { OvogoSettings } from '../config/settings.js'
import { loadProjectConfig } from '../config/projectConfig.js'
import type { ProjectConfig } from '../config/projectConfig.js'
import { HookRunner, NoopHookRunner } from '../config/hooks.js'
import type { Skill } from '../skills/loader.js'
import { formatSkillIndex } from '../skills/loader.js'
import { loadOvogoMd } from '../config/ovogomd.js'
import { getMemoryDir, getMemoryStats } from '../memory/index.js'
import { buildFullSystemPrompt } from '../prompts/system.js'
import { getCurrentMode, getVerbosityPrompt } from '../core/modes.js'
import { EventLog } from '../core/eventLog.js'
import { SemanticMemory } from '../core/semanticMemory.js'
import { EpisodicMemory } from '../core/episodicMemory.js'
import { globalModuleRegistry } from '../core/moduleRegistry.js'
import { MemoryModule } from '../modules/memory.js'
import { CriticModule } from '../modules/critic.js'
import { WorkspaceModule } from '../modules/workspace.js'
import { ReflectionModule } from '../modules/reflection.js'
import { McpModule } from '../modules/mcp.js'
import { detectProjectContext, formatProjectContext } from '../config/projectContext.js'
import { createLoadSkillTool } from '../tools/loadSkill.js'
import { createTerminalAskUserHandler } from '../tools/askUser.js'
import { tmuxLayout } from '../ui/tmuxLayout.js'
import { PermissionManager, resolvePermissionMode } from '../core/permissionSystem.js'
import { createSessionDir } from '../core/sessionManager.js'

export type EngineFrontend = 'ink' | 'classic' | 'headless'

export type AssemblySession =
  | false
  | { mode: 'new' }
  | { mode: 'existing'; dir: string; history: OpenAIMessage[]; label: 'resumed' | 'continued' }

export interface AssemblyOptions {
  cwd: string
  apiKey: string
  baseURL?: string
  provider: string
  /** Pre-resolved model (CLI --model / env). Project config still wins inside. */
  model: string
  maxIterations: number
  frontend: EngineFrontend
  session: AssemblySession
  version: string
  skills: Map<string, Skill>
  /** Current value of the CLI's shared-prompt router (null before the REPL wires it). */
  getActivePrompt: () => SharedPrompt | null
  /** Suppress startup info chrome (pipe/headless). Functional loading unchanged. */
  quiet?: boolean
  /** Loop mode keeps the classic banner even when ink is available. */
  loop?: boolean
  /** Custom renderer (PipeRenderer for --pipe). Defaults to a classic Renderer. */
  renderer?: Renderer
  /**
   * v0.4.1 WS4 (ExecutionProfile): sticky per-engine profile override from
   * `--profile`. Mirrors the `--model` contract — a user-set override wins
   * over per-turn intent/detection until cleared with `/profile auto`.
   */
  profileOverride?: ExecutionProfile
}

export interface AssembledEngine {
  engine: ExecutionEngine
  config: EngineConfig
  planConfig: EngineConfig
  renderer: Renderer
  uiStore?: UIStore
  inkRenderer?: InkRenderer
  sessionDir: string
  resumedHistory: OpenAIMessage[]
  hookRunner: HookRunner | NoopHookRunner
  settings: OvogoSettings
  projectConfig: ProjectConfig | null
  semanticMemory: SemanticMemory
  episodicMemory: EpisodicMemory
  eventLog: EventLog
  /** The model the engine actually runs (project config wins over the CLI value). */
  model: string
  maxContextTokens: number
  /** Idempotent: engine.dispose + tmux teardown + scratch sessionDir removal. */
  dispose(): void
}

export async function assembleEngine(opts: AssemblyOptions): Promise<AssembledEngine> {
  const { cwd, frontend, loop = false, quiet = false, skills } = opts

  const renderer = opts.renderer ?? new Renderer({
    stream: frontend === 'headless'
      ? process.stderr // headless without an explicit renderer must never touch stdout
      : frontend === 'ink' && !loop
        ? new Writable({ write(_chunk, _encoding, callback) { callback() } })
        : process.stdout,
  })
  if (frontend !== 'ink' || loop) renderer.banner(opts.version, opts.model)
  if (!quiet) renderer.info(`workspace   ${cwd}`)

  // Load settings + hooks
  const settings = loadSettings(cwd)
  const projectConfig = loadProjectConfig(cwd)
  if (projectConfig && !quiet) {
    renderer.info(`config      project settings loaded`)
  }
  const hookRunner = settings.hooks
    ? new HookRunner(settings.hooks, { sink: { warn: (m) => renderer.warn(m) } })
    : new NoopHookRunner()

  const hookTypes = ['PreToolCall', 'PostToolCall', 'UserPromptSubmit', 'OnError', 'OnComplete', 'OnContextOverflow'] as const
  const hasHooks = hookTypes.some(t => (settings.hooks?.[t]?.length ?? 0) > 0)
  if (hasHooks && !quiet) {
    const count = hookTypes.reduce((sum, t) => sum + (settings.hooks?.[t]?.length ?? 0), 0)
    renderer.info(`hooks       ${count} loaded`)
  }

  // Show loaded skills (project/global only, not builtins)
  const customSkills = [...skills.values()].filter((s) => s.source !== 'builtin')
  if (customSkills.length > 0 && !quiet) {
    renderer.info(`skills      ${customSkills.length} custom · /skills`)
  }

  // Load OVOGO.md files (project + user instructions)
  const ovogoMdFiles = loadOvogoMd(cwd)
  if (ovogoMdFiles.length > 0 && !quiet) {
    const labels = ovogoMdFiles.map((f) => f.type).join(', ')
    renderer.info(`context     ${ovogoMdFiles.length} OVOGO.md · ${labels}`)
  }

  // Initialize memory system
  const memoryDir = getMemoryDir(cwd)
  const memStats = getMemoryStats(memoryDir)
  if (!quiet) {
    if (memStats.hasIndex) {
      renderer.info(`memory      ${memStats.entryCount} entr${memStats.entryCount !== 1 ? 'ies' : 'y'}`)
    } else {
      renderer.info(`memory      ready`)
    }
  }

  // Show task context if configured
  const taskContext = settings.taskContext
  if (taskContext && !quiet) {
    renderer.info(`Task: ${taskContext.name ?? '未命名'} · 阶段: ${taskContext.phase ?? '未设置'}`)
    if (taskContext.scope && taskContext.scope.length > 0) {
      renderer.info(`Scope: ${taskContext.scope.join(', ')}`)
    }
  }

  const permissionManager = new PermissionManager()
  permissionManager.setMode(resolvePermissionMode(settings.permissions?.profile, settings.permissions?.mode))
  for (const rule of settings.permissions?.rules ?? []) {
    permissionManager.addRule(rule)
  }
  if ((settings.permissions?.mode || (settings.permissions?.rules?.length ?? 0) > 0) && !quiet) {
    renderer.info(`permissions ${permissionManager.formatMode()}`)
  }

  // Session dir: caller-resolved existing (resume/continue), a fresh
  // project session, or — session:false (the --pipe contract) — a scratch
  // dir under the OS tmpdir so NO project state is written and dispose()
  // can remove it.
  let sessionDir: string
  let resumedHistory: OpenAIMessage[] = []
  let scratchSessionDir: string | null = null
  if (opts.session === false) {
    sessionDir = mkdtempSync(join(tmpdir(), 'ovolv999-pipe-'))
    scratchSessionDir = sessionDir
  } else if (opts.session.mode === 'existing') {
    sessionDir = opts.session.dir
    resumedHistory = opts.session.history
    if (!quiet) renderer.info(`session     ${opts.session.label} · ${resumedHistory.length} messages`)
  } else {
    sessionDir = createSessionDir(cwd)
    if (!quiet) renderer.info(`session     new`)
  }

  // Initialize sub-agent tmux monitor
  const agentLogDir = join(sessionDir, 'agent-logs')
  const layoutReady = tmuxLayout.init(agentLogDir)
  if (layoutReady && !quiet) {
    renderer.info(`agents      monitor ready · /workers`)
  }

  // Detect project context (language, framework, git status, scripts)
  const projectCtx = detectProjectContext(cwd)
  const projectCtxSection = formatProjectContext(projectCtx)
  if (projectCtx.git?.branch && !quiet) {
    renderer.info(`git         ${projectCtx.git.branch} · ${projectCtx.git.modifiedCount ?? 0} modified · ${projectCtx.git.stagedCount ?? 0} staged`)
  }

  // Build the full system prompt once (memory section injected by MemoryModule at boot)
  const skillIndex = formatSkillIndex(skills)
  // Load current mode persona — prepends its system prompt + verbosity guidance
  const modesDir = join(homedir(), '.ovogo', 'modes')
  const mode = getCurrentMode(modesDir)
  const verbosityPrompt = getVerbosityPrompt(mode.verbosity)
  const modePrompt = [mode.systemPrompt, verbosityPrompt].filter(Boolean).join('\n\n')
  const systemPrompt = buildFullSystemPrompt(
    cwd,
    ovogoMdFiles,
    modePrompt,
    taskContext,
    sessionDir,
    skillIndex,
    projectCtxSection,
    permissionManager.getMode(),
  )

  // Initialize optimization components
  const eventLog = new EventLog(sessionDir)

  // Project slug must match src/memory/index.ts:projectSlug — otherwise the
  // memory directory written here would be invisible to the memory loader
  // on the next session. Hash-suffixed to prevent collisions between paths
  // that sanitize to the same prefix (e.g. `/a/proj foo` and `/a/proj-foo`).
  const projectSlug = cwd.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 24) +
    '_' + createHash('sha256').update(cwd).digest('hex').slice(0, 8)
  const semanticMemory = new SemanticMemory(join(homedir(), '.ovogo', 'projects', projectSlug))
  const episodicMemory = new EpisodicMemory(join(homedir(), '.ovogo', 'projects', projectSlug))

  // Register capability modules (factories read from EngineConfig at resolve time)
  globalModuleRegistry.register('memory', (ctx) =>
    new MemoryModule(ctx.config.semanticMemory!, ctx.config.episodicMemory!))
  globalModuleRegistry.register('critic', (ctx) =>
    new CriticModule(ctx.client, ctx.model, ctx.config))
  globalModuleRegistry.register('workspace', (ctx) =>
    new WorkspaceModule(ctx.config.sessionDir))
  globalModuleRegistry.register('reflection', (ctx) =>
    new ReflectionModule(ctx.client, ctx.model, ctx.config.semanticMemory!, ctx.config))
  globalModuleRegistry.register('mcp', () => new McpModule())

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

  // ── Ink UI mode: create UIStore early so config callbacks can use it ──────
  let uiStore: UIStore | undefined
  let inkRendererInstance: InkRenderer | undefined
  if (frontend === 'ink') {
    const { UIStore: UIStoreClass } = await import('../ui/ink/store.js')
    const { InkRenderer: InkRendererClass } = await import('../ui/ink/inkRenderer.js')
    uiStore = new UIStoreClass()
    inkRendererInstance = new InkRendererClass(uiStore)
  }

  const config: EngineConfig = {
    model: projectConfig?.model ?? opts.model,
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    // Phase 1: drive ProviderAdapter selection from the resolved
    // environment (minimax vs openai today; both route through the
    // openai-compatible adapter since MiniMax M3 is served at /v1).
    provider: opts.provider,
    // Phase 2: adaptive model routing profiles (from ~/.ovogo/settings.json).
    models: settings.models,
    maxIterations: projectConfig?.maxIterations ?? opts.maxIterations,
    cwd,
    permissionMode: projectConfig?.permissionMode ?? 'auto',
    permissionManager,
    hookRunner,
    systemPrompt: projectConfig?.systemPrompt
      ? systemPrompt + '\n\n' + projectConfig.systemPrompt
      : systemPrompt,
    sessionDir,
    maxContextTokens: projectConfig?.maxContextTokens ?? maxCtxTokens,
    temperature: projectConfig?.temperature
      ?? (process.env.OVOGO_TEMPERATURE ? parseFloat(process.env.OVOGO_TEMPERATURE) : undefined),
    maxOutputTokens: process.env.OVOGO_MAX_OUTPUT_TOKENS ? parseInt(process.env.OVOGO_MAX_OUTPUT_TOKENS, 10) : undefined,
    poor: projectConfig?.poor ?? settings.poor ?? (process.env.OVOGO_POOR === '1' ? { enabled: true } : undefined),
    mcp: settings.mcp,
    eventLog,
    semanticMemory,
    episodicMemory,
    extraTools: skills.size > 0 ? [loadSkillTool] : [],
    enabledModules: projectConfig?.enabledModules
      ?? (settings.mcp?.servers?.length
        ? ['memory', 'critic', 'workspace', 'reflection', 'mcp']
        : ['memory', 'critic', 'workspace', 'reflection']),
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
          const activePrompt = opts.getActivePrompt()
          if (activePrompt) return activePrompt.isTTY
          return Boolean(process.stdout.isTTY && process.stdin.isTTY)
        },
        readLine: (p, signal) => {
          const activePrompt = opts.getActivePrompt()
          return activePrompt
            ? activePrompt.readLine(p, signal)
            : Promise.resolve({ text: '', eof: true })
        },
        close: () => opts.getActivePrompt()?.close(),
      },
      writeOut: (s) => process.stdout.write(s),
    }),
    exitPlanMode: async (plan: string): Promise<boolean> => {
      // Ink UI mode: show plan approval overlay
      if (uiStore) {
        return uiStore.showPlanApproval(plan)
      }
      // Non-TTY (pipe mode, sub-agent, before REPL has wired its readline):
      // auto-approve. This is the explicit, documented contract — we do NOT
      // wait for stdin to produce a "y" because nobody is typing.
      const activePrompt = opts.getActivePrompt()
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
    requestPermission: uiStore
      ? async (toolName, input, riskLevel) => {
          const preview = toolName === 'Bash' && typeof input.command === 'string'
            ? input.command
            : JSON.stringify(input).slice(0, 100)
           const result = await uiStore.showPermissionDialog({ toolName, preview, riskLevel })
           if (result.alwaysAllow) {
             permissionManager.addRule({
               toolName,
               ruleContent: '*',
               behavior: 'allow',
               source: 'user',
             })
           }
           return { approved: result.approved, feedback: result.feedback }
        }
      : undefined,
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

  const engine = new ExecutionEngine(config, inkRendererInstance
    ? (inkRendererInstance as unknown as Renderer)
    : renderer)

  // v0.3.1 (runtime truth contract §三.1.1): a project-configured model must
  // be recorded as a STICKY manual override. Without this call, the first
  // auto-route would override the configured choice — silently violating
  // the documented "--model is highest priority" invariant. The same call
  // also funnels through Engine.setModelByUser, which validates the
  // profile's provider matches the active transport.
  if (projectConfig?.model) {
    try {
      engine.setModelByUser(config.model)
    } catch (err) {
      renderer.warn(`Warning: --model could not be applied: ${(err as Error).message}`)
    }
  }

  // v0.4.1 WS4 (ExecutionProfile): --profile applies as a sticky override.
  // resolveExecutionProfile() consults it first, before intent/detection.
  if (opts.profileOverride) {
    engine.setExecutionProfileOverride(opts.profileOverride)
  }

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    try { engine.dispose() } catch { /* best-effort — never let cleanup throw */ }
    try { tmuxLayout.destroy() } catch { /* best-effort */ }
    if (scratchSessionDir) {
      try { rmSync(scratchSessionDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  }

  return {
    engine,
    config,
    planConfig,
    renderer,
    uiStore,
    inkRenderer: inkRendererInstance,
    sessionDir,
    resumedHistory,
    hookRunner,
    settings,
    projectConfig,
    semanticMemory,
    episodicMemory,
    eventLog,
    model: config.model,
    maxContextTokens: config.maxContextTokens ?? maxCtxTokens,
    dispose,
  }
}
