# ADR-028: tag-stats exclude-status filter (R25)

## Context

R21 (ADR-024) and R22 (ADR-025) added `payload.status` for **include**
filtering. R25 adds the symmetric **exclude** filter: list
statuses the caller does NOT want to see.

The use case is "show me everything that's NOT running":

```sql
client.send({ action: 'tag-stats', payload: { exclude: ['running'] } })
// → all workers except those that are running
```

vs. the include-only version which would have required listing
all four statuses except one:

```sql
client.send({ action: 'tag-stats', payload: { status: ['starting', 'stopped', 'failed'] } })
// → same result, but list grows with new statuses
```

The exclude form is more maintainable when the status union
grows. Today there are 4 statuses; if a 5th is added, the include
form needs updating, the exclude form doesn't.

## Schema

```ts
// Exclude single
client.send({ action: 'tag-stats', payload: { exclude: 'failed' } })
// → excludeFilter: ['failed']

// Exclude multiple
client.send({ action: 'tag-stats', payload: { exclude: ['running', 'stopped'] } })
// → excludeFilter: ['running', 'stopped']

// Both include + exclude (intersection)
client.send({ action: 'tag-stats', payload: { status: 'starting', exclude: 'running' } })
// → statusFilter: ['starting'], excludeFilter: ['running']
// → only workers with status='starting' AND not in exclude (= same as include alone)
```

The include + exclude intersection is correct because the include
filter is already an exact match. The combination is meaningful
when the include filter is a subset of the wider set:

```sql
// Want: workers with status='starting' OR 'running', but NOT tagged 'web'
// This currently requires two queries. R25 doesn't address this
// yet; future R26 status-range filter would.
```

For now, the exclude filter is a single linear filter applied
after the include filter. The combination is associative; the
order doesn't matter.

## Validation

Same whitelist as R21/R22: `starting | running | stopped | failed`.
Same shape acceptance: string or string[] of strings.
Same error messages: `invalid exclude` / `invalid exclude in list`.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+2 R25 tests):

1. **R25: tag-stats with exclude-status filters out specific
   statuses** — 3 cli workers (running, failed, starting).
   Filter `exclude: ['running', 'failed']` returns only the
   starting worker.
2. **R25: tag-stats with invalid exclude status returns ok=false** —
   exercises the whitelist check.

Plus all 4822 existing tests still pass.

## Verification recipe

```bash
# Confirm exclude filter
grep -n "excludeFilter" src/core/daemon.ts

# Run daemon slash-command suite (R13–R25)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R26+)

- **Exclude-status on restart-worker**: R25 wired exclude to
  tag-stats. The same parsing could be added to restart-worker
  bulk paths (R24). Trivial duplication, defer until asked.
- **Status range filter**: `payload: { statusGte: 'running' }`
  for ordinal-style filtering (running > stopping > starting).
  Requires a status ordering definition.
- **Negation in tag selector**: `tag:!foo` — exclude workers
  tagged `foo`. Symmetric to R25's exclude filter.
