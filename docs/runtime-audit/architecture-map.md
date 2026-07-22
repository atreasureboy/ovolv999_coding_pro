# Architecture Map

## Current State (Post-Convergence)

### Execution Layer
- **ExecutionEngine** (`src/core/engine.ts`) — thin facade, wires subsystems
  - Registry always created BEFORE tools (Phase 1 rewired)
  - ResourceScheduler always instantiated and wired into ToolScheduler
  - Boot recovery: non-worker runs → `failed`, worker runs pending reattach
- **RuntimeCoordinator** (`src/core/runtime/coordinator.ts`) — main loop driver
  - `max_iterations` → `blocked` (not `succeeded`)
  - WorkingState injected into system prompt per-LLM-call
- **ToolScheduler** + **ToolExecutor** — resource-aware batching + single gate
  - `applyToolEvent()` fires from ToolExecutor (single integration point)
  - ResourceScheduler acquires claims atomically, releases in finally

### Tool Layer
- **StructuredToolResult** — `{ status, exitCode, stdout, stderr, ... }` preserved through executor
- **Bash** — separate `stdout`/`stderr` fields, `acceptableExitCodes` support
- **AgentTool** — modify mode forces `verify=true` (model cannot bypass)
- **ClaudeCodeTool** — full WorkerAdapter lifecycle (start/status/steer/cancel/collect/wait/reattach)
  - `TASK_FAILED` sentinel in prompt + waitFor
  - runId-keyed capture/wait/send/stop (not session-keyed)
  - status() writes back `lost` to registry on pane disappearance

### State Machines
- **RunStatus**: `queued → preparing → running → waiting → verifying → succeeded/failed/blocked/lost`
  - `lost` is terminal (worker died out-of-band)
  - `blocked` is resumable (merge conflict, resource contention)
- **WorkingState**: 9 compaction invariants (INV-1..9)
  - constraints, confirmedFacts, filesChanged, verification.failed, unresolved
  - objective, decisions, nextActions, artifacts

### Model State (P2-4)
- **RuntimeModelState** on SharedRuntimeState — single source of truth
  - `updateModelState()` bumps version + notifies subscribers
  - `MODEL_CHANGED` event emitted on switch
  - Transactional rollback on failure

### Module System
- Cycle detection → hard boot failure (not best-effort warning)
- Topological boot layers with critical/best_effort policy

### Recovery
- `recoverRegistryFromStore()` — event replay from JSONL
- `recoverWorkers()` — async reattach attempt for external_worker runs
  - Reattach succeeds → run stays alive
  - Reattach fails → run → `lost`
