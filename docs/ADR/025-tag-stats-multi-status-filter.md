# ADR-025: tag-stats multi-status filter (R22)

## Context

R21 (ADR-024) added `payload.status: string` for single-status
filter. Real operational queries need multiple:

- "How many workers are `failed` OR `stopped`?" — both problems
- "Show me every worker that's not `running`" — three-status
  filter

R22 extends `payload.status` to accept `string[]`. The semantics
are OR (a worker matches if its status is in the list), which
matches the multi-tag selector (R19) and avoids the "intersection
of two statuses" ambiguity (a worker has exactly one status).

## Schema

```ts
// Single status (R21 shorthand, still works)
client.send({ action: 'tag-stats', payload: { status: 'failed' } })
// → statusFilter: ['failed']

// Multi-status (R22)
client.send({ action: 'tag-stats', payload: { status: ['failed', 'stopped'] } })
// → statusFilter: ['failed', 'stopped']

// All statuses (no filter)
client.send({ action: 'tag-stats' })
// → statusFilter: null
```

The `statusFilter` field type is now `string[] | null` (was
`string | null` in R21). This is a **breaking** change to the
response shape, but only the test that asserted
`statusFilter === 'running'` was affected — a real caller would
have written `statusFilter.includes('running')` or relied on
the convention "treat string as a one-element list".

## Validation

Same allow-list as R21: `starting | running | stopped | failed`.

- `status: 'banana'` → ok=false, error: `tag-stats invalid status: banana`
- `status: ['running', 'banana']` → ok=false, error: `tag-stats invalid status in list: ["running","banana"]`
- `status: [42, 'running']` (mixed types) → ok=false, error: `tag-stats invalid status: 42` (the evey check fails first)

The string-only array check uses `Array.isArray(statusFilter) && statusFilter.every((s) => typeof s === 'string')`.
Mixed-type arrays fail the type check and surface the original
error string.

## Verified behavior

Default behavior (no filter) is unchanged from R20. The
`statusFilter` field in the response is the same array the caller
sent — the daemon doesn't normalize or sort. If a caller passes
`['failed', 'running']`, the response says `['failed', 'running']`.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+3 R22 tests, 1 R21 fix):

1. **R22: tag-stats with string[] status filters union of statuses**
   — 3 workers (cli-1 starting, cli-2 running, web-1 failed).
   Filter `['starting', 'running']` matches 2 cli workers, web is
   excluded. Verifies response shape and post-filter counts.
2. **R22: tag-stats with string[] containing invalid status returns
   ok=false** — exercises the allow-list check.
3. **R22: tag-stats with mixed-type array (string + number) returns
   ok=false** — exercises the type guard.

Plus an R21 test fix to match the new `statusFilter: string[]`
response shape.

Plus all 4814 existing tests still pass.

## Verification recipe

```bash
# Confirm multi-status parsing
grep -n "Array.isArray(statusFilter)" src/core/daemon.ts

# Run daemon slash-command suite (R13–R22)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R23+)

- **Exclude-status filter**: `payload: { exclude: ['failed'] }`
  for "all workers NOT failed". Symmetric to the include filter.
- **Status range**: `payload: { statusGte: 'running' }` for
  ordinal-style filtering (running > stopping > starting).
  Requires a status ordering definition.
- **Bulk filter**: `payload: { tag: 'cli', status: ['running'] }`
  for combined tag + status filter. Pre-aggregates a single
  query instead of two.
