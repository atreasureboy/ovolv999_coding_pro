/**
 * TaskImpact — single source of truth for impact scopes.
 *
 * v0.5.3 Final (task 1): the schema in tools/taskPlan.ts previously
 * used `['file', 'module', 'package', 'repo', 'external']` while
 * parser + taskGraph used `['local', 'module', 'cross-module',
 * 'repository']`. Two enums → model could pass schema-valid scopes
 * that the parser silently dropped, OR pass parser-valid scopes that
 * the LLM never saw in the schema. We unify on the parser/router
 * vocabulary because that one is wired into the router-side scoring.
 */
export const TASK_IMPACT_SCOPES = [
  'local',
  'module',
  'cross-module',
  'repository',
] as const

export type TaskImpactScope = typeof TASK_IMPACT_SCOPES[number]

export interface TaskImpact {
  scope: TaskImpactScope
  affectsPublicInterface: boolean
  changesConfiguration: boolean
  requiresRootCause: boolean
  /**
   * 0 means "unknown", ≥ 1 is a concrete estimate. Default = 0.
   * v0.5.3: explicit `minimum: 0` in the schema keeps LLM from
   * fabricating "1 file" just to satisfy the >= 1 contract; an
   * honest 0 is the correct answer when the model has no count yet.
   */
  estimatedFiles: number
}

export interface TaskImpactInput {
  scope?: string
  affects_public_interface?: unknown
  changes_configuration?: unknown
  requires_root_cause?: unknown
  estimated_files?: unknown
}

/** True iff `scope` is one of the canonical scopes. */
export function isTaskImpactScope(scope: string): scope is TaskImpactScope {
  return (TASK_IMPACT_SCOPES as readonly string[]).includes(scope)
}
