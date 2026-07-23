# V0.2 Runtime Integrity — Architecture Audit & Status

> Triggered by `six_goal.md` (v0.2 Runtime Integrity convergence).
> Method: traced real call chains against source — never README-based.
> All evidence is `file:line`. Updated 2026-07-23 after the Phase 3/4/6.1 fixes.

## 1. Current real call graph

```
CLI (bin/ovogogogo.ts)
 → ExecutionEngine (assembly root + lifecycle, engine.ts)
   → RuntimeCoordinator.run() (loop driver, coordinator.ts)
     → boot() (module boot, prompt, toolContext, ExecutionContext)
     → [loop] check_abort → budget_check → module_iteration
              → llm_call → ModelGateway.call() → StreamConsumer
              → tool_execution → ToolScheduler.schedule()
                  → partitionToolCalls()  [claims-based, post-Phase 3]
                  → executeWithClaims() → ResourceScheduler.acquire()
                  → ToolExecutor.execute() → Tool.execute()
     → moduleManager.runComplete()
   → ExecutionRunRegistry (always present) + RunEventBus (persist-first)

AgentTool.execute() (agent.ts)
 → registry.create(kind='agent', parentRunId=ctx.execution.runId)
 → [modify] worktree fail-closed → factory(childConfig) → childEngine.runTurn()
 → childAborts[runId] = () => childEngine.abort()  [post-Phase 4]
 → 3-phase outcome: worker → verification → delivery(blocked on conflict)

Recovery (engine ctor)
 → recoverNonTerminalRuns(): non-worker→failed, external_worker→recovery-pending-reattach
 → recoverWorkers() (scheduled, in-flight merge): adapter.reattach() or →lost
```

## 2. Nominal architecture vs real execution path

| Claim | Real state | Evidence |
|---|---|---|
| ProviderAdapter takes over model requests | **NOT wired** — ModelGateway calls `client.chat.completions.create()` directly (OpenAI SDK shape) | modelGateway.ts:91,114,138 |
| Coordinator has no provider branches | **TRUE** — no `if provider===` anywhere | grep clean |
| ResourceScheduler is sole concurrency authority | **TRUE post-Phase 3** — partition is claims-based, legacy whitelist removed | toolScheduler.ts:46-90 |
| Agent cancel terminates running child | **TRUE post-Phase 4** — runId→abort map fires childEngine.abort() | agent.ts:325,864,437 |
| Control messages not disguised as user | **PARTIAL** — compaction summary fixed (system role, no fake ack); coordinator nudges/critic/snip still role:'user' | compact.ts:712, coordinator.ts:314,329,357, critic.ts:77, contextManager.ts:349 |
| max_iterations ≠ succeeded | **TRUE** — maps to `blocked` | coordinator.ts:466-485 |
| Critical event persist failures not swallowed | **TRUE** — JsonlEventStore.append throws on disk-full | gapLFaultInjection.test.ts |

## 3. Parallel / dual implementations

- **Provider layer**: `modelCapabilities.ts` + `providers.ts` define ProviderAdapter/ModelCapabilities, but ModelGateway ignores them → a parallel, unused abstraction. (Phase 1 target.)
- **Worker lifecycle**: WorkerAdapter (start/status/steer/cancel/collect/reattach) is fully implemented on ClaudeCodeTool + AgentTool, but `/workers` slash command talks directly to the manager singleton, bypassing the adapter. Programmatic lifecycle is via the adapter; interactive is direct.
- **EventBus**: always created + persists JSONL, but in-process `.on()` has no production subscriber (extension point).

## 4. Code that bypasses ToolExecutor / permission / ResourceScheduler

- None in the tool-execution hot path post-Phase 3: every tool call goes ToolScheduler → (claims acquire) → ToolExecutor (policy + permission + hooks) → Tool.execute().
- `runVerification` (agent.ts) and Loop quality gates call `execSync` directly — outside the tool path (Phase 2 CommandRunner target).

## 5. Direct exec/execSync/spawn sites (Phase 2 CommandRunner scope)

~30 src files call exec/execSync/spawn directly. Categorised:
- **Core infra (legitimate, transport-layer)**: `claudeCodeWorkerManager`, `backgroundTaskManager`, `backgroundSession`, `lspClient`, `claudeCode.ts`, `sshRemote`, `mcpClient`, `daemon`, `sandbox` — these ARE the process managers; CommandRunner would wrap spawn internally.
- **Business logic (migrate to CommandRunner)**: `agent.ts` runVerification, worktree git ops, LoopEngine quality gates, plus `utils/` (doctor, ide, systemHealth, autoUpdater, notifier), `config/`, `ui/` helpers.
- **Proposed allowlist until migrated**: the utils/config/ui helpers (low-risk, user-facing diagnostics). Verification + git + loop gates migrate first.

## 6. Provider-specific logic location

- `modelGateway.ts:103,112` — `stream_options.include_usage` detection (OpenAI-specific) with fallback latch. Belongs in an OpenAICompatible ProviderAdapter (Phase 1).
- `providers.ts` — model→provider detection from name. OK as a registry helper.
- No provider branches in coordinator/gateway beyond the stream_options compat shim.

## 7. Workers with incomplete lifecycle

- **AgentTool** (in-process): start() unsupported (children synchronous), status/collect are status-checks, cancel **now works** (Phase 4), steer queues. Honest stubs matching the synchronous model.
- **ClaudeCodeTool** (tmux): full lifecycle implemented; only `reattach()` has a production caller (recovery). start/status/steer/cancel/collect/wait are test-reachable + adapter-callable but no production orchestrator drives them yet.

## 8. Persistence errors that could be swallowed

- `JsonlEventStore.append` (write-side) throws on failure — NOT best-effort. ✓
- `ExecutionRunRegistry.transition` / `update` calls are wrapped in `try { } catch { /* best-effort */ }` at many sites (coordinator, agent, claudeCode). These are status-machine updates; a failed transition is non-fatal (the run continues) but is logged only via the catch being empty. Phase 5 (EventStore) should make run-state+event atomic so a failed persist is detectable.

## 9. Modification plan (this round — done)

| Phase | Item | Status |
|---|---|---|
| 3 | Claims-based partition; remove LEGACY_CONCURRENCY_SAFE_TOOLS | ✅ done |
| 3 | `claimsConflictBetween` exported for the planner | ✅ done |
| 4 | AgentTool cancel truly aborts child (runId→abort map) | ✅ done |
| 6.1 | Compaction summary → system role; remove forged assistant ack | ✅ done |
| 0 | This audit document | ✅ done |

## 10. Modification plan (deferred — v0.3 milestones)

1. **Phase 1 — Provider runtime unification**: make ModelGateway delegate to a ProviderAdapter (OpenAICompatible first); move stream_options compat + retry/timeout into the adapter. Biggest remaining architectural gap.
2. **Phase 2 — CommandRunner**: unify exec/execSync/spawn behind a CommandSpec/CommandResult abstraction (timeout, abort, process-tree kill, output limits, sandbox, resource claims). Migrate verification → git → loop gates → tools.
3. **Phase 6.1 remainder — InternalControlMessage**: the coordinator nudges (empty-retry, length-continue, budget-nudge), critic injection, and snip boundary are still `role:'user'`. Introduce an internal message type converted to provider expression at the adapter boundary so they don't pollute genuine user history.
4. **Phase 5 — EventStore (SQLite WAL)**: atomic run-state + event transaction, monotonic sequence, replay, crash rebuild, schema version, JSONL import.
5. **Phase 7 — Eval**: deterministic end-to-end coding eval with baseline comparison.
6. **Phase 8 — Engineering**: package.json hygiene, GitHub Actions (typecheck/lint/unit/integration/eval/build), README Stable/Beta/Experimental labelling.

## 11. Compatibility risks (this round)

- **partitionToolCalls semantics changed**: tools without `metadata.claims` now run serially (previously parallel via whitelist). Production tools that benefit from parallelism (Read/Glob/Grep/Edit/Write/Bash) all declare claims, so valuable parallelism is preserved; claim-less tools (Agent/Todo/etc.) become serial — safer, six_goal-intended. Tests updated.
- **Compaction summary role user→system**: OpenAI accepts system messages mid-history; no alternation break. UI history trimmer keyed on the `[CONVERSATION SUMMARY]` marker, unaffected.
- **AgentTool.cancel**: now has a real side effect (aborts child). No caller relied on the status-only behaviour.

All changes: `tsc 0 err` · `lint 0 err` · full suite green.
