# ADR-027: restart-worker bulk filter (R24)

## Context

R20-R23 progressively built tag-stats filters. R24 brings the
same filtering to `restart-worker` so the user can ask targeted
restart questions without client-side filtering.

The driving use case: "restart every CLI worker that's currently
failed". With R24, this is one IPC call:

```sql
client.send({
  action: 'restart-worker',
  payload: { workerId: 'tag:cli', status: 'failed' }
})
// → 2 workers restarted, web-tagged failed workers are untouched
```

Before R24, this would have required:
1. `list-workers` to enumerate
2. client-side filtering by tag and status
3. N individual `restart-worker` calls

R24 collapses all three into one round-trip and avoids the
sync-skew between steps 1 and 3 (a worker that started during
the gap might be missed).

## Schema

```ts
{
  action: 'restart-worker',
  payload: {
    workerId: 'all' | 'tag:foo' | '<id>',
    tag?: string,           // R24: filter by tag
    status?: string | string[],  // R24: filter by status (R21/R22 shorthand + array)
    concurrency?: number,   // R17: throttle
  }
}
```

The `tag` and `status` filters apply to bulk paths:

- `workerId: 'all'` + filters → workers matching filters
- `workerId: 'tag:foo'` + filters → workers tagged `foo` AND matching filters
- `workerId: '<id>'` → filters ignored (can't filter a specific worker)

## Why single-id path ignores filters

If you specify `workerId: 'worker-123'` and `tag: 'cli'`, and
`worker-123` doesn't have tag `cli`, should it:
- (a) Restart anyway (filters ignored)
- (b) Return ok=false (filter mismatch)

R24 chooses (a) — the workerId is the authoritative selector. If
you restart 'worker-123', you want worker-123 restarted, period.
Filters on bulk paths are conveniences; the workerId is the
contract.

This matches the principle `workerId || filter` not `workerId && filter`:
workerId is the "do this" selector, filters are "but only if".

## Validation

Same patterns as R21/R22/R23:

- `tag` must be a string when provided (else `invalid tag`)
- `status` must be a string or string[] of valid statuses (else `invalid status`)
- `concurrency` clamps to [1, 16] (R17)

## Tests

`tests/r13-daemon-slash-command.test.ts` (+3 R24 tests):

1. **R24: restart-worker all with payload.tag filters to that tag** —
   3 workers (2 cli, 1 web). Filter `tag: 'cli'` returns only the
   2 cli workers.
2. **R24: restart-worker tag:cli with payload.status=failed filters
   both** — 3 workers with mixed tags and statuses. Filter
   `tag: 'cli'` + `status: 'failed'` returns only the 1 cli worker
   that's failed.
3. **R24: restart-worker invalid tag payload returns ok=false** —
   exercises the type guard on `tag`.

Plus all 4820 existing tests still pass.

## Verification recipe

```bash
# Confirm filter logic
grep -n "passesFilter" src/core/daemon.ts

# Run daemon slash-command suite (R13–R24)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R25+)

- **Restart by tag + exclude-status**: `payload: { tag: 'cli',
  exclude: ['running'] }` — restart everything except running.
- **Status range filter**: `payload: { statusGte: 'running' }`
  for ordinal-style filtering.
- **Restart filter schedule**: `payload: { status: 'failed',
  schedule: 'on_next_idle' }` — defer restart until the worker
  is idle. Requires worker hooks.
