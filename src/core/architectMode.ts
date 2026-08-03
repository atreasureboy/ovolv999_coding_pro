/**
 * Architect/editor mode — v0.5.2 (C13 — borrowed from aider
 * `aider/coders/architect_coder.py`).
 *
 * Aider's architect mode is a SEQUENTIAL two-step flow:
 *   1. architect LLM call — read-only, "weak" reasoning model,
 *      returns a structured PLAN
 *   2. editor LLM call — write-enabled, "strong" coding model,
 *      receives the plan and emits the diff
 *
 * The Planner/Executor split is the same pattern ovolv999 already
 * uses for multi-agent (ModelProfile.roles, v0.5.0). What's missing
 * is a single-call helper that wires it up deterministically:
 * one user prompt, two LLM rounds, plan + diff as the result.
 *
 * We expose this as a pure helper — the caller (a slash command,
 * a hook, or a tool) provides the two model profiles and the
 * prompt; the helper runs both rounds through the existing
 * ModelGateway and returns the plan + the diff.
 *
 * Production caller: a future `/architect <task>` slash command.
 * For v0.5.2 we ship the helper + tests; the slash command wires
 * in via the same pattern as `/plan`.
 */

import type { ModelProfile } from './model/modelRouter.js'

export interface ArchitectExecutorInput {
  /** The user's task. */
  prompt: string
  /** Profile for the planning round (typically cheap / read-only). */
  planner: ModelProfile
  /** Profile for the executor round (typically top / write-enabled). */
  executor: ModelProfile
  /** Optional context block (files / repo map / etc.). */
  context?: string
  /** LLM-callable. The tool layer passes this in. */
  llmCall: (model: string, systemPrompt: string, userPrompt: string) => Promise<string>
}

export interface ArchitectExecutorResult {
  /** The plan emitted by the architect round. */
  plan: string
  /** The diff / edit payload emitted by the executor round. */
  diff: string
  /** The model that produced the diff. */
  executorModel: string
}

const PLANNER_SYSTEM_PROMPT = `You are a senior software architect. Read the user's task and the available context, then output a CONCISE implementation plan.

Rules:
- Output only the plan, no preamble
- Reference exact file paths when proposing changes
- List the steps in order
- Flag risks / unknowns at the end
- DO NOT emit code — the executor round will do that`

const EXECUTOR_SYSTEM_PROMPT = `You are an expert implementer. You receive an architect's plan and the user's original task. Produce the minimal edit-format output that implements the plan.

Rules:
- Output only the edit, no preamble
- Use the project's documented edit format (default: editblock)
- Match the exact file paths from the plan
- If the plan is ambiguous, ask one question instead of guessing`

/**
 * Run the two-round architect/editor flow. Returns the plan and the
 * executor's diff. The executor round is aborted if the planner
 * returns an empty plan (no point asking the executor to produce
 * edits for nothing).
 */
export async function runArchitectExecutor(
  input: ArchitectExecutorInput,
): Promise<ArchitectExecutorResult> {
  const planUser = input.context
    ? `## Context\n${input.context}\n\n## Task\n${input.prompt}`
    : input.prompt
  const plan = await input.llmCall(input.planner.model, PLANNER_SYSTEM_PROMPT, planUser)
  if (!plan.trim()) {
    return { plan: '', diff: '', executorModel: input.executor.model }
  }
  const execUser = `## Original task\n${input.prompt}\n\n## Plan\n${plan}`
  const diff = await input.llmCall(input.executor.model, EXECUTOR_SYSTEM_PROMPT, execUser)
  return { plan, diff, executorModel: input.executor.model }
}

/**
 * Convenience: format the plan + diff as a single markdown block
 * the slash command can render to the user.
 */
export function formatArchitectResult(r: ArchitectExecutorResult): string {
  if (!r.plan) return '(planner returned no plan — aborting)'
  const lines: string[] = ['## Plan', r.plan, '', `## Diff (${r.executorModel})`, '```', r.diff, '```']
  return lines.join('\n')
}