# Unresolved Risks

## Low Risk (Backward-Compat Deferred)

### 1. Coordinator reads `config.model` directly
**Risk:** The coordinator bypasses `RuntimeModelState` and reads `this.deps.config.model` (a mutable reference). This works today but is the anti-pattern P2-4 aims to replace.
**Mitigation:** The reference is live (same object Engine mutates), so it never goes stale. Migration to `sharedState.modelState.model` is a future cleanup.
**Impact:** None — no functional risk, just architectural debt.

### 2. Module private model copies
**Risk:** Critic (`src/modules/critic.ts:28`) and Reflection (`src/modules/reflection.ts:46`) hold `private model: string` updated via `onModelChanged` push.
**Mitigation:** The push mechanism works correctly. If a module is added that doesn't implement `onModelChanged`, it will use stale model — but all current modules implement it.
**Impact:** Low — modules are in-process and the fan-out is reliable.

### 3. UI store independent model copy
**Risk:** `src/ui/ink/store.ts:260` has its own `setModel()` called separately from `engine.setModel()`. If a caller forgets to call both, the UI banner desyncs from the engine.
**Mitigation:** Only one call site exists (`runInkRepl.ts:177-178`). The Ink UI is optional (`--ink` flag).
**Impact:** Low — cosmetic desync in optional UI mode.

### 4. No dedicated `RunRecoveryService` class
**Risk:** Recovery logic is inlined in `ExecutionEngine` constructor + `recoverWorkers()` method rather than a standalone service.
**Mitigation:** The logic is well-tested (`phase6RecoveryService.test.ts`). Extracting to a service class is a refactoring task, not a functional gap.
**Impact:** None — the behavior is correct, just not decomposed as the spec suggests.

### 5. `run.progress` events carry status in snapshot
**Risk:** The event replay trusts `payload.run.status` from `run.progress` events (line 624 of `executionRunEvents.ts`). A corrupted log could inject an invalid status.
**Mitigation:** `canTransition()` validates every transition during replay. Invalid transitions are caught and skipped.
**Impact:** None — the state machine guards the replay.
