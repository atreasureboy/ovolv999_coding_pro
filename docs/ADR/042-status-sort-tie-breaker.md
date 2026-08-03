# ADR-042: status sort tie-breaker (R39)

## Context

R37 (ADR-040) added `sortBy: status` to `list-workers`. With
multiple workers in the same status, the order depended on
insertion order (interpreter-level Array.sort is stable in V8,
but the contract wasn't explicit). R39 makes the secondary
sort key explicit: name.

The use case is repeatable output:

```sql
client.send({ action: 'list-workers', payload: { sortBy: 'status' } })
// → charlie, alpha, bravo  (insertion order, all starting)
```

vs. with R39:

```sql
client.send({ action: 'list-workers', payload: { sortBy: 'status' } })
// → alpha, bravo, charlie  (name-sorted, all starting)
```

The R39 output is reproducible across daemon restarts and
across scripts. In CI / diff scenarios, the same daemon state
in two snapshots produces the same list output.

## Schema

```ts
if (sortBy === 'status') {
  const statusOrder: Record<string, number> = { starting: 0, running: 1, stopped: 2, failed: 3 }
  workers = [...workers].sort((a, b) => {
    const sa = statusOrder[a.status] ?? 99
    const sb = statusOrder[b.status] ?? 99
    if (sa !== sb) return sa - sb
    return a.name.localeCompare(b.name)
  })
}
```

Two-step comparator:
1. Primary: status lifecycle order
2. Secondary: name (alphabetical)

## Why name, not startedAt

`startedAt` is a timestamp. Using it as a tie-breaker would
expose the test to timestamp non-determinism (the daemon's
internal clock might tick between tests). `name` is a stable
identifier chosen by the operator.

## Why not insertion order

V8's Array.sort is stable for arrays of length < 10, but the
ECMAScript spec doesn't guarantee stability. The contract says
"tied workers keep their relative order from the input" but
doesn't promise that input order is the same as insertion order.
Making the tie-breaker explicit removes the dependency on
interpreter behavior.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+1 R39 test):

1. **R39: sortBy=status uses name as tie-breaker (deterministic)** —
   3 workers with the same status (starting). Insert order:
   charlie, alpha, bravo. Output: alpha, bravo, charlie.

Plus all 4853 existing tests still pass.

## Verification recipe

```bash
# Confirm tie-breaker
grep -n "tie-break by name" src/core/daemon.ts

# Run daemon slash-command suite (R13–R39)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R40+)

- **Pagination**: `limit` / `offset` for large worker counts.
- **Restart audit log unification**: emit restart events to
  the engine's EventLog too (currently only the daemon's log).
- **CLI restart path emitting**: `ovolv999 daemon restart <id>`
  from CLI emits a worker_restart event to the engine's EventLog.
- **Cycle prevention at addWorker**: graph validation at
  creation time (currently only via `validate` action).
- **Reset-on-success policy**: `payload.resetOnSuccess: true`
  for consecutive-failure semantics.
