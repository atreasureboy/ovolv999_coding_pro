# ADR-033: tag-uptime action (R30)

## Context

R20 (ADR-023) added `tag-stats` for per-tag counts and status
breakdowns. R30 adds `tag-uptime` for per-tag age statistics.

The use case is "how long has each tier been running on average":

```sql
client.send({ action: 'tag-uptime' })
// → {
//     totalWorkers: 4,
//     averageMs: 8342,
//     tags: [
//       { tag: 'cli', count: 2, averageMs: 8234, oldestMs: 9120, newestMs: 7348 },
//       { tag: 'web', count: 1, averageMs: 8500, oldestMs: 8500, newestMs: 8500 },
//     ],
//   }
```

This answers the operational question "is anything stale?" without
the caller having to enumerate workers and compute ages locally.

## Schema

```ts
{
  ok: true,
  data: {
    totalWorkers: 4,
    averageMs: 8342,
    tags: [
      { tag: 'cli', count: 2, averageMs: 8234, oldestMs: 9120, newestMs: 7348 },
      { tag: 'web', count: 1, averageMs: 8500, oldestMs: 8500, newestMs: 8500 },
    ],
  }
}
```

Each tag entry has:

- `count`: number of workers tagged with this
- `averageMs`: arithmetic mean of `now - startedAt` across workers
- `oldestMs`: longest-running worker
- `newestMs`: shortest-running worker

`totalWorkers` and `averageMs` are global (across all workers, including
untagged).

## Why include untagged in total

`tag-stats` suppresses `untagged` when a tag filter is active
(R23), but `tag-uptime` always includes the global average. The
top-level `averageMs` is meaningful even when no tags are tagged —
it tells the caller how long the daemon has been running its
current set of workers.

## Why "wall-clock since startedAt"

The daemon doesn't track restart history. The `startedAt`
field is updated on each `restart-worker` call (R14), so
"uptime" is "current-uptime-since-last-restart". For a fresh
daemon with no restarts, this equals the daemon's wall-clock age
since the worker was added.

A future round could add cumulative uptime (sum of all restarts')
if restart history is buffered.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+2 R30 tests):

1. **R30: tag-uptime returns per-tag average age** — 4 workers
   (2 cli, 1 web, 1 untagged). After 50ms, all have non-zero
   age. Verifies totalWorkers, averageMs, and per-tag breakdown.
2. **R30: tag-uptime on empty daemon returns zero** — boundary case.

Plus all 4833 existing tests still pass.

## Verification recipe

```bash
# Confirm tag-uptime action
grep -n "tag-uptime" src/core/daemon.ts

# Run daemon slash-command suite (R13–R30)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R31+)

- **Status range filter**: ordinal-style filtering (`statusGte`).
- **Tag inheritance**: workers spawned by another worker
  inherit the parent's tags.
- **Cumulative uptime**: track restart history per worker,
  return total-on-this-tag-lifetime metric.
