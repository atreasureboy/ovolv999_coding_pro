# Confirmed Issues (All Resolved)

All issues from the external static audit have been verified and fixed.

## P0 Issues (Critical — Infrastructure Wiring)

| ID | Issue | Status | Fix Commit |
|----|-------|--------|------------|
| P0-1 | Registry not always created | RESOLVED | `cc26b97` |
| P0-2 | No dynamic ExecutionContext | RESOLVED | `cc26b97` (original session) |
| P0-3 | Worktree failure falls back to cwd | RESOLVED | Original session |
| P0-4 | Model controls verify/isolate booleans | RESOLVED | `fa39acb` |
| P0-5 | Merge failure marks success | RESOLVED | Original session |
| P0-6 | wait:false → succeeded | RESOLVED | Original session |
| P0-7 | Stale DONE matches | RESOLVED | Original session |
| P0-8 | WorkerAdapter only has steer | RESOLVED | `5b482bd` |
| P0-9 | No verification gate default | RESOLVED | `fa39acb` |

## P1 Issues (High — Functional Gaps)

| ID | Issue | Status | Fix Commit |
|----|-------|--------|------------|
| P1-1 | ResourceScheduler isolated | RESOLVED | `cc26b97` |
| P1-2 | No resource lifecycle | RESOLVED | Original session |
| P1-3 | Deadlock risk | RESOLVED | Original session |
| P1-4 | toLegacy() strips fields | RESOLVED | `204f50b` |
| P1-5 | Bash exit code semantics | RESOLVED | Original session |
| P1-6 | WorkingState dead code | RESOLVED | `204f50b` |
| P1-7 | No context assembly | RESOLVED | `204f50b` |
| P1-8 | Only 5/9 invariants | RESOLVED | `7188318` |
| P1-9 | No workflow step runs | RESOLVED | Original session |
| P1-10 | Sync blocking shell | RESOLVED | Original session |
| P1-11 | No WorkflowStatus | RESOLVED | Original session |

## P2 Issues (Medium — Robustness)

| ID | Issue | Status | Fix Commit |
|----|-------|--------|------------|
| P2-1 | Cycle detection warns only | RESOLVED | `dc755fc` |
| P2-4 | No RuntimeModelState | RESOLVED | `7188318` |
| P2-5 | Model switch non-transactional | RESOLVED | `dc755fc` |
| P2-6 | No crash state identification | RESOLVED | `5b482bd` |
| P2-7 | No reattach at boot | RESOLVED | `7188318` |
| GAP 7.3 | README stale counts | RESOLVED | `dc755fc` |

## Worker Lifecycle Gaps (GAP 5.1-5.6)

| ID | Issue | Status | Fix Commit |
|----|-------|--------|------------|
| 5.1 | capture/wait keyed on session not runId | RESOLVED | `5b482bd` |
| 5.2 | No wait(runId) adapter method | RESOLVED | `5b482bd` |
| 5.3 | Async death never updates Run | RESOLVED | `5b482bd` |
| 5.4 | reattach synthesizes new runId | RESOLVED | `5b482bd` |
| 5.5 | 'lost' not in RunStatus | RESOLVED | `5b482bd` |
| 5.6 | TASK_FAILED absent | RESOLVED | `5b482bd` |
