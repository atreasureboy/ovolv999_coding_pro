/**
 * Tool registry — ovolv999 agent base tools
 */

import type { Tool, EngineConfig, AgentChildEngineFactory } from '../core/types.js'
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

/**
 * Wiring for the per-engine AgentTool instance. All fields are REQUIRED
 * — when an `AgentWiring` is supplied to `createTools`, it must be
 * complete. `createTools`'s second parameter itself is OPTIONAL: when
 * omitted, an `AgentTool` with no wiring is constructed and will return
 * a "not initialized" error if its action is invoked.
 */
export interface AgentWiring {
  factory: AgentChildEngineFactory
  parentConfig: EngineConfig
  parentRenderer: unknown
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
    new ClaudeCodeTool(),
    new EnterWorktreeTool(),
    new ExitWorktreeTool(),
    new ListWorktreesTool(),
    new DiagnosticsTool(),
    new ListMcpResourcesTool(),
    new ReadMcpResourceTool(),
    new GoalTool(),
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
