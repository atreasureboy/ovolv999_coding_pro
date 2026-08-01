# ADR-032: WorkerEntry aliases (R29)

## Context

R28 added WorkerEntry.tags for AND selection. R29 adds
WorkerEntry.aliases for **legacy name compatibility** — a
worker can be tagged `cli` but also answer to `cli-handler`
(the old name from when the system was renamed).

Real-world use case: a system renames its CLI tier from `cli`
to `cli-handler`. Existing automation still uses `tag:cli`.
The new canonical name is `cli-handler`. With aliases, the
operator adds `aliases: ['cli']` to the worker, and the legacy
selector still works without renaming the underlying tag.

## Schema

```ts
interface WorkerEntry {
  tag?: string
  tags?: string[]
  aliases?: string[]  // R29: virtual labels for selector matching
}
```

The selector matching now includes aliases:

```ts
const labels = w.tag !== undefined
  ? [w.tag, ...(w.tags ?? []), ...(w.aliases ?? [])]
  : [...(w.tags ?? []), ...(w.aliases ?? [])]
```

A worker with `tag: 'cli', aliases: ['cli-handler']` matches
both `tag:cli` and `tag:cli-handler`.

## Combine with R28/R27/R26

Aliases participate in the same selector pipeline:

- `tag:cli-handler` → matches the aliased worker
- `tag:cli,!cli-handler` → matches cli workers (excluding the alias)
- `tag:cli-handler+web` → matches only aliased workers also tagged web

The aliases are "virtual tags" — they satisfy the selector but
don't appear in tag-stats results. The output of `tag-stats`
shows primary tags + tags, not aliases.

## Why aliases, not just renames

The naive alternative is "rename the worker" — but that loses
information. With aliases:

- The canonical tag is preserved (e.g. `cli`)
- Legacy operators can still use the old name
- A future migration can drop aliases one at a time
- tag-stats shows the canonical name, not the alias

This is the same pattern as DNS aliases — the canonical name
plus CNAME entries.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+2 R29 tests):

1. **R29: tag selector matches worker aliases** — 2 workers
   (cli with alias, cli without). Filter `tag:cli-handler` returns
   only the aliased worker.
2. **R29: alias works with AND and negation** — 2 workers
   (cli+web with alias, cli+web without). Filter
   `tag:cli-handler+web` returns only the aliased worker.

Plus all 4831 existing tests still pass.

## Verification recipe

```bash
# Confirm alias in labels
grep -n "aliases ?? []" src/core/daemon.ts

# Run daemon slash-command suite (R13–R29)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R30+)

- **Status range filter**: ordinal-style filtering (R26 follow-up).
- **Tag inheritance**: workers spawned by another worker
  inherit the parent's tags.
- **Daemon-aware `/workers`**: combine tmux workers with daemon
  workers in a unified view.
