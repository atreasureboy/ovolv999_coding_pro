# ADR-036: multi-level parent traversal + cycle detection (R33)

## Context

R32 (ADR-035) added `parentId` for single-level inheritance: a
child worker inherits its parent's labels. R33 extends this to
the full ancestor chain with cycle detection.

The use case is "deep hierarchy" — a daemon tiers workers along
multiple levels:

```
gp (grandparent, tag='platform')
├── parent (tag='cli', parentId=gp.id)
│   └── child (tag='subcli', parentId=parent.id)
```

The child should match `tag:platform` (from grandparent), `tag:cli`
(from parent), and `tag:subcli` (its own). Without multi-level
traversal, the operator would have to either:

- Tag the child with all three labels (manual)
- Or list all three in the selector

Multi-level traversal lets the inheritance chain express the
hierarchy naturally.

## Implementation

```ts
private collectLabels(w: WorkerEntry | undefined, visited?: Set<string>): string[] {
  if (!w) return []
  const seen = visited ?? new Set<string>()
  if (seen.has(w.id)) return []  // cycle break
  seen.add(w.id)
  const parts: string[] = []
  if (w.tag !== undefined) parts.push(w.tag)
  if (w.tags) parts.push(...w.tags)
  if (w.aliases) parts.push(...w.aliases)
  if (w.parentId !== undefined) {
    const parent = this.workers.get(w.parentId)
    parts.push(...this.collectLabels(parent, seen))
  }
  return parts
}
```

The recursion terminates at the first cycle (a worker is its own
ancestor). The `visited` set is threaded through recursion so
sibling calls don't share state.

## Cycle detection

A 2-cycle (`A → B → A`) terminates because:

1. Worker A's `collectLabels` enters `seen = {A}`
2. It examines A's child B, recurses
3. Worker B's `collectLabels` extends `seen = {A, B}`
4. B examines its parent A, sees `seen.has(A)` → returns empty
5. B's walk ends, returns to A's walk
6. A's walk ends

Without cycle detection, `collectLabels` would recurse forever
(JS stack overflow). The `seen` set is O(depth) memory, which is
bounded by the worker count.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+2 R33 tests):

1. **R33: multi-level parent inheritance walks the chain** — 3-level
   chain (gp → parent → child). Filter `tag:gp` matches all 3.
2. **R33: parent cycle terminates without infinite recursion** —
   2-cycle (A → B → A). Filter `tag:a` returns both without
   stack overflow.

Plus all 4839 existing tests still pass.

## Verification recipe

```bash
# Confirm multi-level traversal
grep -n "collectLabels" src/core/daemon.ts

# Run daemon slash-command suite (R13–R33)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Why caller's responsibility for cycle creation

The daemon doesn't prevent the caller from creating parent cycles
in `addWorker`. A caller can:

1. Create A
2. Create B with parentId=A.id
3. Mutate A.parentId=B.id

The cycle here is `A → B → A`. The daemon's `collectLabels`
handles this gracefully (test 2). But the data model allows it
intentionally — sometimes a hierarchy is messy, and the daemon
shouldn't crash.

If a stricter invariant is needed (e.g. "no cycles in worker
graph"), a future round could add a `validate()` method that
runs before `addWorker` returns.

## Future work (R34+)

- **Failure-recovery policy**: if a worker fails to restart N
  times, mark it as `failed` and emit a `worker.give_up` event.
- **Restart audit log unification**: emit restart events to
  the engine's EventLog too (currently only the daemon's log).
- **Cumulative uptime**: track restart history per worker.
- **Cycle detection at addWorker time**: validate the parent
  graph when constructing cycles, fail fast with a clear error.
