# ADR-044: tag-stats pagination (R41)

## Context

R40 (ADR-043) added `limit` / `offset` to `list-workers`. R41
brings the same pagination to `tag-stats`'s `tags[]` array.
Without it, a daemon with 50 tags would return the full array
in one IPC round-trip.

## Schema

```ts
{
  action: 'tag-stats',
  payload: {
    status?: string | string[],
    exclude?: string | string[],
    tag?: string,
    statusGte?: string,
    statusLte?: string,
    limit: 100,         // R41
    offset: 0,          // R41
  }
}
```

Response adds:

```ts
{
  ok: true,
  data: {
    totalWorkers: N,
    untagged: N,
    tags: TagEntry[],         // paged
    totalTags: N,              // R41: total before pagination
    limit: N,                  // R41
    offset: N,                 // R41
    statusFilter: ...,
    ...
  }
}
```

`totalWorkers` is the count of all workers (post-status filter).
`totalTags` is the count of distinct tags (post-tag filter). The
two are different — 10 workers might share 2 tags.

## Default limit

Same as R40: `limit: 100`. No hard maximum. `limit: 0` returns
empty tags[] (useful for "just give me the totals").

## Why `totalTags` separately

The caller might want to know "how many tags are there?" without
sending another IPC. The `totalTags` field gives the answer
without requiring a follow-up call. It's a small field
(integer) so the overhead is negligible.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+1 R41 test):

1. **R41: tag-stats paginates tags[] array** — 5 workers with
   distinct tags. `limit: 2, offset: 1` returns tags 1-2
   alphabetically.

Plus all 4856 existing tests still pass.

## Verification recipe

```bash
# Confirm pagination
grep -n "tagLimit\|tagOffset" src/core/daemon.ts

# Run daemon slash-command suite (R13–R41)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R42+)

- **Restart audit log unification**: emit restart events to
  the engine's EventLog too (currently only the daemon's log).
- **CLI restart path emitting**: `ovolv999 daemon restart <id>`
  from CLI emits a worker_restart event to the engine's EventLog.
- **Cycle prevention at addWorker**: graph validation at
  creation time (currently only via `validate` action).
- **Reset-on-success policy**: `payload.resetOnSuccess: true`
  for consecutive-failure semantics.
- **Glob shell quoting fix**: better matching for quoted
  shell commands in glob engine.
- **Hook async protocol**: `{async: true}` background hooks.
