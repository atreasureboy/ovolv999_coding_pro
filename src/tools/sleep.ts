/**
 * SleepTool — lightweight wait utility
 *
 * Inspired by Claude Code's SleepTool.
 *
 * Suspends execution for a specified duration. Prefer this over
 * `Bash(sleep ...)` — it doesn't hold a shell process and can be
 * interrupted via the abort signal.
 *
 * Use cases:
 *   - Polling: wait between status checks (e.g., TaskGet retries)
 *   - Rate limiting: space out API calls
 *   - Waiting for resources: give a server time to start
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'

const MAX_SLEEP_MS = 600_000 // 10 minutes — prevent infinite sleeps

export class SleepTool implements Tool {
  name = 'Sleep'

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Sleep',
      description: `Wait for a specified duration (in milliseconds). Prefer this over Bash(sleep ...) — it doesn't hold a shell process and supports cancellation.

## When to Use
- Polling: wait between retries or status checks (e.g., checking a background task)
- Rate limiting: space out API calls or file operations
- Waiting for resources: give a server or process time to start/stop

## When NOT to Use
- You need to DO something while waiting — use TaskCreate + TaskGet instead
- The wait is less than 100ms — just proceed directly

The user can interrupt the sleep at any time (Ctrl+C).`,
      parameters: {
        type: 'object',
        properties: {
          duration_ms: {
            type: 'number',
            description: 'Duration to sleep in milliseconds (max 600000 = 10 min)',
          },
        },
        required: ['duration_ms'],
      },
    },
  }

  isConcurrencySafe(): boolean {
    return true
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const durationMs = input.duration_ms as number | undefined
    if (typeof durationMs !== 'number' || isNaN(durationMs) || durationMs < 0) {
      return { content: 'Error: duration_ms must be a non-negative number', isError: true }
    }

    const clamped = Math.min(durationMs, MAX_SLEEP_MS)
    const signal = ctx.signal

    // If an abort signal is available, race sleep vs. abort
    if (signal) {
      const slept = await new Promise<number>((resolve) => {
        const start = Date.now()

        const onAbort = (): void => {
          clearTimeout(timer)
          resolve(Date.now() - start)
        }

        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort)
          resolve(Date.now() - start)
        }, clamped)

        if (signal.aborted) {
          clearTimeout(timer)
          resolve(0)
        } else {
          signal.addEventListener('abort', onAbort, { once: true })
        }
      })

      if (signal.aborted) {
        return {
          content: `Sleep interrupted after ${Math.round(slept)}ms (abort signal received).`,
          isError: false,
        }
      }
      return {
        content: `Slept for ${Math.round(slept)}ms.`,
        isError: false,
      }
    }

    // No abort signal — simple sleep
    await new Promise<void>((resolve) => setTimeout(resolve, clamped))
    return {
      content: `Slept for ${clamped}ms.`,
      isError: false,
    }
  }
}
