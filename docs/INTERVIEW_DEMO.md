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
  adapter is the v0.4 target; M3 works via the /v1 facade).
- CommandRunner: ~30 exec sites remain on an allowlist (verification +
  git + loop gates migrated; utils/config helpers pending).
- Control messages: coordinator nudges/critic/snip still use
  `role:user` (compaction fixed to `role:system`); full
  InternalControlMessage type is the remaining Phase 1.2 work.
- claims coverage: 6/27 tools declare claims (concurrency correctness
  is still guaranteed by ResourceScheduler.acquire regardless).

## 15. Roadmap

- **v0.4**: native Anthropic-Messages ProviderAdapter; full
  CommandRunner migration; InternalControlMessage type; SQLite WAL
  EventStore; real-model eval suite.
- **Ongoing**: broader claims coverage; ACP protocol hardening;
  Windows process-tree kill verification.

---

**Verification commands**: `pnpm typecheck` · `pnpm lint` · `pnpm test`
· `pnpm eval:deterministic` · `pnpm check` (all four).
