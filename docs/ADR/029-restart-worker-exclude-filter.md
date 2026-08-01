# ADR-029: restart-worker exclude-status filter (R26)

## Context

R25 (ADR-028) added `payload.exclude` to `tag-stats`. R26 brings
the same filter to `restart-worker` bulk paths so the two
read/write endpoints share the same filter vocabulary.

The use case is "restart every CLI worker that's not currently
running":

```sql
client.send({
  action: 'restart-worker',
  payload: { workerId: 'all', tag: 'cli', exclude: ['running'] }
})
// → restart only cli workers in starting/stopped/failed
```

vs. the include-only version which would have needed a 3-status
allowlist:

```sql
client.send({
  action: 'restart-worker',
  payload: { workerId: 'all', tag: 'cli', status: ['starting', 'stopped', 'failed'] }
})
// → same result, but list grows with new statuses
```

The exclude form is more maintainable when the status union
grows.

## Schema

```ts
{
  action: 'restart-worker',
  payload: {
    workerId: 'all' | 'tag:foo' | '<id>',
    tag?: string,
    status?: string | string[],   // R24 include
    exclude?: string | string[],  // R26 exclude
    concurrency?: number,
  }
}
```

Validation mirrors R25:

- `status` / `exclude` accept string or string[] of strings
- Both validated against the same allowlist
- Invalid values return `ok: false` with descriptive errors

## Filter intersection

The `passesFilter` closure (R24) accumulates three checks:

```ts
const passesFilter = (w: WorkerEntry): boolean => {
  if (tagFilter !== undefined && w.tag !== tagFilter) return false
  if (allowedStatuses !== null && !allowedStatuses.includes(w.status)) return false
  if (excludedStatuses !== null && excludedStatuses.includes(w.status)) return false
  return true
}
```

The order doesn't matter for the result. With `status: ['starting']`
and `exclude: ['running']`, the include filter is reduced to
`status === 'starting'`, and the exclude is no-op (no worker has
both `starting` and `running`). With conflicting filters
(`status: ['running']` + `exclude: ['running']`), the result is
empty because no worker can satisfy both.

## Response shape

Response payloads for the bulk paths now include `excludeFilter`:

```ts
{
  ok: true,
  data: {
    workerId: 'all',
    requested: 1,
    excludeFilter: ['running', 'failed'],
    ...
  }
}
```

Mirrors R25's tag-stats `excludeFilter` field for consistency.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+2 R26 tests):

1. **R26: restart-worker with exclude-status filters out specific
   statuses** — 3 cli workers (starting, running, failed). Filter
   `tag: 'cli', exclude: ['running', 'failed']` returns only the
   starting worker.
2. **R26: restart-worker with invalid exclude status returns
   ok=false** — exercises the whitelist check.

Plus all 4824 existing tests still pass.

## Verification recipe

```bash
# Confirm exclude filter
grep -n "excludedStatuses" src/core/daemon.ts

# Run daemon slash-command suite (R13–R26)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R27+)

- **Status range filter**: `payload: { statusGte: 'running' }`
  for ordinal-style filtering.
- **Tag negation**: `tag:!foo` — exclude workers tagged `foo`.
- **Tag inheritance**: workers spawned by another worker
  inherit the parent's tag.
