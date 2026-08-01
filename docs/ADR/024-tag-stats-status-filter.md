# ADR-024: tag-stats status filter (R21)

## Context

R20 (ADR-023) added `tag-stats` returning per-tag aggregate counts
and per-status breakdowns. The breakdown is useful for inspection
but not for finding problems:

- "How many workers are `failed` right now?" — needs to filter
  by status
- "Which tags have the most `failed` workers?" — same question,
  targeted

R21 adds an optional `payload.status` field to `tag-stats`. When
provided, the response counts *only* workers matching that status
(the others are filtered out before aggregation).

## Schema

```ts
// No filter — all workers counted (R20)
client.send({ action: 'tag-stats' })
// → { totalWorkers, untagged, tags, statusFilter: null }

// Filter — only workers with status='failed'
client.send({ action: 'tag-stats', payload: { status: 'failed' } })
// → { totalWorkers: 3, untagged: 1, tags: [...], statusFilter: 'failed' }
```

The `statusFilter` field is always present in the response (null
when no filter was applied). This lets the caller verify the
filter was honored as expected.

## Validation

Allowed status values are the same `WorkerEntry['status']` union:
`starting | running | stopped | failed`. Any other value, or a
non-string, returns `ok: false` with a clear error:

```
tag-stats invalid status: banana
```

This is the same shape as the other payload-validation guards
in this daemon (R14, R18, R19). Fail-fast with a stable error
string.

## Verified behavior

Default behavior (no filter) is unchanged from R20. The pre-filter
worker list is just filtered early, then aggregated as before.
No data shape changes — `byStatus` is still per-status, but for
filtered queries it will only ever contain the filtered status.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+2 R21 tests):

1. **R21: tag-stats with status=running filter only counts running
   workers** — 4 workers (2 cli starting, 1 web failed, 1
   untagged). Without filter, total=4. With `status: 'running'`,
   total=0 (none are running). After flipping cli1 to running,
   total=1. Verifies the response shape and the post-filter
   counting.
2. **R21: tag-stats with invalid status returns ok=false** —
   exercises the validation guard.

Plus all 4811 existing tests still pass.

## Verification recipe

```bash
# Confirm status filter
grep -n "statusFilter" src/core/daemon.ts

# Confirm validation
grep -n "validStatus" src/core/daemon.ts

# Run daemon slash-command suite (R13–R21)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R22+)

- **Multi-status filter**: `payload: { status: ['failed', 'stopped'] }`
  to focus on multiple statuses at once.
- **Tag metrics aggregation**: `tag-stats` for a single tag with
  `payload: { tag: 'cli' }` — focused subset.
- **Rolling counters**: track tag-stats call frequency per tag
  so the user can see which tags are most-queried.
