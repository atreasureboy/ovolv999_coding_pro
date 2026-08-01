# ADR-021: restart-worker by tag (R18)

## Context

R14 (ADR-017) added per-worker restart. R16 (ADR-019) added bulk
restart. R17 (ADR-020) added concurrency throttle. The remaining
real-world workflow is **selective restart**: a user has 50
workers organized by logical role (e.g. CLI endpoint, web
endpoint, scheduler, etc.) and wants to restart just one tier
without affecting the others.

R18 introduces a `tag` field on `WorkerEntry` and a `tag:<name>`
selector for `restart-worker`. This is the natural extension of
R16's "all" — instead of "all workers", it's "workers tagged `foo`".

## Schema

`WorkerEntry` gets an optional `tag` field:

```ts
{
  id: 'worker-...',
  name: 'cli-1',
  status: 'running',
  tag: 'cli',  // NEW
  ...
}
```

`addWorker(name, command, tag?)` accepts an optional tag. The
existing test cases (no tag) continue to work because `tag` is
optional.

The selector format `tag:foo` is parsed in the daemon's
`handleCommand`:

```ts
if (workerId.startsWith('tag:')) {
  const tag = workerId.slice(4)
  if (tag.length === 0) return { ok: false, error: 'tag: requires a non-empty tag' }
  const tagged = Array.from(this.workers.values()).filter((w) => w.tag === tag)
  if (tagged.length === 0) return { ok: false, error: `No workers found with tag '${tag}'` }
  // ... bulk restart them
}
```

## Why exact match, not glob

`tag:cli*` would be more flexible, but it introduces complexity
(matching engine, edge cases, escaping) for a feature that doesn't
need it. Today's use case is exact tag labels. If a user wants
multiple tags, they can specify multiple `restart-worker` calls
(or use `tag:cli-all` if they want to group semantically).

Failure paths are explicit:

- `tag:` (empty tag) → ok=false with "non-empty tag"
- `tag:cli` but no workers match → ok=false with "No workers
  found with tag 'cli'"

Both fail fast with clear error messages — the caller can
diagnose which side of the selector is wrong.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+3 R18 tests):

1. **R18: restart-worker tag:foo restarts only workers with that
   tag** — 3 workers with mixed tags (2 cli, 1 web). Verifies
   only the 2 cli workers are restarted, web worker is untouched.
2. **R18: restart-worker tag:foo with no matching workers returns
   ok=false** — exercises the "no match" path.
3. **R18: empty tag selector (tag:) is a clean error** — exercises
   the empty-tag validation.

Plus all 4804 existing tests still pass.

## Verification recipe

```bash
# Confirm tag field
grep -n "tag?:" src/core/daemon.ts

# Confirm tag selector
grep -n "startsWith('tag:')" src/core/daemon.ts

# Run daemon slash-command suite (R13–R18)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R19+)

- **Multi-tag selector**: `tag:cli,web` restarts workers with
  either tag. Useful for combined tiers.
- **Tag inheritance**: workers spawned by another worker
  inherit the parent's tag. Useful for spawned-task tracking.
- **Tag-based metrics**: `client.send({ action: 'tag-stats', payload: { tag: 'cli' } })`
  returns uptime / restart count / failure rate per tag.
