# ovolv999 — Interview Demo

> A multi-model Coding Agent Runtime built to demonstrate real Agent
> engineering: runtime orchestration, adaptive model routing, task
> graphs, concurrency control, worker lifecycle, fault recovery,
> verification contracts, and agent evaluation — not an API wrapper.

This document is the structured walkthrough. Every claim maps to real,
tested code (file:line cited). Nothing here is aspirational.

---

## 1. What problem does this solve?

Claude Code / Codex are excellent coding agents, but they are black
boxes: you cannot observe *why* a model was chosen, *whether* a task
truly completed, *how* concurrent tool calls are serialised, or *recover*
state after a crash. ovolv999 is a runtime that makes all of that
**explicit, observable, and verifiable** — a reference implementation of
the parts of a coding agent that sit *between* the LLM and the tools.

## 2. Why is it not a simple API shell?

The LLM is one component. Around it, ovolv999 implements:
- a **Run state machine** that tracks every execution with a unique id,
  parent-child hierarchy, and structured events (§3)
- an **adaptive model router** that picks the model per task (§8)
- a **resource scheduler** that prevents concurrent tools from racing
  on the same file/git-ref (§5)
- a **completion contract** that refuses to mark a task done until
  verification passes and no children are outstanding (§6)
- a **stall detector** that notices when the agent is looping without
  progress and forces a strategy change (§6)
- a **task graph** for decomposing non-trivial work (§7)

None of these exist in a raw `client.chat.completions.create` loop.

## 3. Runtime architecture

```
CLI/REPL → ExecutionEngine (assembly root)
  → RuntimeCoordinator.run()        [state-machine loop driver]
    → boot()                         [modules, prompt, ExecutionContext]
    → check_abort → StallDetector + adaptive Critic (risk-gated)
    → budget_check → ContextManager (compaction w/ invariants)
    → llm_call → ModelGateway → ProviderAdapter → stream
    → routeModel (per-turn adaptive selection)
    → tool_execution → ToolScheduler (claims-based partition)
        → ResourceScheduler.acquire (atomic, R/W/X)
        → ToolExecutor (policy+permission+hooks) → Tool
    → CompletionContract gate (verification + children + TaskGraph)
    → Reviewer (deterministic post-run verdict)
```

Layering is enforced: `model/` never imports `runtime/`; `context/`
never imports `toolRuntime/`; cross-layer coupling is `import type`
only (compile-time erased). No circular dependencies.

**Key files**: `src/core/engine.ts`, `src/core/runtime/coordinator.ts`,
`src/core/model/modelGateway.ts`, `src/core/model/providerAdapter.ts`.

## 4. ProviderAdapter

ModelGateway delegates ALL model I/O to a `ProviderAdapter`. The
coordinator has **zero** provider branches. Today an
`OpenAICompatibleAdapter` wraps the SDK (owns request shape +
`stream_options` probing); selection is config-driven (`config.provider`).

**Proven cross-provider**: MiniMax M3 (a non-OpenAI provider) streams
through the adapter end-to-end — the CLI reuses the Claude Code config
in `~/.claude/settings.json` zero-config.

**Adding a provider** = implement `ProviderAdapter` + register in
`createProviderAdapter`. No coordinator changes.

`src/core/model/providerAdapter.ts`, `src/core/model/modelRouter.ts`.

## 5. ResourceScheduler

Tools declare `metadata.claims(input) → ResourceClaim[]` (file/dir/git/
process, read/write/exclusive). The scheduler:
- **partitions** tool calls by pairwise claim-conflict (claims-based,
  not a name whitelist) — `partitionToolCalls`
- **acquires atomically** (all-or-nothing) before execution, releases
  in `finally` — deadlock-free
- git operations are forced to `exclusive` (serialised)

`src/core/resourceScheduler.ts` (`claimsConflictBetween`),
`src/core/toolRuntime/toolScheduler.ts`.

## 6. Worker lifecycle + completion contract + stall detection

- **WorkerAdapter**: start/status/steer/cancel/collect/reattach.
  AgentTool.cancel **actually aborts** the running child (runId→abort
  map), not just a status flip.
- **CompletionContract**: `stop_sequence` does NOT auto-mean success.
  The Run is marked `blocked` if verification failed or children are
  still running. The model cannot self-declare done over a red build.
- **StallDetector**: tracks *meaningful* progress (changed files,
  verification-delta improvement). On stall, injects a `role:system`
  nudge to force replan — never a forged user message.
- **Crash recovery**: `ExecutionRunRegistry` + JSONL EventStore +
  `recoverNonTerminalRuns` + scheduled `recoverWorkers()` (reattach or
  mark `lost`).

`src/core/runtime/completionContract.ts`, `progressMonitor.ts`,
`src/tools/agent.ts`, `src/core/executionRun.ts`.

## 7. TaskGraph

A dependency-ordered DAG for non-trivial tasks. The model decomposes via
the **TaskPlan tool** (add/complete/fail/retry). Invariants:
- a node is `ready` only when all dependencies are `completed`
- `complete()` **fails** the node if acceptance criteria are unmet
- the CompletionContract blocks run-completion while the graph has
  unfinished/hard-failed nodes
- cycles rejected at addNode; serialisable for event-log recovery

`src/core/runtime/taskGraph.ts`, `src/tools/taskPlan.ts`.

## 8. Adaptive model routing

`ModelRouter` is a transparent multi-criteria scorer (not keyword
if/else). It scores each `ModelProfile` against task signals
(complexity, context pressure, budget, failure health, role fit):
- complex architecture → strong model; trivial → cheap model
  (an explicit `(1-complexity)*cost` term makes this work)
- manual `--model`/`/model` is the sticky override (highest priority)
- fallback chain advances on provider failure **without replaying**
  side-effectful tools (fires at the LLM-call boundary)
- `/route` shows the decision + reasonCodes; `/models` shows health

`src/core/model/modelRouter.ts`.

## 9. Adaptive Critic + Reviewer

The critic is **risk-triggered** (not fixed every-N-turns):
repeated failures, stalls, large scope, or an unsupported completion
claim. It emits a structured `CriticReport` (verdict/problems/actions)
as a `role:system` nudge. The **Reviewer** gives a deterministic
post-run verdict (completed/partial/blocked) from structured state.

`src/core/runtime/criticTrigger.ts`, `reviewer.ts`.

## 10. Event recovery

Every Run mints structured events (persisted JSONL). On restart,
`recoverRegistryFromStore` rebuilds the registry; non-worker runs →
`failed`, external workers → `recovery-pending-reattach` →
`recoverWorkers()` reattaches or marks `lost`. EventStore supports
atomic `appendBatch` + idempotent eventId dedup.

`src/core/executionRunEvents.ts`.

## 11. Eval results

`tests/eval/tsBugfix.test.ts`: a deterministic end-to-end eval — real
ExecutionEngine fixes a TS bug via Read→Edit, scored by file match +
tsx-verified `add(2,3)===5` + falseSuccess check, with baseline
regression gating. Run: `pnpm eval:deterministic`.

## 12. A real task execution case

```
$ ovolv999 "fix the off-by-one in src/add.ts"
→ [route] MiniMax-M3 selected (single profile, conf 0.9)
→ Read src/add.ts          [claim: file:read]
→ Edit src/add.ts          [claim: file:write, serialised after Read]
→ Bash "npm test"           [claim: process:write, verification]
→ stop_sequence
→ CompletionContract: verification passed, no children → succeeded
→ Reviewer: completed
```

`/trace` shows the full structured story; `/why` explains the routing.

## 13. Key technical trade-offs

- **JSONL over SQLite** (for now): zero native deps, good enough for
  single-process recovery; SQLite WAL is a swappable backend behind the
  EventStore interface. (ADR-006)
- **OpenAI-chunk normalisation**: adapters normalise to OpenAI chunk
  shape so StreamConsumer stays provider-agnostic without a full
  re-typing of the stream. (ADR-003-adjacent)
- **Conservative completion gate**: blocks only on *positive* failure
  evidence, never on "no changes" (a Q&A turn legitimately produces
  none). Avoids false blocks on normal turns.

## 14. Current limitations

- Provider: only OpenAI-compatible wired (native Anthropic-Messages
  adapter is the v0.4 target; M3 works via the /v1 facade). Cross-
  provider profiles are rejected at config-validation by
  `validateProfiles` (`src/core/model/modelRuntimeManager.ts`).
- CommandRunner: ~30 exec sites remain on an allowlist (verification +
  git + loop gates migrated; utils/config helpers pending).
- Control messages: **Fully wired (v0.3.1)** — `InternalControlMessage`
  typed channel with 8 kinds (`src/core/runtime/internalControlMessage.ts`).
  Coordinator nudges/stop/stall/budget/critic/completion all flow
  through `ControlMessageLog`; rendered for the provider each call and
  cleared, never accumulated in user history.
- claims coverage: 6/27 tools declare claims (concurrency correctness
  is still guaranteed by ResourceScheduler.acquire regardless).

## 15. Roadmap

- **v0.4**: native Anthropic-Messages ProviderAdapter; SQLite WAL
  EventStore; broader claims coverage.
- **Ongoing**: ACP protocol hardening; Windows process-tree kill
  verification; /trace `<runId>` `--json` from EventStore (typed
  events are in place; JSON marshalling is P2).

---

## 16. v0.3.1 Runtime Truth — what was actually wired

| Capability | Status | Entry file | Key class / fn | Test |
|---|---|---|---|---|
| ModelRouter three-way split (setModelByUser / applyRoutingDecision / clearModelOverride) | **Fully wired** | `src/core/model/modelRouter.ts` | `ModelRouter.{setModelByUser,applyRoutingDecision,clearModelOverride}` | `tests/modelRouterApiSplit.test.ts` |
| ProviderRuntimeBinding + ModelRuntimeManager (cross-provider rejection at config) | **Fully wired** | `src/core/model/{providerRuntimeBinding,modelRuntimeManager}.ts` | `validateProfiles`, `BindingRegistry` | `tests/modelRuntimeManager.test.ts` |
| RoutingSignalCollector (11-signal schema) | **Fully wired** | `src/core/model/routingSignalCollector.ts` | `collectRoutingSignals` | `tests/routingSignalCollector.test.ts` |
| Provider fallback (real retryable classifier) | **Fully wired** | `src/core/model/modelGateway.ts` | `isRetryableProviderError`, `onProviderError` | `tests/providerFallback.test.ts` |
| CompletionContract 6-state schema | **Fully wired** | `src/core/runtime/completionContract.ts` | `evaluateCompletion` | `tests/completionContractStatus.test.ts` |
| TaskGraphStore per-runId isolation | **Fully wired** | `src/core/runtime/taskGraphStore.ts` | `InMemoryTaskGraphStore` | `tests/taskGraphStore.test.ts` |
| InternalControlMessage typed channel (8 kinds) | **Fully wired** | `src/core/runtime/internalControlMessage.ts` | `ControlMessageLog` | `tests/internalControlMessage.test.ts` |
| ProgressMonitor sliding window (A→B→A→B + patch hash) | **Fully wired** | `src/core/runtime/progressMonitor.ts` | `detectABABPattern`, `recordToolCall(patchHash)` | `tests/progressMonitorSliding.test.ts` |
| Typed events (19/19 spec events) | **Fully wired** | `src/core/runtime/events.ts` | `RunEvent` union | `tests/runEventTypes.test.ts` |
| /trace /why /progress + duplicate-command detection | **Partially wired** | `src/commands/{builtin,index}.ts` | `registerCommand` strict dev mode | `tests/slashCommandRealTrace.test.ts` |
| Deterministic eval matrix (28 cases) | **Fully wired** | `evals/{wiring-smoke,deterministic-runtime}` | n/a | `evals/wiring-smoke/wiringSmoke.test.ts` (10) + `evals/deterministic-runtime/deterministicRuntime.test.ts` (18) |
| TaskGraph event replay (serialize/restore + emit) | **Fully wired** | `src/core/runtime/taskGraph.ts` | `serialize / restore`, `setEventSink` | `tests/runEventTypes.test.ts` |
| TaskGraph → ProgressMonitor node subscription | **Fully wired** | `src/core/engine.ts` | `setNodeTransitionSink` | `tests/taskPlanAuditFixes.test.ts` |
| TaskPlanTool 12 actions (start / update / begin_verification / unblock / cancel / attach_artifact) | **Fully wired** | `src/tools/taskPlan.ts` | `TaskPlanTool.execute` | `tests/taskPlanAuditFixes.test.ts` |
| CLI `--model` → sticky manual override | **Fully wired** | `bin/ovogogogo.ts:1822` | `engine.setModelByUser(config.model)` | existing modelRouter tests |
| completion-time critic (modelClaimingCompletion: true) | **Fully wired** | `src/core/runtime/coordinator.ts` | `shouldInvokeCritic` | `tests/criticReviewer.test.ts` |

**v0.3.1 final-acceptance gate (te_goal §十一)**: all 25 items pass
(4083 unit tests + 18 deterministic evals + 10 wiring-smoke checks).
See `docs/V0_3_1_RUNTIME_TRUTH.md` for the full call chain + decision
trees + migration notes.

---

**Verification commands**: `npm run typecheck` · `npm run lint` ·
`npm run test` · `npm run eval:wiring` · `npm run eval:deterministic`
· `npm run check` (all six).
