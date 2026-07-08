/**
 * Background Task Tools — async long-running task management
 *
 * Inspired by Claude Code's TaskCreate/TaskGet/TaskList/TaskUpdate/TaskStop.
 *
 * Five tools that wrap BackgroundTaskManager, giving the LLM the ability to:
 *   TaskCreate — spawn a background command, return immediately with task ID
 *   TaskGet    — get task status + output (optionally block until done)
 *   TaskList   — list all background tasks with status summary
 *   TaskUpdate — update task description / metadata
 *   TaskStop   — stop a running background task
 *
 * Use case: long-running commands (test suites, builds, servers) that
 * shouldn't block the conversation. The LLM spawns them, continues working,
 * then checks back later for results.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import {
  type BackgroundTaskManager,
  formatTaskList,
  formatTaskDetail,
} from '../core/backgroundTaskManager.js'

function getManager(ctx: ToolContext): BackgroundTaskManager | undefined {
  return ctx.backgroundTaskManager
}

// ── TaskCreate ──────────────────────────────────────────────────────────────

export class TaskCreateTool implements Tool {
  name = 'TaskCreate'

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'TaskCreate',
      description: `Spawn a background task that runs a shell command asynchronously. Returns immediately with a task ID — use TaskGet to check status and retrieve output later.

## When to Use
- Long-running commands (test suites, builds, dev servers) that shouldn't block the conversation
- Commands where you need to continue other work while they run
- Monitoring processes (tail -f, watch)

## When NOT to Use
- Quick commands (< 10s) — use Bash instead
- Commands you need the result of immediately — use Bash
- Interactive commands needing input — use TmuxSession instead

The task runs detached. Use TaskGet with block=true to wait for completion.`,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to run in the background',
          },
          description: {
            type: 'string',
            description: 'A brief description of what the command does (shown in task list)',
          },
          metadata: {
            type: 'object',
            description: 'Optional metadata to attach to the task',
            additionalProperties: true,
          },
        },
        required: ['command'],
      },
    },
  }

  isConcurrencySafe(): boolean {
    return true
  }

  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const manager = getManager(ctx)
    if (!manager) {
      return Promise.resolve({ content: 'Background task manager not available.', isError: true })
    }

    const command = input.command as string
    if (!command) {
      return Promise.resolve({ content: 'Error: command is required', isError: true })
    }

    const id = manager.createTask(command, {
      description: input.description as string | undefined,
      cwd: ctx.cwd,
      sessionDir: ctx.sessionDir,
      metadata: input.metadata as Record<string, unknown> | undefined,
    })

    const task = manager.getTask(id)!
    return Promise.resolve({
      content: `Background task created: ${id}\nCommand: ${task.command}\nPID: ${task.pid ?? 'unknown'}\nStatus: running\n\nUse TaskGet with task_id="${id}" to check status and retrieve output.`,
      isError: false,
    })
  }
}

// ── TaskGet ─────────────────────────────────────────────────────────────────

export class TaskGetTool implements Tool {
  name = 'TaskGet'

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'TaskGet',
      description: `Get the status and output of a background task. By default returns immediately with current state. Set block=true to wait for the task to complete (with a timeout).

## Parameters
- task_id: The task ID returned by TaskCreate
- block: If true, wait for the task to finish (default: false)
- timeout: Max wait time in milliseconds when block=true (default: 30000, max: 300000)`,
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The ID of the task to retrieve',
          },
          block: {
            type: 'boolean',
            description: 'If true, wait for the task to complete before returning (default: false)',
          },
          timeout: {
            type: 'number',
            description: 'Max wait time in ms when block=true (default: 30000)',
          },
        },
        required: ['task_id'],
      },
    },
  }

  isConcurrencySafe(): boolean {
    return true
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const manager = getManager(ctx)
    if (!manager) {
      return { content: 'Background task manager not available.', isError: true }
    }

    const taskId = input.task_id as string
    if (!taskId) {
      return { content: 'Error: task_id is required', isError: true }
    }

    const block = input.block as boolean | undefined
    const timeout = Math.min((input.timeout as number | undefined) ?? 30_000, 300_000)

    // If blocking, wait for completion
    if (block) {
      const finalInfo = await manager.waitForTask(taskId, timeout)
      if (!finalInfo) {
        return { content: `Task not found: ${taskId}. Hint: use TaskList to see all task IDs.`, isError: true }
      }
      const detail = manager.getTaskDetail(taskId)
      if (!detail) {
        return { content: `Task not found: ${taskId}. Hint: use TaskList to see all task IDs.`, isError: true }
      }
      const blocked = finalInfo.status === 'running' ? ' (timed out waiting)' : ''
      return {
        content: formatTaskDetail(detail) + blocked,
        isError: false,
      }
    }

    // Non-blocking: return current state
    const detail = manager.getTaskDetail(taskId)
    if (!detail) {
      return { content: `Task not found: ${taskId}. Hint: use TaskList to see all task IDs.`, isError: true }
    }
    return {
      content: formatTaskDetail(detail),
      isError: false,
    }
  }
}

// ── TaskList ────────────────────────────────────────────────────────────────

export class TaskListTool implements Tool {
  name = 'TaskList'

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'TaskList',
      description: 'List all background tasks with their current status. Shows running, completed, and failed tasks.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  }

  isConcurrencySafe(): boolean {
    return true
  }

  execute(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const manager = getManager(ctx)
    if (!manager) {
      return Promise.resolve({ content: 'Background task manager not available.', isError: true })
    }

    const tasks = manager.listTasks()
    return Promise.resolve({
      content: formatTaskList(tasks),
      isError: false,
    })
  }
}

// ── TaskUpdate ──────────────────────────────────────────────────────────────

export class TaskUpdateTool implements Tool {
  name = 'TaskUpdate'

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'TaskUpdate',
      description: `Update a background task's description or metadata. Cannot change the command or status (status is process-driven). Useful for annotating tasks with notes or categorizing them.`,
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The ID of the task to update',
          },
          description: {
            type: 'string',
            description: 'New description for the task',
          },
          metadata: {
            type: 'object',
            description: 'Metadata keys to merge into the task',
            additionalProperties: true,
          },
        },
        required: ['task_id'],
      },
    },
  }

  isConcurrencySafe(): boolean {
    return true
  }

  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const manager = getManager(ctx)
    if (!manager) {
      return Promise.resolve({ content: 'Background task manager not available.', isError: true })
    }

    const taskId = input.task_id as string
    if (!taskId) {
      return Promise.resolve({ content: 'Error: task_id is required', isError: true })
    }

    const success = manager.updateTask(taskId, {
      description: input.description as string | undefined,
      metadata: input.metadata as Record<string, unknown> | undefined,
    })

    if (!success) {
      return Promise.resolve({ content: `Task not found: ${taskId}. Hint: use TaskList to see all task IDs.`, isError: true })
    }

    const task = manager.getTask(taskId)!
    return Promise.resolve({
      content: `Updated task ${taskId}: ${task.description}`,
      isError: false,
    })
  }
}

// ── TaskStop ────────────────────────────────────────────────────────────────

export class TaskStopTool implements Tool {
  name = 'TaskStop'

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'TaskStop',
      description: `Stop a running background task by sending SIGTERM (escalates to SIGKILL after 3s). The task's accumulated output is still retrievable via TaskGet.

Use this when a background command is no longer needed or is stuck.`,
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The ID of the background task to stop',
          },
        },
        required: ['task_id'],
      },
    },
  }

  isConcurrencySafe(): boolean {
    return true
  }

  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const manager = getManager(ctx)
    if (!manager) {
      return Promise.resolve({ content: 'Background task manager not available.', isError: true })
    }

    const taskId = input.task_id as string
    if (!taskId) {
      return Promise.resolve({ content: 'Error: task_id is required', isError: true })
    }

    const task = manager.getTask(taskId)
    if (!task) {
      return Promise.resolve({ content: `Task not found: ${taskId}. Hint: use TaskList to see all task IDs.`, isError: true })
    }

    if (task.status !== 'running') {
      return Promise.resolve({
        content: `Task ${taskId} is not running (status: ${task.status})`,
        isError: false,
      })
    }

    const stopped = manager.stopTask(taskId)
    if (!stopped) {
      return Promise.resolve({
        content: `Failed to stop task ${taskId} (process may have already exited)`,
        isError: true,
      })
    }

    return Promise.resolve({
      content: `Stopped task ${taskId}: ${task.description}`,
      isError: false,
    })
  }
}
