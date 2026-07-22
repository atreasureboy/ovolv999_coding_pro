# Test Matrix

## Acceptance Criteria Coverage (five_goal §二十一)

| # | Criterion | Test File(s) | Status |
|---|-----------|-------------|--------|
| 1 | Registry always exists | `phase1EngineWiring.test.ts` | ✅ |
| 2 | Turn/Tool/Agent/Worker/Workflow have Runs | `phase1EngineWiring.test.ts`, `phase3WorkerLifecycle.test.ts` | ✅ |
| 3 | Run parent-child relationships | `gapCCoordinatorRunWiring.test.ts` | ✅ |
| 4 | Modify Agent forced isolation | `agentWorktreeIsolation.test.ts` | ✅ |
| 5 | Worktree fail-closed | `agentWorktreeIsolation.test.ts` | ✅ |
| 6 | Verification failure ≠ success | `phase4RunStatusAndVerify.test.ts` | ✅ |
| 7 | Merge failure → blocked | `agentWorktreeIsolation.test.ts` | ✅ |
| 8 | Claude detached non-terminal | `phase3WorkerLifecycle.test.ts` | ✅ |
| 9 | Worker status/steer/cancel/collect | `phase3WorkerLifecycle.test.ts`, `phase3bWorkerLifecycleGaps.test.ts` | ✅ |
| 10 | ResourceScheduler in ToolScheduler | `phase1EngineWiring.test.ts` | ✅ |
| 11 | Tool concurrency by resource | `resourceScheduler.test.ts` (original) | ✅ |
| 12 | StructuredToolResult internal | `phase2StructuredChain.test.ts` | ✅ |
| 13 | WorkingState in context chain | `phase2StructuredChain.test.ts` | ✅ |
| 14 | Compact preserves key state | `workingState.test.ts` (INV-1..9) | ✅ |
| 15 | Workflow per-step runs | (original session tests) | ✅ |
| 16 | AbortSignal full chain | (verified by audit, not isolated test) | ✅ |
| 17 | Resources released on all paths | `resourceScheduler.test.ts` (original) | ✅ |
| 18 | Crash-detectable lost Worker | `phase3bWorkerLifecycleGaps.test.ts` | ✅ |
| 19 | Reattachable Worker | `phase3bWorkerLifecycleGaps.test.ts`, `phase6RecoveryService.test.ts` | ✅ |
| 20 | README no stale counts | (manual verification) | ✅ |

## Fault Injection Coverage (five_goal §十六)

| Scenario | Test File | Status |
|----------|-----------|--------|
| JSONL corrupted line | `gapLFaultInjection.test.ts` L.1 | ✅ |
| Provider stream malformed | `gapLFaultInjection.test.ts` L.2-3 | ✅ |
| ResourceScheduler timeout | `gapLFaultInjection.test.ts` L.4 | ✅ |
| ResourceScheduler abort | `gapLFaultInjection.test.ts` L.5 | ✅ |
| Compaction invariant violation | `gapLFaultInjection.test.ts` L.6 | ✅ |
| Invalid Run transition | `gapLFaultInjection.test.ts` L.7 | ✅ |
| Steer terminal run | `gapLFaultInjection.test.ts` L.8 | ✅ |
| EventStore write failure | `gapLFaultInjection.test.ts` L.9 | ✅ |
| Worktree creation failure | `phase7FaultInjection.test.ts` FI-1 | ✅ |
| Merge conflict → blocked | `phase7FaultInjection.test.ts` FI-2 | ✅ |
| No completion marker | `phase7FaultInjection.test.ts` FI-3 | ✅ |
| Stale DONE | `phase7FaultInjection.test.ts` FI-4 | ✅ |
| Worker stuck | `phase7FaultInjection.test.ts` FI-5 | ✅ |
| Verification timeout | `phase7FaultInjection.test.ts` FI-6 | ✅ |
