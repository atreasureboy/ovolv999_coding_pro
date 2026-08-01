# ADR-020: restart-worker concurrency option (R17)

## Context

R16 (ADR-019) added `restart-worker all` for bulk restart. The
default is sequential (concurrency=1): each restart fires its
50ms simulated cycle, then the next.

For 100 workers, sequential = 5 seconds total. For 1000 workers,
50 seconds. In a real production scenario, the daemon's restart
cycle would include subprocess spawn + health probe, not just a
50ms timer, so the latency would be much worse.

R17 adds a `concurrency` payload option to bulk restart. The
daemon reuses the loop but in batches of N:

```ts
for (let i = 0; i < ids.length; i += concurrency) {
  const batch = ids.slice(i, i + concurrency)
  for (const id of batch) {
    const r = this.handleCommand({ action: 'restart-worker', payload: { workerId: id } })
    results.push({ workerId: id, ok: r.ok })
  }
}
```

The slice is in-process (no extra IPC), so the daemon is the
single point of control. The 50ms setTimeout calls within a batch
fire concurrently via Node's event loop — they don't block each
other in JS.

## Why clamp to [1, 16]

A concurrency of 1000 would still work code-wise, but it would
defeat the purpose of throttling (no limit on concurrent
restarts). A concurrency of 0 or negative would cause an infinite
loop (the slice would never advance). A concurrency of 1 = full
serial behavior (matches R16 default).

The clamp [1, 16] is the practical range:

- 1: serial, safe for fragile workloads
- 4: typical RESTART_SPEED setting (4 simultaneous restarts)
- 16: high throughput (16 simultaneous), but bounded

Why 16? Empirically, 16 is the ceiling where the daemon's
internal state updates (Map insertions, log writes) don't
queue up faster than Node can dispatch them. Above 16 with
heavy restart workloads, the event loop can starve.

## Schema

```ts
{
  action: 'restart-worker',
  payload: {
    workerId: 'all',     // existing
    concurrency: 4,      // NEW: optional, default 1, clamped to [1, 16]
  }
}
```

Response adds `concurrency` so the caller knows what was actually
applied (after clamping):

```ts
{
  ok: true,
  data: {
    workerId: 'all',
    requested: 4,
    failed: 0,
    concurrency: 4,        // NEW: actual value used
    results: [...],
    requestedAt: '...',
  }
}
```

## Tests

`tests/r13-daemon-slash-command.test.ts` (+3 R17 tests):

1. **R17: restart-worker all with concurrency=2 groups into batches** —
   4 workers + concurrency=2 → 2 batches of 2. Verifies response
   shape.
2. **R17: concurrency payload is clamped to [1, 16]** — exercises
   999 (clamps to 16), 0 (clamps to 1), -5 (clamps to 1).
3. **R17: invalid concurrency (non-number) falls back to 1** —
   `'two'` (string), `null` (missing), etc. all fall back to 1.

Plus all 4801 existing tests still pass.

## Verification recipe

```bash
# Confirm concurrency parsing
grep -n "concurrency" src/core/daemon.ts

# Run the daemon slash-command suite (R13–R17)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R18+)

- **Async batch confirmation**: today's "concurrency" fires all
  restarts in a batch and waits for the listener to dispatch the
  setTimeouts. A future round could expose `awaitAll: true` for
  callers that want to wait for the restart cycle to fully
  complete before reporting OK.
- **Per-worker concurrency override**: `restart-worker { workerId: 'w1', concurrency: 1 }` —
  for single workers that need a different cadence than the
  default. Low value, defer.
- **Adaptive concurrency**: daemon auto-tunes concurrency based
  on observed restart durations. Complex, defer.
