# ADR-041: list-workers sortDir (R38)

## Context

R37 (ADR-040) added `sortBy` to `list-workers`. R38 adds `sortDir`
for `asc`/`desc` ordering. Without `sortDir`, the caller can
sort by name but is stuck in ascending order — useful for "show
me workers Z-A" or "newest first".

## Schema

```ts
{
  action: 'list-workers',
  payload: {
    sortBy: 'name' | 'status' | 'createdAt' | 'insertion',
    sortDir: 'asc' | 'desc',  // default 'asc'
  }
}
```

## Why reverse instead of a comparator flag

A boolean `descending?: true` flag is one option, but enum
bidirectional is more discoverable:

- `sortDir: 'asc'` — explicit default
- `sortDir: 'desc'` — explicit reverse
- Tab completion in scripts surfaces both options
- Future `sortDir: 'asc,desc'` (multi-pass sort) is impossible
  with a boolean

## Validation

```ts
if (sortDir !== undefined && sortDir !== 'asc' && sortDir !== 'desc') {
  return { ok: false, error: `list-workers invalid sortDir: ${String(sortDir)}` }
}
```

Same pattern as `sortBy` validation. Invalid values return
`ok: false` with the same error message style.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+3 R38 tests):

1. **R38: list-workers sortDir=desc reverses** — 3 workers
   (alpha, bravo, charlie). With `sortBy: 'name', sortDir: 'desc'`,
   returns charlie, bravo, alpha.
2. **R38: list-workers sortDir=asc is the default** — 2 workers
   (alpha, bravo). With `sortBy: 'name', sortDir: 'asc'`, returns
   alpha, bravo (matches R37 behavior).
3. **R38: list-workers invalid sortDir returns ok=false** —
   exercises the validation guard.

Plus all 4852 existing tests still pass.

## Verification recipe

```bash
# Confirm sortDir
grep -n "sortDir" src/core/daemon.ts

# Run daemon slash-command suite (R13–R38)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R39+)

- **Pagination**: `limit` / `offset` for large worker counts.
- **Status sort tie-breaker**: when multiple workers have the
  same status, fall back to `name` for deterministic output.
- **Restart audit log unification**: emit restart events to
  the engine's EventLog too (currently only the daemon's log).
- **CLI restart path emitting**: `ovolv999 daemon restart <id>`
  from CLI emits a worker_restart event to the engine's EventLog.
- **Cycle prevention at addWorker**: graph validation at
  creation time (currently only via `validate` action).
- **Reset-on-success policy**: `payload.resetOnSuccess: true`
  for consecutive-failure semantics.
