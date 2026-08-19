/**
 * Agent Configuration — replaces hardcoded AgentType enum with composable config.
 *
 * Core principle (from AgentOS): all agents share one runtime (Harness).
 * Differentiated capabilities come from module combination, NOT from type enum.
 *
 * Usage:
 *   // By preset name (backward compat with subagent_type)
 *   const config = resolveAgentConfig({ preset: 'explore' })
 *
 *   // Custom (no preset needed)
 *   const config = resolveAgentConfig({
 *     config: {
 *       identity: { systemPrompt: (cwd) => `...` },
 *       modules: { memory: { enabled: true } },
 *       tools: ['Bash', 'Read', 'Grep'],
 *       maxIterations: 50,
 *     }
 *   })
 */

import type { EngineConfig } from './types.js'
import { getCustomAgent, customAgentToConfig, customAgentNames } from './customAgents.js'

/** Module enablement configuration */
export interface ModuleConfig {
  memory?: { enabled: true; contextBudgetRatio?: number }
  critic?: { enabled: true; interval?: number }
  workspace?: { enabled: true; sessionDir?: string }
  reflection?: { enabled: true; minToolCalls?: number }
}

/** Agent identity — role persona and access mode */
export interface AgentIdentity {
  /** System prompt builder — receives cwd, returns the full identity prompt */
  systemPrompt: (cwd: string) => string
  /** If true, restrict to read-only tools (plan mode) */
  planMode?: boolean
}

/** Agent configuration — composable, no type enum */
export interface AgentConfig {
  /** Identity / role persona */
  identity: AgentIdentity
  /** Enabled capability modules */
  modules?: ModuleConfig
  /** Tool whitelist — undefined = all registered tools */
  tools?: string[]
  /**
   * Tool DENYLIST — applied AFTER `tools` so entries here are removed
   * even if they appear in the allowlist. Lets a preset ship a default
   * allowlist while still letting the caller take a specific tool away
   * (e.g. an explore preset that defaults to read-only tools but ALSO
   * asserts "no Bash" as a defense-in-depth check on top of `tools`).
   * Sub-agents also get a global denylist applied on top — see
   * {@link SUB_AGENT_DISALLOWED_TOOLS}.
   */
  disallowedTools?: string[]
  /** Skill IDs (future — for lazy-loaded skill system) */
  skills?: string[]
  /** Execution limits */
  maxIterations?: number
  maxOutputTokens?: number
  temperature?: number
}

/** Derive enabled module names from ModuleConfig */
export function deriveModuleNames(modules?: ModuleConfig): string[] | undefined {
  if (!modules) return undefined
  return Object.entries(modules)
    .filter(([, v]) => v != null && (v as { enabled?: boolean }).enabled === true)
    .map(([k]) => k)
}

// ─── Built-in Presets (replaces AgentType enum) ──────────────────────────────

const AGENT_PRIORITY_RULES = `Instruction priority:
P0 MUST: finish the assigned scope with evidence or return a concrete blocker; never ask whether to continue; never claim partial work is complete; never exceed scope or perform unrequested irreversible actions.
P1 SHOULD: investigate before asking, close all acceptance gaps, handle errors, and verify results; do not repeat completed work.
P2 PREFER: batch independent reads, follow project conventions, minimize changes, and report concisely.
P0 overrides P1 and P2.`

export const AGENT_PRESETS: Record<string, AgentConfig> = {
  explore: {
    identity: {
      systemPrompt: (cwd: string) =>
        `Working directory: ${cwd}\n\n${AGENT_PRIORITY_RULES}\n\nYou are an Explore sub-agent. Your task is to investigate and analyze the codebase.\n\nRules:\n- Only READ operations are available to you (Read, Glob, Grep, WebFetch, WebSearch)\n- Do NOT write, edit, or execute anything\n- Be thorough: search broadly before drawing conclusions\n- Return a clear, structured summary of your findings\n- Include specific file paths and line numbers where relevant`,
      planMode: true,
    },
    modules: {}, // lightweight — no memory/critic/reflection side effects
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    maxIterations: 40,
  },

  plan: {
    identity: {
      systemPrompt: (cwd: string) =>
        `Working directory: ${cwd}\n\n${AGENT_PRIORITY_RULES}\n\nYou are a Plan sub-agent. Analyze the codebase and produce a detailed implementation plan.\nReturn the plan as a numbered list with concrete steps, file paths, and specific changes.`,
      planMode: true,
    },
    modules: {}, // lightweight
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    maxIterations: 30,
  },

  'code-reviewer': {
    identity: {
      systemPrompt: (cwd: string) =>
        `Working directory: ${cwd}\n\n${AGENT_PRIORITY_RULES}\n\nYou are a code-review sub-agent. Review code for correctness, maintainability, security, and performance.\n\nRules:\n- Only READ operations are available to you (Read, Glob, Grep, WebFetch, WebSearch)\n- Do NOT modify anything — analyze and report only\n- Review dimensions: bugs/logic errors, maintainability, security issues, performance, convention adherence\n- Group findings by severity: [CRITICAL] / [HIGH] / [MEDIUM] / [LOW]\n- Each finding: code location (path:line), issue, why it matters, suggested fix\n- If no issues found, say so explicitly`,
      planMode: true,
    },
    modules: {}, // lightweight
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    maxIterations: 30,
  },

  'general-purpose': {
    identity: {
      systemPrompt: (cwd: string) =>
        `Working directory: ${cwd}\n\n${AGENT_PRIORITY_RULES}\n\nYou are a general-purpose sub-agent. Complete the specific task given in the user message without expanding scope.\nProvide a clear, complete summary when done (what you found, what you did, the result).\nIf unable to complete, explain why and what you tried.\nYou CANNOT call Agent (no recursion). Available tools: Bash, Read, Write, Edit, Glob, Grep, TodoWrite, WebFetch, WebSearch, TmuxSession, ShellSession.`,
    },
    modules: {
      memory: { enabled: true },
      workspace: { enabled: true },
    },
    // Exclude Agent to prevent recursion
    tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', 'WebFetch', 'WebSearch', 'TmuxSession', 'ShellSession', 'load_skill', 'memory_write', 'memory_search', 'memory_recall'],
    maxIterations: 60,
  },

  /**
   * Coordinator — pure orchestrator. Cannot edit files directly; dispatches
   * work to general-purpose workers via the Agent tool. Use for large
   * multi-step tasks that benefit from parallelism and decomposition.
   *
   * Anti-recursion: the coordinator CAN call Agent (its only writing tool),
   * but each spawned general-purpose worker CANNOT (enforced by the
   * general-purpose preset above).
   */
  coordinator: {
    identity: {
      systemPrompt: (cwd: string) =>
        `Working directory: ${cwd}\n\n${AGENT_PRIORITY_RULES}\n\nYou are a Coordinator. You decompose complex tasks into subtasks and dispatch them to worker agents. You do NOT edit files, run bash, or write code directly — that is the workers' job.\n\nStrategy:\n1. Read the task. Use Read/Glob/Grep to understand scope if needed.\n2. Break the task into independent, well-scoped subtasks.\n3. For each subtask, dispatch a worker via the Agent tool with a clear, complete prompt.\n4. If subtasks are independent, dispatch them in parallel (multiple Agent calls in one turn).\n5. Use EnterWorktree before dispatching parallel workers that modify files, so they don't conflict.\n6. After workers return, verify their work (read the changed files, run tests).\n7. Synthesize a final report for the user.\n\nRules:\n- Prefer parallel dispatch when subtasks don't share files.\n- Each worker prompt must be self-contained: include file paths, acceptance criteria, and constraints.\n- If a worker fails, analyze the failure and either retry with a refined prompt or fix the approach.\n- You are responsible for the final result — verify before reporting success.`,
    },
    modules: {},
    // Read-only tools for investigation + Agent tool for dispatch +
    // worktree tools for isolation + Task* for async + TodoWrite for planning
    tools: [
      'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
      'Agent', 'TodoWrite',
      'EnterWorktree', 'ExitWorktree', 'ListWorktrees',
      'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop',
    ],
    maxIterations: 80,
  },
}

/** List of valid preset names (for tool enum) */
export const PRESET_NAMES = Object.keys(AGENT_PRESETS)

/**
 * Resolve agent configuration from either a preset name or a custom config.
 * Falls back to 'general-purpose' preset if nothing specified.
 *
 * Resolution order for `preset`:
 *   1. Built-in presets (AGENT_PRESETS) — built-ins always win so a core
 *      preset can never be silently shadowed.
 *   2. Custom agents from disk (.agents/*.md|.json, ~/.ovogo/agents/) —
 *      requires `cwd`; skipped when absent.
 */
export function resolveAgentConfig(input: {
  preset?: string
  config?: AgentConfig
}, cwd?: string): AgentConfig {
  if (input.config) return input.config
  const preset = input.preset ?? 'general-purpose'
  const builtin = AGENT_PRESETS[preset]
  if (builtin) {
    // Return a shallow clone so callers can safely mutate (e.g. maxIterations override)
    return { ...builtin, identity: { ...builtin.identity } }
  }
  if (cwd) {
    const def = getCustomAgent(cwd, preset)
    if (def) return customAgentToConfig(def)
  }
  // Reject unknown presets instead of silently falling back — prevents
  // typos like "expoler" from spawning a full general-purpose agent
  const valid = cwd
    ? [...PRESET_NAMES, ...customAgentNames(cwd)].join(' | ')
    : PRESET_NAMES.join(' | ')
  throw new Error(`Unknown agent preset: "${preset}". Valid presets: ${valid}`)
}

/**
 * Validate and sanitize an LLM-supplied agent_config object.
 * Returns a safe AgentConfig or null if the input is malformed.
 */
export function validateAgentConfig(raw: unknown): AgentConfig | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  const identity = obj.identity
  if (typeof identity !== 'object' || identity === null) return null
  const id = identity as Record<string, unknown>
  // systemPrompt must be a function (preset pattern) — if LLM passes a string, wrap it
  let systemPrompt: (cwd: string) => string
  if (typeof id.systemPrompt === 'function') {
    systemPrompt = id.systemPrompt as (cwd: string) => string
  } else if (typeof id.systemPrompt === 'string') {
    const sp = id.systemPrompt
    systemPrompt = () => sp
  } else {
    return null
  }
  return {
    identity: {
      systemPrompt,
      planMode: id.planMode === true,
    },
    modules: typeof obj.modules === 'object' && obj.modules !== null
      ? obj.modules
      : undefined,
    tools: Array.isArray(obj.tools) ? (obj.tools as unknown[]).filter((t): t is string => typeof t === 'string') : undefined,
    disallowedTools: Array.isArray(obj.disallowedTools)
      ? (obj.disallowedTools as unknown[]).filter((t): t is string => typeof t === 'string')
      : undefined,
    maxIterations: typeof obj.maxIterations === 'number' ? Math.min(obj.maxIterations, 200) : undefined,
    temperature: typeof obj.temperature === 'number' ? Math.min(Math.max(obj.temperature, 0), 2) : undefined,
    maxOutputTokens: typeof obj.maxOutputTokens === 'number' ? obj.maxOutputTokens : undefined,
  }
}

/**
 * Merge AgentConfig into EngineConfig fields.
 * Called by the engine constructor when config.agent is set.
 */
export function applyAgentToConfig(config: EngineConfig): EngineConfig {
  if (!config.agent) return config

  const agent = config.agent
  return {
    ...config,
    systemPrompt: agent.identity.systemPrompt(config.cwd),
    planMode: agent.identity.planMode ?? config.planMode,
    enabledModules: deriveModuleNames(agent.modules) ?? config.enabledModules,
    maxIterations: agent.maxIterations ?? config.maxIterations,
    temperature: agent.temperature ?? config.temperature,
    maxOutputTokens: agent.maxOutputTokens ?? config.maxOutputTokens,
  }
}
