/**
 * Tool registry — ovolv999 agent base tools
 */

import type { Tool, EngineConfig, AgentChildEngineFactory, ToolMetadata } from '../core/types.js'
import type { ExecutionRunRegistry } from '../core/executionRun.js'
import type { RunScopedEvidenceResolver } from './taskGraphResolver.js'
import { BashTool } from './bash.js'
import { FileReadTool } from './fileRead.js'
import { FileWriteTool } from './fileWrite.js'
import { FileEditTool } from './fileEdit.js'
import { GlobTool } from './glob.js'
import { GrepTool } from './grep.js'
import { TodoWriteTool } from './todo.js'
import { WebFetchTool } from './webFetch.js'
import { WebSearchTool } from './webSearch.js'
import { AgentTool } from './agent.js'
import { TmuxSessionTool } from './tmuxSession.js'
import { ShellSessionTool } from './shellSession.js'
import {
  TaskCreateTool,
  TaskGetTool,
  TaskListTool,
  TaskUpdateTool,
  TaskStopTool,
} from './tasks.js'
import { AskUserQuestionTool } from './askUser.js'
import { ExitPlanModeTool } from './exitPlanMode.js'
import { EnterPlanModeTool } from './enterPlanMode.js'
import { VerifyPlanExecutionTool } from './verifyPlanExecution.js'
import { SleepTool } from './sleep.js'
import { SnipTool } from './snip.js'
import { NotebookEditTool } from './notebookEdit.js'
import { ClaudeCodeTool } from './claudeCode.js'
import { EnterWorktreeTool, ExitWorktreeTool, ListWorktreesTool } from './worktree.js'
import { DiagnosticsTool } from './diagnostics.js'
import { ListMcpResourcesTool, ReadMcpResourceTool } from './mcpResources.js'
import { GoalTool } from './goal.js'
import { TaskPlanTool } from './taskPlan.js'
import { createSearchExtraToolsTool } from './searchExtraTools.js'
import { createLspTool, loadLspServersFromSettings } from './lspTool.js'
import { MultiEditTool } from './multiEdit.js'
import { CodeStructureTool } from './codeStructure.js'
import { CodeQualityTool } from './codeQuality.js'
import { ProjectExplorerTool } from './projectExplorer.js'
import { CodeReviewTool } from './codeReview.js'
import { SymbolIndexTool } from './symbolIndex.js'
import { createLazyTool, type LazyTool } from '../core/lazyTool.js'
import type { TaskGraphResolver } from './taskGraphResolver.js'

/** v0.6.0: concise helper for building lazy tools. */
function lazy(
  name: string,
  description: string,
  props: Record<string, string>,
  required: string[],
  metadata: ToolMetadata | undefined,
  factory: () => Tool,
): LazyTool {
  const properties: Record<string, { type: string; description?: string }> = {}
  for (const [k, v] of Object.entries(props)) {
    properties[k] = { type: v }
  }
  return createLazyTool({
    name,
    definition: {
      type: 'function',
      function: {
        name,
        description,
        parameters: {
          type: 'object',
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
      },
    },
    metadata,
    factory,
  })
}

/**
 * Wiring for the per-engine AgentTool instance.
 *
 * `factory`/`parentConfig`/`parentRenderer` are required for full
 * sub-agent delegation. However, `runRegistry` alone may be supplied
 * (without the factory trio) so that ClaudeCodeTool — which doesn't
 * need an agentFactory — still receives the registry for child-run
 * tracking. When `factory` is absent, AgentTool returns a "not
 * initialized" error if its action is invoked, but ClaudeCodeTool
 * works normally.
 */
export interface AgentWiring {
  factory?: AgentChildEngineFactory
  parentConfig?: EngineConfig
  parentRenderer?: unknown
  /**
   * Optional ExecutionRun registry (runtime architecture contract §三). When supplied,
   * AgentTool and ClaudeCodeTool create child runs for every
   * delegation so observers can track them uniformly. When omitted,
   * both tools behave exactly as before (no registry integration).
   */
  runRegistry?: ExecutionRunRegistry
  /** Optional parent run id — links child runs into a call tree. */
  parentRunId?: string
  /** Phase 3: shared TaskGraph for the TaskPlan tool (legacy path). */
  taskGraph?: unknown
  /** v0.3.2 (run-scoped runtime contract §Phase 2): the TaskGraphResolver is the
   *  primary path; TaskPlanTool resolves the current run's graph
   *  via runId rather than holding a fixed reference. */
  taskGraphResolver?: TaskGraphResolver
  /** v0.3.5: per-run evidence resolver for anti-false-success. */
  evidenceResolver?: RunScopedEvidenceResolver
}

export function createTools(
  extraTools: Tool[] = [],
  agentWiring?: AgentWiring,
): Tool[] {
  const agent: Tool = agentWiring
    ? new AgentTool({
        factory: agentWiring.factory,
        parentConfig: agentWiring.parentConfig,
        parentRenderer: agentWiring.parentRenderer,
        runRegistry: agentWiring.runRegistry,
        parentRunId: agentWiring.parentRunId,
      })
    : new AgentTool()

  return [
    // ── Core (always eager) ──
    new BashTool(),
    new FileReadTool(),
    new FileWriteTool(),
    new FileEditTool(),
    new GlobTool(),
    new GrepTool(),
    new TodoWriteTool(),
    new WebFetchTool(),
    new WebSearchTool(),
    agent,
    new AskUserQuestionTool(),
    new ExitPlanModeTool(),
    new EnterPlanModeTool(),
    new VerifyPlanExecutionTool(),
    new SleepTool(),
    new SnipTool(),
    new NotebookEditTool(),
    new GoalTool(),
    new TaskPlanTool(agentWiring?.taskGraphResolver, agentWiring?.evidenceResolver),
    createSearchExtraToolsTool(),
    new MultiEditTool(),
    new CodeStructureTool(),
    new CodeQualityTool(),
    new ProjectExplorerTool(),
    new CodeReviewTool(),
    new SymbolIndexTool(),

    // ── Heavy (lazy) — v0.6.0: ~200ms startup savings ──
    lazy('Task', 'Launch a new agent to handle complex, multi-step tasks autonomously',
      { subagent_type: 'string', description: 'string', prompt: 'string' }, ['subagent_type', 'description', 'prompt'],
      { mutatesState: true, concurrencySafe: false },
      () => new TaskCreateTool()),
    lazy('TaskGet', 'Get task details', { task_id: 'string' }, ['task_id'],
      undefined, () => new TaskGetTool()),
    lazy('TaskList', 'List all tasks', {}, [],
      undefined, () => new TaskListTool()),
    lazy('TaskUpdate', 'Update task status', { task_id: 'string', status: 'string' }, ['task_id'],
      undefined, () => new TaskUpdateTool()),
    lazy('TaskStop', 'Stop a running task', { task_id: 'string' }, ['task_id'],
      undefined, () => new TaskStopTool()),
    lazy('Tmux', 'Manage tmux sessions for long-running processes', { action: 'string', session: 'string', command: 'string' }, ['action'],
      { mutatesState: true, concurrencySafe: false },
      () => new TmuxSessionTool()),
    lazy('Shell', 'Interactive shell session', { action: 'string', command: 'string' }, ['action'],
      { mutatesState: true, concurrencySafe: false },
      () => new ShellSessionTool()),
    lazy('ClaudeCode', 'Delegate to Claude Code worker', { prompt: 'string', model: 'string', role: 'string', worktree: 'string' }, ['prompt'],
      { mutatesState: true, concurrencySafe: false },
      () => new ClaudeCodeTool(undefined, agentWiring?.runRegistry, agentWiring?.parentRunId)),
    lazy('EnterWorktree', 'Create and enter an isolated git worktree', { branch: 'string', base: 'string' }, ['branch'],
      { mutatesState: true, concurrencySafe: false },
      () => new EnterWorktreeTool()),
    lazy('ExitWorktree', 'Exit and clean up a worktree', { path: 'string' }, [],
      { mutatesState: true, concurrencySafe: false },
      () => new ExitWorktreeTool()),
    lazy('ListWorktrees', 'List active worktrees', {}, [],
      undefined, () => new ListWorktreesTool()),
    lazy('Diagnostics', 'Run code diagnostics (tsc, eslint, etc.)', { checker: 'string', file: 'string' }, [],
      undefined, () => new DiagnosticsTool()),
    lazy('ListMcpResources', 'List MCP resources', { server: 'string' }, [],
      undefined, () => new ListMcpResourcesTool()),
    lazy('ReadMcpResource', 'Read an MCP resource', { uri: 'string' }, ['uri'],
      undefined, () => new ReadMcpResourceTool()),
    lazy('LSP', 'Language Server Protocol: go-to-definition, references, hover, completions',
      { action: 'string', file: 'string', line: 'number', column: 'number' }, ['action', 'file'],
      undefined, () => createLspTool({ servers: loadLspServersFromSettings() })),
    ...extraTools,
  ]
}

export function getToolDefinitions(tools: Tool[]) {
  return tools.map((t) => t.definition)
}

export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name)
}

export {
  BashTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  MultiEditTool,
  CodeStructureTool,
  CodeQualityTool,
  ProjectExplorerTool,
  CodeReviewTool,
  SymbolIndexTool,
  GlobTool,
  GrepTool,
  TodoWriteTool,
  WebFetchTool,
  WebSearchTool,
  AgentTool,
  TmuxSessionTool,
  ShellSessionTool,
  TaskCreateTool,
  TaskGetTool,
  TaskListTool,
  TaskUpdateTool,
  TaskStopTool,
  AskUserQuestionTool,
  ExitPlanModeTool,
  EnterPlanModeTool,
  VerifyPlanExecutionTool,
  SleepTool,
  SnipTool,
  NotebookEditTool,
  ClaudeCodeTool,
  EnterWorktreeTool,
  ExitWorktreeTool,
  ListWorktreesTool,
  DiagnosticsTool,
  ListMcpResourcesTool,
  ReadMcpResourceTool,
  GoalTool,
}
export { createSearchExtraToolsTool, SEARCH_EXTRA_TOOLS_NAME } from './searchExtraTools.js'
