# ADR-022: restart-worker multi-tag selector (R19)

## Context

R18 (ADR-021) added `tag:foo` exact-match selector. R19 extends
this to `tag:foo,bar` comma-separated union semantics. The
caller can list multiple tags in one selector and restart every
worker tagged with any of them.

This is the natural extension of R18 — instead of "restart workers
tagged `cli`" or "restart workers tagged `web`", the user can say
"restart everything in the request-path tier" and the daemon
matches the union.

## Schema

`tag:foo,bar` is parsed in `handleCommand`:

```ts
const rawTags = workerId.slice(4)            // 'foo,bar'
const tags = rawTags.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
const tagged = Array.from(this.workers.values()).filter((w) => w.tag !== undefined && tags.includes(w.tag))
```

Three design choices:

1. **Whitespace tolerance**: `' cli , web '` becomes `['cli', 'web']`.
   Friendly for human-typed selectors.
2. **Empty-after-split**: `tag:,` (only commas) returns
   `ok: false` with "at least one non-empty tag after split".
3. **No match**: `tag:web,scheduler` when no workers match → ok=false
   with `"No workers found with tags [\"web\",\"scheduler\"]"`.
   The error includes the full selector list so the caller can
   diagnose which specific tag was the missing one.

## Why union, not intersection

`tag:cli,web` could mean "both cli AND web" (intersection) or
"either cli OR web" (union). The natural reading is union: a
worker has one tag, so each worker matches at most one tag in
the list. Intersection would always return empty unless a worker
is dual-tagged (which our schema doesn't support).

The schema paths are:
- `tag:cli,web` → union of all workers with tag `cli` OR tag `web`
- `tag:cli` → workers with tag `cli` (R18 unchanged)
- `tag:all` → all workers (special, ignored comma parsing)

## Tests

`tests/r13-daemon-slash-command.test.ts` (+3 R19 tests):

1. **R19: multi-tag selector tag:cli,web restarts union of both** —
   4 workers (2 cli, 1 web, 1 scheduler), selector `tag:cli,web`
   restarts 3 (cli + web), scheduler untouched.
2. **R19: multi-tag selector with whitespace tolerance
   (tag: cli , web )** — exercises the trim() pass.
3. **R19: multi-tag selector with no match returns ok=false** —
   exercises the "no workers match" path.

Plus an R18 fallback test updated to match the new error format
("No workers found with tags" instead of "tag 'cli'").

Plus all 4807 existing tests still pass.

## Verification recipe

```bash
# Confirm multi-tag parsing
grep -n "tags.includes" src/core/daemon.ts

# Run daemon slash-command suite (R13–R19)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R20+)

- **N-tag selector with explicit AND**: `tag:cli+web` would only
  match workers with both tags. Requires multi-tag schema on
  workers (changes to `tag?: string[]`).
- **Tag negation**: `tag:!web` excludes workers with tag `web`.
  Useful for "all but web" workflows.
- **Tag aliases**: a CLI definition file that maps `cli → ["cli-handler", "cli-watcher"]`.
  Currently the user has to know each tag verbatim.
