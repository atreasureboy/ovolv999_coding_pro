/**
 * Goal Tool — autonomous goal management for the LLM
 *
 * Lets the LLM create, update, and track long-horizon goals.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import {
  createGoal,
  getGoal,
  listGoals,
  updateGoal,
  deleteGoal,
  addSubtask,
  updateSubtask,
  getNextSubtask,
  startGoal,
  completeGoal,
  failGoal,
  pauseGoal,
  resumeGoal,
  retryGoal,
  addContext,
  getProgress,
  formatGoal,
  formatGoalList,
} from '../core/goals.js'
import type { Goal, GoalStatus } from '../core/goals.js'

export class GoalTool implements Tool {
  name = 'Goal'
  metadata = { mutatesState: true, concurrencySafe: false }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Goal',
      description: `Manage autonomous goals for long-horizon tasks. Break complex objectives into trackable subtasks.

## Actions

**create** — Create a new goal
**get** — Get goal details by ID
**list** — List all goals (with optional status/priority filter)
**update** — Update goal objective/priority/tags
**delete** — Delete a goal
**start** — Mark goal as in_progress
**complete** — Mark goal as completed
**fail** — Mark goal as failed (with reason)
**pause** — Pause a goal
**resume** — Resume a paused goal
**retry** — Retry a failed goal (resets failed subtasks)
**add_subtask** — Add a subtask to a goal
**update_subtask** — Update subtask status (pending/in_progress/done/skipped/failed)
**next_subtask** — Get next pending/in_progress subtask
**add_context** — Add a learning/note to goal context

Use this for multi-step objectives that span many turns.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'get', 'list', 'update', 'delete', 'start', 'complete', 'fail', 'pause', 'resume', 'retry', 'add_subtask', 'update_subtask', 'next_subtask', 'add_context'],
            description: 'The action to perform',
          },
          goal_id: { type: 'string', description: 'Goal ID (required for most actions)' },
          objective: { type: 'string', description: 'Goal objective (for create/update)' },
          description: { type: 'string', description: 'Subtask description (for add_subtask)' },
          subtask_id: { type: 'string', description: 'Subtask ID (for update_subtask)' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'done', 'skipped', 'failed'],
            description: 'New subtask status (for update_subtask)',
          },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'critical'],
            description: 'Goal priority (for create/update)',
          },
          subtasks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Initial subtask descriptions (for create)',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags (for create/update)',
          },
          note: { type: 'string', description: 'Context note (for add_context)' },
          reason: { type: 'string', description: 'Failure reason (for fail)' },
        },
        required: ['action'],
      },
    },
  }

  isConcurrencySafe(): boolean {
    return false
  }

  execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const action = input.action as string

    try {
      switch (action) {
        case 'create': {
          const objective = input.objective as string
          if (!objective) {
            return Promise.resolve({ content: 'Error: objective is required for create', isError: true })
          }
          const goal = createGoal(objective, {
            subtasks: input.subtasks as string[] | undefined,
            priority: input.priority as Goal['priority'] | undefined,
            tags: input.tags as string[] | undefined,
          })
          return Promise.resolve({ content: formatGoal(goal), isError: false })
        }

        case 'get': {
          const goal = getGoal(input.goal_id as string)
          if (!goal) return Promise.resolve({ content: `Goal not found: ${String(input.goal_id)}`, isError: true })
          return Promise.resolve({ content: formatGoal(goal), isError: false })
        }

        case 'list': {
          const goals = listGoals({
            status: input.status as GoalStatus | undefined,
            priority: input.priority as Goal['priority'] | undefined,
          })
          return Promise.resolve({ content: formatGoalList(goals), isError: false })
        }

        case 'update': {
          const goal = updateGoal(input.goal_id as string, {
            objective: input.objective as string | undefined,
            priority: input.priority as Goal['priority'] | undefined,
            tags: input.tags as string[] | undefined,
          })
          if (!goal) return Promise.resolve({ content: `Goal not found: ${String(input.goal_id)}`, isError: true })
          return Promise.resolve({ content: formatGoal(goal), isError: false })
        }

        case 'delete': {
          const deleted = deleteGoal(input.goal_id as string)
          return Promise.resolve({
            content: deleted ? `Deleted goal: ${String(input.goal_id)}` : `Goal not found: ${String(input.goal_id)}`,
            isError: !deleted,
          })
        }

        case 'start': {
          const goal = startGoal(input.goal_id as string)
          if (!goal) return Promise.resolve({ content: `Goal not found: ${String(input.goal_id)}`, isError: true })
          return Promise.resolve({ content: `Started goal:\n${formatGoal(goal)}`, isError: false })
        }

        case 'complete': {
          const goal = completeGoal(input.goal_id as string)
          if (!goal) return Promise.resolve({ content: `Goal not found: ${String(input.goal_id)}`, isError: true })
          return Promise.resolve({ content: `Completed goal:\n${formatGoal(goal)}`, isError: false })
        }

        case 'fail': {
          const goal = failGoal(input.goal_id as string, input.reason as string | undefined)
          if (!goal) return Promise.resolve({ content: `Goal not found: ${String(input.goal_id)}`, isError: true })
          return Promise.resolve({ content: `Failed goal:\n${formatGoal(goal)}`, isError: false })
        }

        case 'pause': {
          const goal = pauseGoal(input.goal_id as string)
          if (!goal) return Promise.resolve({ content: `Goal not found: ${String(input.goal_id)}`, isError: true })
          return Promise.resolve({ content: `Paused goal:\n${formatGoal(goal)}`, isError: false })
        }

        case 'resume': {
          const goal = resumeGoal(input.goal_id as string)
          if (!goal) return Promise.resolve({ content: `Goal not found: ${String(input.goal_id)}`, isError: true })
          return Promise.resolve({ content: `Resumed goal:\n${formatGoal(goal)}`, isError: false })
        }

        case 'retry': {
          const goal = retryGoal(input.goal_id as string)
          if (!goal) return Promise.resolve({ content: `Goal not found: ${String(input.goal_id)}`, isError: true })
          return Promise.resolve({ content: `Retrying goal:\n${formatGoal(goal)}`, isError: false })
        }

        case 'add_subtask': {
          const st = addSubtask(input.goal_id as string, input.description as string)
          if (!st) return Promise.resolve({ content: `Goal not found: ${String(input.goal_id)}`, isError: true })
          return Promise.resolve({ content: `Added subtask: ${st.description}`, isError: false })
        }

        case 'update_subtask': {
          const st = updateSubtask(input.goal_id as string, input.subtask_id as string, {
            status: input.status as SubTaskStatus | undefined,
            result: input.note as string | undefined,
          })
          if (!st) return Promise.resolve({ content: 'Subtask not found', isError: true })
          return Promise.resolve({ content: `Updated subtask: ${st.description} → ${st.status}`, isError: false })
        }

        case 'next_subtask': {
          const st = getNextSubtask(input.goal_id as string)
          if (!st) {
            const goal = getGoal(input.goal_id as string)
            if (!goal) return Promise.resolve({ content: `Goal not found: ${String(input.goal_id)}`, isError: true })
            const progress = getProgress(input.goal_id as string)
            return Promise.resolve({
              content: `No pending subtasks. Progress: ${progress?.done}/${progress?.total}`,
              isError: false,
            })
          }
          return Promise.resolve({ content: `Next subtask: ${st.description} (${st.id})`, isError: false })
        }

        case 'add_context': {
          const goal = addContext(input.goal_id as string, input.note as string)
          if (!goal) return Promise.resolve({ content: `Goal not found: ${String(input.goal_id)}`, isError: true })
          return Promise.resolve({ content: `Added context note to goal ${String(input.goal_id)}`, isError: false })
        }

        default:
          return Promise.resolve({ content: `Unknown action: ${action}`, isError: true })
      }
    } catch (err) {
      return Promise.resolve({
        content: `Goal operation failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      })
    }
  }
}

type SubTaskStatus = 'pending' | 'in_progress' | 'done' | 'skipped' | 'failed'
