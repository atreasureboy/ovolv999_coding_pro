# ADR-034: status range filter (R31)

## Context

R21-R22 (ADR-024/025) added `payload.status` for include filtering.
R25-R26 (ADR-028/029) added `payload.exclude` for exclusion. R31
adds ordinal range filtering: `statusGte` / `statusLte`.

The lifecycle of a worker has a natural order:

```
starting (0)  →  running (1)  →  stopped (2)  /  failed (3)
```

The user can ask "give me everything in the active state or later":
`statusGte: 'running'` matches running, stopped, failed.

Or "give me only terminal-state workers": `statusGte: 'stopped'`
matches stopped, failed.

Or a true range: `statusGte: 'running', statusLte: 'failed'` matches
running + stopped + failed (everything except starting).

## Schema

```ts
// Gte only
client.send({ action: 'tag-stats', payload: { statusGte: 'running' } })
// → running, stopped, failed

// Lte only
client.send({ action: 'tag-stats', payload: { statusLte: 'running' } })
// → starting, running

// Range
client.send({ action: 'tag-stats', payload: { statusGte: 'running', statusLte: 'stopped' } })
// → running, stopped
```

Both fields are optional. They can be combined with `status`,
`exclude`, and `tag` filters.

## Lifecycle ordering

The mapping is fixed for the daemon's lifetime:

```ts
const STATUS_ORDER: Record<string, number> = {
  starting: 0,
  running: 1,
  stopped: 2,
  failed: 3,
}
```

`failed` is "later" than `stopped` because typically a failure
interrupts a running worker, leaving the worker in a more degraded
state. The daemon doesn't enforce this ordering — workers can
move freely between statuses — but the *range filter* uses this
ordering to give users a consistent lifecycle vocabulary.

## Validation

Both fields must be strings (already in the status whitelist):

- `statusGte: 'banana'` → ok=false, error: `tag-stats invalid statusGte: banana`
- `statusGte > statusLte` → ok=false, error: `tag-stats statusGte (3) > statusLte (1)`

The latter catches user errors where the caller switches the
two arguments in their head.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+2 R31 tests):

1. **R31: tag-stats with statusGte=running filters out starting workers** —
   3 cli workers (starting, running, failed). Filter
   `statusGte: 'running'` returns 2 (running + failed).
2. **R31: tag-stats with statusGte > statusLte returns ok=false** —
   exercises the validation guard.

Plus all 4835 existing tests still pass.

## Verification recipe

```bash
# Confirm status range
grep -n "statusGte" src/core/daemon.ts

# Run daemon slash-command suite (R13–R31)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R32+)

- **Tag inheritance**: workers spawned by another worker inherit
  the parent's tags.
- **Failure-recovery policy**: if a worker fails to restart N
  times, mark it as `failed` and emit a `worker.give_up` event.
- **Restart audit log unification**: emit restart events to
  the engine's EventLog too (currently only the daemon's log).
