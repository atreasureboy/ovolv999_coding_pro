# ADR-038: validate action (R35)

## Context

R33 (ADR-036) added cycle detection inside `collectLabels` so the
worker selector doesn't infinite-loop. The cycle is still
*allowed* in the data model — the daemon doesn't prevent the
caller from creating cycles. R35 adds an explicit `validate` IPC
action that reports cycles without trying to prevent them.

The use case is "before production rollout, validate the worker
graph is a DAG":

```sql
client.send({ action: 'validate' })
// → {
//     ok: true,
//     data: { cycleCount: 0, cycles: [], inCycleCount: 0 }
//   }
```

If a 2-cycle is detected:

```sql
// → {
//     ok: false,
//     data: {
//       cycleCount: 1,
//       cycles: [['worker-a', 'worker-b', 'worker-a']],
//       inCycleCount: 2
//     }
//   }
```

The caller can then decide whether to break the cycle (e.g. by
removing a parentId) or accept it (the daemon still works, the
selector still terminates).

## Implementation

```ts
case 'validate': {
  const inCycle = new Set<string>()
  const cyclePaths: string[][] = []
  for (const w of this.workers.values()) {
    if (inCycle.has(w.id)) continue
    const seen = new Set<string>()
    const path: string[] = []
    let cur: WorkerEntry | undefined = w
    while (cur !== undefined) {
      if (seen.has(cur.id)) {
        const startIdx = path.indexOf(cur.id)
        if (startIdx >= 0) {
          cyclePaths.push(path.slice(startIdx).concat([cur.id]))
          for (const id of path.slice(startIdx)) inCycle.add(id)
          inCycle.add(cur.id)
        }
        break
      }
      seen.add(cur.id)
      path.push(cur.id)
      cur = cur.parentId !== undefined ? this.workers.get(cur.parentId) : undefined
    }
  }
  return {
    ok: cyclePaths.length === 0,
    data: { cycleCount: cyclePaths.length, cycles: cyclePaths, inCycleCount: inCycle.size },
  }
}
```

The algorithm walks each worker's parent chain, looking for a
visited node. Cycles are detected by visiting the same node
twice along the walk. The `inCycle` set tracks which workers are
in any cycle (so we don't re-walk them).

## Why not prevent cycles at addWorker

The daemon's `addWorker` accepts any `parentId` without validation.
This is intentional:

- **Backward compatibility**: existing tests mutate `parentId`
  after creation to set up cycles deliberately (R33 test 2).
  Adding validation at addWorker would break this.
- **Operational flexibility**: the daemon can be in a transient
  inconsistent state during manual repair. Validation is a
  separate action the caller invokes when ready.
- **Reporting vs preventing**: the `validate` action is a
  *diagnostic*, not a guard. Callers can use it to audit, log,
  or alert — without coupling the daemon's structure to a
  specific validation policy.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+2 R35 tests):

1. **R35: validate returns ok=true on a DAG (no cycles)** — 3-
   level chain (gp → parent → child). Returns cycleCount=0.
2. **R35: validate detects a 2-cycle** — 2-cycle (a → b → a).
   Returns cycleCount=1 with cycle path.

Plus all 4843 existing tests still pass.

## Verification recipe

```bash
# Confirm validate action
grep -n "case 'validate'" src/core/daemon.ts

# Run daemon slash-command suite (R13–R35)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R36+)

- **Failure-recovery policy**: if a worker fails to restart N
  times, mark it as `failed` and emit a `worker.give_up` event.
- **Restart audit log unification**: emit restart events to
  the engine's EventLog too (currently only the daemon's log).
- **CLI restart path emitting**: `ovolv999 daemon restart <id>`
  from CLI emits a worker_restart event to the engine's EventLog.
- **Cycle prevention at addWorker**: a future round could add
  `addWorker({ parentId, validate: true })` for callers that
  want strict cycle prevention.
