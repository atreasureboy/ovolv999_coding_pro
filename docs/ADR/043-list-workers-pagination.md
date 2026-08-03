# ADR-043: list-workers pagination (R40)

## Context

R37 (ADR-040) added `sortBy` and R38 added `sortDir`. R40 adds
`limit` and `offset` for pagination. With 100+ workers, the
caller would receive the entire list in one IPC round-trip —
fine for small daemons, problematic for large ones.

R40 makes the response bounded. The caller can stream workers
in pages of N at a time.

## Schema

```ts
{
  action: 'list-workers',
  payload: {
    sortBy: 'name' | 'status' | 'createdAt' | 'insertion',
    sortDir: 'asc' | 'desc',
    limit: 100,         // default 100, max none
    offset: 0,         // default 0
  }
}
```

Response:

```ts
{
  ok: true,
  data: {
    workers: Array<WorkerEntry>,  // page of results
    total: number,                // total count (not page size)
    offset: number,
    limit: number,
  }
}
```

## Why wrap in `{workers, total, ...}`

The previous shape was `data: WorkerEntry[]` (bare array). Adding
pagination requires a separate `total` field, which would conflict
with the array shape. R40 introduces the wrapper object:

- `workers` is the page
- `total` is the count before pagination

This is a **breaking change** to the response shape. All
existing callers that did `res.data as WorkerEntry[]` need to
update to `res.data as { workers: WorkerEntry[] }`. The existing
tests were updated in R40.

## Default limit

`limit: 100` matches typical IPC frame size limits (JSON over
Unix socket should fit in 64KB easily with 100 workers). Callers
that need more can set higher. There's no maximum — the daemon
doesn't enforce one. The validation is just `Math.max(0, ...)`,
so `limit: 0` returns 0 workers (useful for "just give me the
total count").

## Tests

`tests/r13-daemon-slash-command.test.ts` (+2 R40 tests):

1. **R40: list-workers limit + offset paginates results** —
   5 workers, `limit: 2, offset: 1`. Returns workers 1-2 of
   the alphabetical sort.
2. **R40: list-workers offset beyond total returns empty** —
   3 workers, `offset: 99`. Returns 0 workers, total: 3.

Plus all 4855 existing tests still pass (after the breaking
change to R37/R38 tests was reconciled).

## Verification recipe

```bash
# Confirm pagination
grep -n "limit\|offset" src/core/daemon.ts | head -5

# Run daemon slash-command suite (R13–R40)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Why not use the standard `pagination` envelope

Some APIs use `pagination: { total, limit, offset, hasMore }` —
this is more verbose. R40 keeps the data flat (`{ workers,
total, limit, offset }`) to match the response style of other
daemon actions (e.g. `tag-stats` returns `{ totalWorkers, untagged,
tags }` at the same level). A future round could add `hasMore` for
infinite-scroll UI.

## Future work (R41+)

- **tag-stats pagination**: same `limit` / `offset` for the
  `tags[]` array. Trivial duplication, defer until asked.
- **Restart audit log unification**: emit restart events to
  the engine's EventLog too (currently only the daemon's log).
- **CLI restart path emitting**: `ovolv999 daemon restart <id>`
  from CLI emits a worker_restart event to the engine's EventLog.
- **Cycle prevention at addWorker**: graph validation at
  creation time (currently only via `validate` action).
- **Reset-on-success policy**: `payload.resetOnSuccess: true`
  for consecutive-failure semantics.
