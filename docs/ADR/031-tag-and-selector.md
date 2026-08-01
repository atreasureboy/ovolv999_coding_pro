# ADR-031: tag AND selector (R28)

## Context

R18 (ADR-021) added `tag:foo` for positive selection. R19 (ADR-022)
extended to comma-separated positives (OR). R27 (ADR-030) added
negation (`tag:!foo`). R28 closes the last selector operator with
AND: `tag:cli+web` matches workers carrying BOTH tags.

The use case is "restart workers that serve both CLI and web":

```sql
client.send({ action: 'restart-worker', payload: { workerId: 'tag:cli+web' } })
// → only workers tagged with both 'cli' AND 'web'
```

To support AND, the worker schema gets a `tags?: string[]` field
alongside the existing `tag?: string`. Each worker has:

- `tag?: string` — primary tag (existing)
- `tags?: string[]` — additional labels (NEW)

A worker with `tag: 'cli', tags: ['web']` is the same as a worker
tagged both `cli` and `web` for selector purposes.

## Schema

```ts
// Add a worker with multiple tags
daemon.addWorker('cli-web-1', 'echo', 'cli', ['web'])

// Selector — AND
client.send({ action: 'restart-worker', payload: { workerId: 'tag:cli+web' } })
// → only cli-web-1

// Single tag still works (R18)
client.send({ action: 'restart-worker', payload: { workerId: 'tag:cli' } })
// → cli + cli-web-1 (both have the cli label)

// Combine with R27 negation
client.send({ action: 'restart-worker', payload: { workerId: 'tag:cli+web,!staging' } })
// → workers with cli AND web, excluding staging
```

## Selection logic

```ts
const labels = w.tag !== undefined ? [w.tag, ...(w.tags ?? [])] : (w.tags ?? [])
if (labels.length === 0) return false
if (negative.some((n) => labels.includes(n))) return false
if (positive.length > 0 && !positive.some((p) => labels.includes(p))) return false
for (const andGroup of ands) {
  if (!andGroup.every((t) => labels.includes(t))) return false
}
return passesFilter(w)
```

The `labels` array flattens `tag` + `tags` into a single
matching surface. The four checks:

1. **Untagged workers are excluded** — `tag:cli+web` doesn't
   match untagged workers.
2. **Negation wins** — `!staging` excludes regardless of other
   labels.
3. **Positive OR** — without `+`, the comma list is OR (R19).
4. **AND groups** — each `+` group must fully match.

## Why `tag:cli+web` is AND, not OR

The `+` symbol is overloaded in selector languages. We chose
AND because:

- `,` already means OR (R19). Two operators with the same
  semantics would be redundant.
- AND is the harder operation to express (you can OR by listing
  but you can't AND without an explicit operator).
- `cli+web` reads naturally as "CLI AND web" — both required.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+2 R28 tests):

1. **R28: tag:cli+web requires both tags (AND)** — 3 workers
   (cli+web, cli only, web only). Filter `tag:cli+web` returns
   only the multi-tagged worker.
2. **R28: tag:cli+web with no matches returns ok=false** —
   exercises the empty-result path.

Plus all 4829 existing tests still pass.

## Verification recipe

```bash
# Confirm AND parsing
grep -n "t.includes('+')" src/core/daemon.ts

# Run daemon slash-command suite (R13–R28)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R29+)

- **Tag aliases**: `tag:cli → ["cli", "cli-handler"]` — alias
  expansion before the AND filter.
- **Status range filter**: ordinal-style filtering.
- **Tag inheritance**: workers spawned by another worker
  inherit the parent's tags.
