/**
 * Tool registry — ovolv999 agent base tools
 */

import type { Tool } from '../core/types.js'
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
import { SleepTool } from './sleep.js'
import { NotebookEditTool } from './notebookEdit.js'

export function createTools(extraTools: Tool[] = []): Tool[] {
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
    new AgentTool(),
    new TmuxSessionTool(),
    new ShellSessionTool(),
    new TaskCreateTool(),
    new TaskGetTool(),
    new TaskListTool(),
    new TaskUpdateTool(),
    new TaskStopTool(),
    new AskUserQuestionTool(),
    new ExitPlanModeTool(),
    new SleepTool(),
    new NotebookEditTool(),
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
  SleepTool,
  NotebookEditTool,
}
