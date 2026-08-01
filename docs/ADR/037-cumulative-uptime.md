# ADR-037: cumulative uptime across restarts (R34)

## Context

R30 (ADR-033) added `tag-uptime` returning per-tag current-uptime
(wall-clock since startedAt). R34 extends this with
**cumulative uptime** — the sum of past restart cycles' uptime
plus the current cycle.

The use case is "how long has this tier been alive in total":

```sql
client.send({ action: 'tag-uptime' })
// → {
//     totalWorkers: 1,
//     totalCumulativeMs: 45230,  // sum of past + current
//     totalRestartCount: 4,       // sum of restart cycles
//     tags: [
//       { tag: 'cli', count: 1, averageMs: 8234, cumulativeMs: 45230, restartCount: 4 },
//     ],
//   }
```

Without cumulative, a worker that just restarted would show
`averageMs: ~0` even if it had been running for 12 hours across
4 restarts. The cumulative metric aggregates across the full
worker lifetime.

## Implementation

Two fields on `WorkerEntry`:

```ts
interface WorkerEntry {
  restartCount: number          // R34
  cumulativeUptimeMs: number    // R34
}
```

The restart-worker handler updates both before resetting
startedAt:

```ts
const prevStartedAt = new Date(worker.startedAt).getTime()
const prevUptime = Math.max(0, Date.now() - prevStartedAt)
worker.cumulativeUptimeMs += prevUptime
worker.restartCount += 1
worker.status = 'starting'
worker.startedAt = now
```

The previous cycle's uptime is added to the cumulative total,
then startedAt is reset. The next read sees `age = now -
worker.startedAt` for the current cycle, and `cumulative = past
+ current`.

## tag-uptime response

```ts
{
  ok: true,
  data: {
    totalWorkers: 1,
    averageMs: 8234,                  // current-cycle average
    totalCumulativeMs: 45230,         // total across all cycles
    totalRestartCount: 4,             // sum of restart cycles
    tags: [
      {
        tag: 'cli',
        count: 1,
        averageMs: 8234,              // current
        oldestMs: 9120,
        newestMs: 7348,
        cumulativeMs: 45230,         // total
        restartCount: 4,
      },
    ],
  }
}
```

Two fields per tag plus two global totals. The `averageMs` /
`oldestMs` / `newestMs` are current-cycle; `cumulativeMs` is
total. `restartCount` is the number of restart cycles per worker
(sum for the tag).

## Tests

`tests/r13-daemon-slash-command.test.ts` (+2 R34 tests):

1. **R34: tag-uptime returns cumulative uptime across restarts** —
   1 worker, restart once, verify totalCumulativeMs > 0 and
   restartCount == 1.
2. **R34: worker.restartCount increments on each restart** —
   restart twice, verify totalRestartCount == 2.

Plus all 4841 existing tests still pass.

## Verification recipe

```bash
# Confirm cumulative tracking
grep -n "cumulativeUptimeMs" src/core/daemon.ts

# Run daemon slash-command suite (R13–R34)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Why not auto-restart-counter in tag-stats

`tag-stats` (R20) is a counts-and-status aggregation. Adding
uptime to it would conflate two concerns. The dedicated
`tag-uptime` action (R30, R34) is the right place for time-based
metrics. Future round could add `restartCount` to `tag-stats` if
operators want it inline.

## Future work (R35+)

- **Failure-recovery policy**: if a worker fails to restart N
  times, mark it as `failed` and emit a `worker.give_up` event.
- **Restart audit log unification**: emit restart events to
  the engine's EventLog too (currently only the daemon's log).
- **Cycle detection at addWorker time**: validate the parent
  graph when constructing cycles, fail fast with a clear error.
