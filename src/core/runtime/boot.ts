/**
 * Boot — turn setup sequence extracted from RuntimeCoordinator.
 *
 * Responsibilities (from replan.md §5.1):
 *   - Boot modules (collect prompt sections + tools + context patch)
 *   - Build system prompt (identity + module sections)
 *   - Register all tools in ToolRegistry (base + module, with collision detection)
 *   - Compute exposed tool definitions (via ToolPolicy)
 *   - Construct the ToolContext
 *   - Initialize the AbortController for the turn
 *   - Build the initial messages array (history + user message)
 *
 * This is a pure function — it receives all subsystems and returns a
 * BootResult. No state mutation beyond what's passed in.
 */

import type {
  EngineConfig,
  OpenAIMessage,
  ContentPart,
  Tool,
  ToolContext,
  ToolDefinition,
} from '../types.js'
import type { ModuleBootContext } from '../module.js'
import type { ModuleManager } from '../moduleRuntime/moduleManager.js'
import type { ContextManager } from '../context/contextManager.js'
import type { ToolPolicy } from '../toolRuntime/toolPolicy.js'
import type { ToolRegistry } from '../toolRuntime/toolRegistry.js'
import type { SharedRuntimeState } from './sharedState.js'
import type { RunEventEmitter } from './events.js'
import type { EventLog } from '../eventLog.js'
import type { BackgroundTaskManager } from '../backgroundTaskManager.js'
import type { FileHistory } from '../fileHistory.js'
import type { PermissionManager } from '../permissionSystem.js'
import { getPlanModePrefix } from '../../prompts/system.js'
import { normalizeCJKInput } from '../strings.js'

export interface BootParams {
  userMessage: string
  history: OpenAIMessage[]
  images?: Array<{ path: string; dataUrl: string }>
  config: EngineConfig
  baseTools: Tool[]
  sharedState: SharedRuntimeState
  moduleManager: ModuleManager
  contextManager: ContextManager
  toolPolicy: ToolPolicy
  toolRegistry: ToolRegistry
  permissionManager: PermissionManager
  backgroundTaskManager: BackgroundTaskManager
  fileHistory: FileHistory | null
  eventLog?: EventLog
  eventEmitter?: RunEventEmitter
}

export interface BootResult {
  systemPrompt: string
  toolDefs: ToolDefinition[]
  toolContext: ToolContext
  messages: OpenAIMessage[]
  turnAbortController: AbortController
}

export async function boot(params: BootParams): Promise<BootResult> {
  const {
    userMessage, history, images, config, baseTools, sharedState,
    moduleManager, contextManager, toolPolicy, toolRegistry,
    permissionManager, backgroundTaskManager, fileHistory,
    eventLog, eventEmitter,
  } = params

  const planMode = sharedState.planModeActive

  // ── Boot modules ──
  const bootCtx: ModuleBootContext = {
    cwd: config.cwd,
    sessionDir: config.sessionDir,
    config,
    userMessage,
  }
  const bootOutput = await moduleManager.boot(bootCtx)
  const { systemPromptSections: moduleSections, toolContextPatch, tools: moduleTools } = bootOutput

  // ── Register tools (base + module, with collision detection) ──
  toolRegistry.reset(baseTools, moduleTools)

  eventLog?.append('boot_context', 'engine', {
    trajectory: 'boot_context',
    modules: moduleManager.moduleNames,
    module_sections: moduleSections.length,
    module_tools: moduleTools.length,
    user_message_length: userMessage.length,
  })

  // ── Build system prompt ──
  const systemPrompt = buildSystemPrompt(planMode, moduleSections, config.systemPrompt ?? '')
  contextManager.beginTurn(systemPrompt)

  // ── Compute exposed tool definitions ──
  const toolDefs = toolPolicy.getExposedDefinitions(toolRegistry.getAll(), planMode)

  // ── Per-turn AbortController ──
  const turnAbortController = new AbortController()
  sharedState.currentTurnAbortController = turnAbortController

  // ── Build initial messages ──
  let userContent: string | ContentPart[]
  if (images && images.length > 0) {
    userContent = [
      { type: 'text', text: normalizeCJKInput(userMessage) },
      ...images.map((img) => ({ type: 'image_url' as const, image_url: { url: img.dataUrl } })),
    ]
  } else {
    userContent = normalizeCJKInput(userMessage)
  }
  const messages: OpenAIMessage[] = [...history, { role: 'user', content: userContent }]

  // ── Consume queued snip ──
  contextManager.consumeQueuedSnip(messages)

  // ── Build tool context ──
  const toolContext: ToolContext = {
    cwd: config.cwd,
    permissionMode: config.permissionMode,
    permissionManager,
    signal: turnAbortController.signal,
    apiConfig: {
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: config.model,
    },
    eventLog,
    backgroundTaskManager,
    askUserQuestion: config.askUserQuestion,
    exitPlanMode: async (plan: string): Promise<boolean> => {
      const approved = await config.exitPlanMode?.(plan) ?? true
      if (approved) sharedState.planModeActive = false
      return approved
    },
    enterPlanMode: () => { sharedState.planModeActive = true },
    fileHistory: fileHistory ?? undefined,
    ...toolContextPatch,
    availableToolNames: toolDefs.map(t => t.function.name),
    snipMessages: (keepRecent: number, reason?: string) =>
      contextManager.applySnip(messages, keepRecent, reason),
    getMessages: () => messages.map(m => ({ ...m })),
  }

  eventEmitter?.emit({
    type: 'BOOT_COMPLETED',
    moduleCount: moduleManager.moduleNames.length,
    toolCount: toolRegistry.size,
  })

  return {
    systemPrompt,
    toolDefs,
    toolContext,
    messages,
    turnAbortController,
  }
}

export function buildSystemPrompt(
  planMode: boolean,
  moduleSections: string[],
  baseSystemPrompt: string,
): string {
  const base = baseSystemPrompt ?? ''
  const sections = moduleSections.length > 0
    ? base + '\n\n---\n\n' + moduleSections.join('\n\n---\n\n')
    : base
  if (planMode) {
    return getPlanModePrefix() + sections
  }
  return sections
}
