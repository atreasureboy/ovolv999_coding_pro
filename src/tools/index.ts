/**
 * Tool registry — ovolv999 agent base tools
 */

import type { Tool, EngineConfig, AgentChildEngineFactory } from '../core/types.js'
import type { ExecutionRunRegistry } from '../core/executionRun.js'
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
import type { TaskGraphResolver } from './taskGraphResolver.js'

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
   * Optional ExecutionRun registry (fi_goal.md §三). When supplied,
   * AgentTool and ClaudeCodeTool create child runs for every
   * delegation so observers can track them uniformly. When omitted,
   * both tools behave exactly as before (no registry integration).
   */
  runRegistry?: ExecutionRunRegistry
  /** Optional parent run id — links child runs into a call tree. */
  parentRunId?: string
  /** Phase 3: shared TaskGraph for the TaskPlan tool (legacy path). */
  taskGraph?: unknown
  /** v0.3.2 (ele_goal §Phase 2): the TaskGraphResolver is the
   *  primary path; TaskPlanTool resolves the current run's graph
   *  via runId rather than holding a fixed reference. */
  taskGraphResolver?: TaskGraphResolver
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
    new TmuxSessionTool(),
    new ShellSessionTool(),
    new TaskCreateTool(),
    new TaskGetTool(),
    new TaskListTool(),
    new TaskUpdateTool(),
    new TaskStopTool(),
    new AskUserQuestionTool(),
    new ExitPlanModeTool(),
    new EnterPlanModeTool(),
    new VerifyPlanExecutionTool(),
    new SleepTool(),
    new SnipTool(),
    new NotebookEditTool(),
    new ClaudeCodeTool(undefined, agentWiring?.runRegistry, agentWiring?.parentRunId),
    new EnterWorktreeTool(),
    new ExitWorktreeTool(),
    new ListWorktreesTool(),
    new DiagnosticsTool(),
    new ListMcpResourcesTool(),
    new ReadMcpResourceTool(),
    new GoalTool(),
    new TaskPlanTool(agentWiring?.taskGraphResolver),
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
