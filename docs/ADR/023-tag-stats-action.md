# ADR-023: tag-stats action (R20)

## Context

R18 (ADR-021) and R19 (ADR-022) added tag-based selectors for
`restart-worker`. With tags now driving real workflows, users
need to be able to **inspect** the tag distribution without
iterating `list-workers` and counting by hand.

R20 adds a `tag-stats` IPC action that returns aggregate counts
per tag, plus per-status breakdowns. The action is read-only and
side-effect free — same level of safety as `status` / `health`.

## Schema

```ts
{
  ok: true,
  data: {
    totalWorkers: 4,
    untagged: 1,
    tags: [
      { tag: 'cli', total: 2, byStatus: { starting: 2 } },
      { tag: 'web', total: 1, byStatus: { failed: 1 } },
    ],
  },
}
```

Three fields:

- `totalWorkers`: sum of all workers (tagged + untagged)
- `untagged`: count of workers without a tag
- `tags`: array sorted alphabetically by tag, each entry has
  `total` and `byStatus` (a `Record<status, count>`)

The `byStatus` breakdown uses the same status union as
`WorkerEntry`: `starting | running | stopped | failed`. Tests
in this round exercised `starting` (default) and `failed`
explicitly.

## Why include `untagged`

Workers without a tag are still workers. The caller wants to
know how many "stragglers" exist — workers added before the tag
system, or workers that intentionally opt out. A `total: 4,
untagged: 1, tags: [2+1=3]` arithmetic is closed.

## Why alphabetical sort

Iteration order over `Map` is insertion order in V8, which would
be fine for a single daemon — but it makes the response harder
to diff across runs (different insertion order = different
serialization). Alphabetical sort produces a stable, comparable
output, which is useful for both human callers and `/trace`
scripts.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+2 R20 tests):

1. **R20: tag-stats aggregates per-tag counts and statuses** —
   4 workers (2 cli, 1 web, 1 untagged), one of the web workers
   manually marked 'failed'. Verifies tag.total, byStatus per
   status, and the untagged counter.
2. **R20: tag-stats on empty daemon returns zero counts** —
   boundary case.

Plus all 4809 existing tests still pass.

## Verification recipe

```bash
# Confirm tag-stats action
grep -n "tag-stats" src/core/daemon.ts

# Confirm response shape
grep -n "case 'tag-stats'" src/core/daemon.ts

# Run daemon slash-command suite (R13–R20)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R21+)

- **`tag-stats` per status filter**: `client.send({ action:
  'tag-stats', payload: { status: 'failed' } })` to focus on
  failed workers per tag.
- **Per-tag uptime**: average ms since startedAt, broken down per
  tag. Requires tracking restart timestamps.
- **Tag-stats counter in the IPC socket**: increment a counter
  every time `tag-stats` is called so the user can see how often
  the daemon is being polled.
