# ADR-040: list-workers sortBy (R37)

## Context

R13 (ADR-016) added `list-workers` returning the worker list in
insertion order (V8 Map iteration). R37 adds explicit sort
options so callers can present workers in a stable, predictable
order.

The use case is UI display: a status page showing workers
typically wants them sorted by name (alphabetical) or by status
(failed first, then running, etc.). The default insertion order
is meaningless to users.

## Schema

```ts
{
  action: 'list-workers',
  payload: {
    sortBy: 'name' | 'status' | 'createdAt' | 'insertion',
  }
}
```

- `name` — alphabetical by `worker.name`
- `status` — by lifecycle order: starting(0) → running(1) → stopped(2) → failed(3) (stable: workers with the same status keep insertion order)
- `createdAt` — by `startedAt` ISO string (lexicographic = chronological)
- `insertion` — explicit no-op (default behavior, preserved for clarity)
- `banana` → ok=false with `invalid sortBy: banana`

## Why statusOrder is lifecycle, not alphabetical

Alphabetical status would put `failed` before `running` (alphabetic
order). Lifecycle order is operationally useful:

- Failed first (operator action required)
- Running second (active)
- Stopped third (intentional)
- Starting last (transient)

The lifecycle order means operators see problems at the top.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+3 R37 tests):

1. **R37: list-workers sortBy=name sorts alphabetically** —
   3 workers (charlie, alpha, bravo). Returns alpha, bravo, charlie.
2. **R37: list-workers sortBy=status groups by status first** —
   3 workers (starting, running, failed). Returns starting,
   running, failed.
3. **R37: list-workers invalid sortBy returns ok=false** —
   exercises the validation guard.

Plus all 4849 existing tests still pass.

## Verification recipe

```bash
# Confirm sort options
grep -n "sortBy" src/core/daemon.ts

# Run daemon slash-command suite (R13–R37)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Why not sort the daemon's internal map

The daemon's `workers` Map preserves insertion order. Sorting
in-place would mutate the daemon's state (e.g. the next
`list-workers` without `sortBy` would return the sorted order).
R37 applies the sort on the response only — the daemon's
internal state is unchanged.

This is a more conservative design: callers can explicitly opt
into the sort, and the daemon's internal ordering (which affects
operation but not display) is preserved.

## Future work (R38+)

- **status sort tie-breaker**: when multiple workers have the
  same status, fall back to `name` for deterministic output.
  Today the order is stable but insertion-dependent.
- **Reverse sort**: `payload.sortDir: 'desc'` for descending.
- **Pagination**: `payload.limit` / `payload.offset` for large
  worker counts.
- **Restart audit log unification**: emit restart events to
  the engine's EventLog too (currently only the daemon's log).
