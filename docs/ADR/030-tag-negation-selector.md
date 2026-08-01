# ADR-030: tag negation selector (R27)

## Context

R18 (ADR-021) added `tag:foo` for positive selection. R19 (ADR-022)
extended to comma-separated positives. R27 adds the negation
form `tag:!foo` and the combined form `tag:cli,!web`.

The use case is "restart everything that isn't tagged `web`":

```sql
client.send({ action: 'restart-worker', payload: { workerId: 'tag:!web' } })
// → all workers except those tagged web
```

vs. the alternatives:

- `tag:cli,web,scheduler` (positive list — needs to know every tag)
- `tag:all` + filter (loses the selector vocabulary)

Negation is the natural fit when the exclusion set is small and
the inclusion set is large (or unknown).

## Schema

```ts
// Single negation
client.send({ action: 'restart-worker', payload: { workerId: 'tag:!web' } })
// → all workers with tag !== 'web'

// Multiple negation
client.send({ action: 'restart-worker', payload: { workerId: 'tag:!web,!scheduler' } })
// → workers not tagged 'web' AND not tagged 'scheduler'

// Combined positive + negative
client.send({ action: 'restart-worker', payload: { workerId: 'tag:cli,!web' } })
// → workers tagged 'cli' AND not tagged 'web'
```

## Token parsing

```ts
const tokens = rawTags.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
const positive: string[] = []
const negative: string[] = []
for (const t of tokens) {
  if (t.startsWith('!')) {
    const tag = t.slice(1)
    if (tag.length === 0) {
      return { ok: false, error: 'tag:! requires a non-empty tag (e.g. tag:!cli)' }
    }
    negative.push(tag)
  } else {
    positive.push(t)
  }
}
```

The `t.startsWith('!')` check is unambiguous because tag names
themselves don't contain `!` (the schema doesn't allow it).

## Selection logic

```ts
const tagged = Array.from(this.workers.values()).filter((w) => {
  if (w.tag === undefined) return false
  if (negative.includes(w.tag)) return false          // exclude wins
  if (positive.length > 0 && !positive.includes(w.tag)) return false
  return passesFilter(w)
})
```

Three checks, applied in order:

1. **Untagged workers are excluded** — `tag:!web` doesn't match
   untagged workers (they don't have a tag to exclude).
2. **Negation wins** — if a worker is tagged `web`, it's excluded
   regardless of positives.
3. **Positive selection** — if positives are specified, the
   worker must match one of them. If no positives, any tag
   passes (besides the negatives).

## Failure mode

"zero matches" returns `ok: false` with a descriptive error:

- `tag:web` (no match) → `No workers found with tags ["web"]`
- `tag:!web` (no match) → `No workers found with excluding ["web"]`
- `tag:cli,!web` (no match) → `No workers found with tags ["cli"] excluding ["web"]`

Each variant tells the user exactly what they searched for.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+3 R27 tests):

1. **R27: tag:!foo restarts workers NOT tagged foo** — 3 workers
   (cli, web, scheduler). Filter `tag:!web` returns cli + scheduler.
2. **R27: tag:cli,!web combines positive and negative selection** —
   3 workers (2 cli, 1 web). Filter `tag:cli,!web` returns both
   cli workers (web not in positives, but excluded by negation).
3. **R27: tag:!foo,!bar excludes multiple** — 3 workers. Filter
   `tag:!web,!scheduler` returns only cli.

Plus all 4827 existing tests still pass.

## Verification recipe

```bash
# Confirm negation parsing
grep -n "t.startsWith('!')" src/core/daemon.ts

# Run daemon slash-command suite (R13–R27)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R28+)

- **Tag aliases**: `tag:cli → ["cli", "cli-handler"]` — alias
  expansion before the negative filter.
- **Status range filter**: ordinal-style filtering (R26 follow-up).
- **Tag inheritance**: workers spawned by another worker
  inherit the parent's tag.
