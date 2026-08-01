# ADR-019: restart-worker "all" bulk restart (R16)

## Context

R14 (ADR-017) added `restart-worker` IPC action: one worker at a
time. R15 (ADR-018) made it auditable via the engine's EventLog.

But a real workflow needs bulk restart:

- After a config change (e.g. settings.json update), restart all
  workers to pick up the new config
- After a daemon-wide dep upgrade, roll workers one-by-one
- During incident response, "restart everything and see what
  comes back"

Doing this with N individual `/daemon restart <id>` calls is
tedious and slow (each call has round-trip latency). R16 adds
`workerId === 'all'` semantics that the daemon loop implements
in-process.

## Implementation

The daemon's `restart-worker` handler now branches:

```ts
if (workerId === 'all') {
  const ids = Array.from(this.workers.keys())
  if (ids.length === 0) return { ok: true, data: { ... } }
  const results = []
  for (const id of ids) {
    const r = this.handleCommand({ action: 'restart-worker', payload: { workerId: id } })
    results.push({ workerId: id, ok: r.ok })
  }
  const failures = results.filter((r) => !r.ok).length
  return {
    ok: failures === 0,
    data: { workerId: 'all', requested: ids.length, failed: failures, results, ... },
  }
}
```

The key design choice: **each restart still goes through the same
`handleCommand` switch**. We don't duplicate the restart logic —
we just enumerate. This means:

- Single source of truth for restart semantics
- Per-worker failures don't block others
- The response includes per-worker `ok` flags so the caller can
  diagnose which workers failed

## Failure aggregation

`ok: failures === 0` — the bulk action is OK only if every
worker restarted successfully. The per-worker results are still
in the response so the caller can see which ones failed.

This matches the principle of "fail loudly": a partial bulk
restart is a problem. The user can see "8/10 succeeded, 2 failed"
in the response and decide what to do.

## Slash command

`/daemon restart all` — same path as `/daemon restart <id>`,
the only difference is the workerId argument. The slash command
forwards verbatim, so the IPC schema is unchanged.

## Audit trail

R15 already emits `worker_restart` events to the engine's
EventLog. The bulk restart emits ONE event with `workerId: 'all'`
— the per-worker status is in the daemon's response, not a
separate event. This is intentional: a single bulk event is
more useful for tracing than 10 individual events that all share
the same intent.

Future R17+ work: maybe add `worker_restart.bulk` event type
explicitly, with `restarts: ['w1', 'w2', ...]` in the detail. Not
in scope for R16.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+2 R16 tests):

1. **R16: restart-worker all restarts every registered worker** —
   real daemon, 3 workers, real `client.send({ action:
   'restart-worker', payload: { workerId: 'all' } })`. Verifies
   the response shape (`requested: 3, failed: 0, results:
   [...]`), then waits for the simulated restart cycle and
   re-queries `list-workers` to confirm all 3 are back to
   `'running'`.
2. **R16: restart-worker all on empty worker list returns ok with 0** —
   boundary case: no workers registered, the daemon returns
   `ok: true` with `restarted: 0` (graceful no-op).

Plus all 4798 existing tests still pass.

## Verification recipe

```bash
# Confirm bulk semantics
grep -n "workerId === 'all'" src/core/daemon.ts

# Confirm slash command forwards
grep -n "restart <id|all>" src/commands/builtin.ts

# Run the daemon slash-command suite (R13 + R14 + R15 + R16)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R17+)

- **Restart by tag**: `restart-worker { workerId: 'tag:cli' }` —
  restart only workers tagged with a specific label. Useful for
  config rollouts.
- **Throttled bulk restart**: with 100 workers, restarting all
  simultaneously could overload the host. A `concurrency: 4`
  payload option would let the caller pace the restart.
- **Failure-recovery policy**: if a worker fails to restart 3
  times in a row, mark it as `failed` and emit a
  `worker_restart.give_up` event. Currently a worker can
  restart-fail in a loop without auto-quarantine.
