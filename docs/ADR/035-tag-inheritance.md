# ADR-035: WorkerEntry parentId tag inheritance (R32)

## Context

R28 added WorkerEntry.tags for AND selection. R29 added aliases
for legacy name compatibility. R32 adds `parentId` for **tag
inheritance** — a worker can be linked to a parent and inherit
its parent's tags for selector matching.

Real-world use case: a daemon spawns child workers at runtime
to handle specific tasks. The child has its own tag (`subcli`)
but conceptually belongs to the parent's tier (`cli`). Without
inheritance, the operator has to either:

- Tag the child with both `cli` and `subcli` (manual labeling)
- Or list both tags in the selector

With inheritance, the child inherits `cli` from its parent
automatically. The selector `tag:cli` matches both.

## Schema

```ts
interface WorkerEntry {
  tag?: string
  tags?: string[]
  aliases?: string[]
  parentId?: string  // R32: parent inheritance
}
```

The `addWorker` signature grows:

```ts
addWorker(name, command?, tag?, tags?, aliases?, parentId?)
```

## Selection logic

```ts
const parentLabels = w.parentId !== undefined
  ? this.collectLabels(this.workers.get(w.parentId))
  : []
const labels = w.tag !== undefined
  ? [w.tag, ...(w.tags ?? []), ...(w.aliases ?? []), ...parentLabels]
  : [...(w.tags ?? []), ...(w.aliases ?? []), ...parentLabels]
```

The labels array includes the worker's own labels plus the
parent's labels (one level). Cycles are the caller's
responsibility — we don't recurse, so a 2-level cycle
(`A → B → A`) would loop; deeper cycles (`A → B → C → A`)
would stop at C.

## Why not auto-rewrite the child's tags

Storing `parentId` separately preserves the worker's identity
in tag-stats. The child still appears under its own tag
(`subcli` in the example), not the parent's. Only the
*matching* surface includes the inherited labels.

This means:
- `tag-stats` shows the child only under `subcli`
- `tag:cli` selector includes the child (via inheritance)
- The child can be removed by `tag:subcli` without affecting the parent

If we auto-rewrote the child's tags, the `tag:subcli` selector
would silently break. Inheritance is a matching-time concept,
not a data-normalization one.

## Helper

```ts
private collectLabels(w: WorkerEntry | undefined): string[] {
  if (!w) return []
  const parts: string[] = []
  if (w.tag !== undefined) parts.push(w.tag)
  if (w.tags) parts.push(...w.tags)
  if (w.aliases) parts.push(...w.aliases)
  return parts
}
```

Used by both the parent's own label collection and the child's
inheritance lookup. Single source of truth for "what labels does
this worker carry".

## Tests

`tests/r13-daemon-slash-command.test.ts` (+2 R32 tests):

1. **R32: child worker inherits parent tags for selector matching** —
   parent tagged `cli`, child tagged `subcli` with parentId →
   parent.id. Filter `tag:cli` matches both.
2. **R32: child inherits parent alias too** — parent with alias
   `cli-handler` matches `tag:cli-handler` (sanity check that
   aliases flow through).

Plus all 4837 existing tests still pass.

## Verification recipe

```bash
# Confirm parent inheritance
grep -n "parentLabels" src/core/daemon.ts

# Run daemon slash-command suite (R13–R32)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R33+)

- **Failure-recovery policy**: if a worker fails to restart N
  times, mark it as `failed` and emit a `worker.give_up` event.
- **Restart audit log unification**: emit restart events to
  the engine's EventLog too (currently only the daemon's log).
- **Cumulative uptime**: track restart history per worker.
- **Multi-level parent traversal**: walk parent chain to
  collect all ancestor labels, with cycle detection.
