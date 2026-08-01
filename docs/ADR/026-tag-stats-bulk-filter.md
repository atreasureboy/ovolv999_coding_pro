# ADR-026: tag-stats bulk filter (R23)

## Context

R20 (ADR-023) made per-tag stats queryable. R21 (ADR-024) and
R22 (ADR-025) added status filters. R23 completes the consumer
quadrant by adding a **tag filter** so the caller can say
"stats for tag `cli` only" — and combine it with the status
filter for focused queries.

The combination `tag: 'cli', status: 'running'` answers the
common operational question: "how many of my CLI workers are
currently running?" — a single IPC call, no client-side
post-filtering.

## Schema

```ts
// Single tag focus
client.send({ action: 'tag-stats', payload: { tag: 'cli' } })
// → { totalWorkers: 2, tags: [{ tag: 'cli', ... }], tagFilter: 'cli' }

// Tag + status combo
client.send({ action: 'tag-stats', payload: { tag: 'cli', status: 'running' } })
// → { totalWorkers: 1, tags: [{ tag: 'cli', ... }], tagFilter: 'cli', statusFilter: ['running'] }

// Status only (R21/R22 unchanged)
client.send({ action: 'tag-stats', payload: { status: 'failed' } })
// → { tagFilter: null, ... }
```

The `tagFilter` field is added to the response. `null` when no
filter was applied.

## Why `untagged` is suppressed when `tagFilter` is set

Without a tag filter, the `untagged` counter includes workers
that happen to have no tag. With a tag filter, the caller is
specifically asking about that tag — any untagged worker is
irrelevant by definition. Setting `untagged: 0` in this case
preserves the response shape (no missing field) while signaling
"this dimension is zero by construction".

## Validation

`tag` must be a string when provided. Any other type (number,
array, object) returns `ok: false` with `tag-stats invalid tag: <value>`.

For status validation, R21/R22 rules apply unchanged.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+3 R23 tests):

1. **R23: tag-stats with tag filter returns only that tag** —
   4 workers (2 cli, 1 web, 1 untagged). Filter `tag: 'cli'`
   returns only the 2 cli entries, untagged=0, single-tag
   response.
2. **R23: tag-stats with tag + status filter combines both** —
   3 workers, filter `tag: 'cli', status: 'running'` returns
   only the 1 cli worker that is running. Verifies the
   intersection semantics.
3. **R23: tag-stats with non-string tag filter returns ok=false** —
   exercises the type guard.

Plus all 4817 existing tests still pass.

## Verification recipe

```bash
# Confirm tag filter logic
grep -n "tagFilter" src/core/daemon.ts

# Run daemon slash-command suite (R13–R23)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R24+)

- **Bulk filter for restart-worker**: `restart-worker { payload:
  { tag: 'cli', status: 'failed' } }` — combines tag + status
  filters. Symmetric to tag-stats filtering.
- **Time-windowed stats**: `tag-stats { since: '2026-08-01T00:00:00Z' }`
  returns counts in the time window. Requires tracking worker
  startedAt at the daemon level.
- **Per-tag uptime**: average startedAt age per tag, broken
  down by status. Requires tracking restart timestamps.
