/**
 * ReflectionModule — moved to experimental/ in v0.5.3 Closure (P9).
 *
 * It is NOT a production module. The previous production wiring:
 *   - bypassed the Memory Candidate → Promotion lifecycle
 *   - called LongTermMemory.record() directly with repo='reflection'
 *   - fabricated a verification gate from the LLM's own success claim
 *
 * All three behaviors were anti-fake-success regressions. The
 * memory system is now driven by CompletionContract + Evidence +
 * Reviewer → MemoryPromoter.decidePromotion(); there is no
 * independent value a reflection step adds.
 *
 * This file is retained ONLY as a future-home for an honest
 * MemoryCandidate producer. Such a producer would, per spec,
 *   - run inside the verified run scope (not as a hidden path)
 *   - enqueue candidates, never call record() directly
 *   - let the onComplete promoter decide verified/unverified
 *
 * Until that exists, do NOT wire this module into the active
 * profile. The class below is a no-op stub kept so the file still
 * compiles if some test path imports the name; it carries no
 * state, no LTM handle, no system prompt, no parser.
 */

import type { AgentModule, ModuleRunContext } from '../src/core/module.js'

export class ReflectionModule implements AgentModule {
  readonly name = 'reflection-stub'
  readonly dependencies: string[] = []
  // Constructor signature preserved for downstream code that
  // still imports the name; no fields are read.
  constructor(_client?: unknown, _model?: string, _semantic?: unknown, _config?: unknown) {}

  async onComplete(_ctx: ModuleRunContext): Promise<void> {
    /* no-op: see file header */
  }
}
