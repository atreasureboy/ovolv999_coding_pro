# ADR-008: TF-IDF Tool Search + Deferred Tool Loading

## Context

As ovolv999 grows (currently 34 base tools), exposing every tool's full JSON schema in every system prompt is wasteful. Long sessions with many tools blow out the tool-schema slice of the context window — sometimes by tens of thousands of tokens per turn — and the LLM has to parse schemas it never uses.

Claude Code solves this with a **deferred tool + TF-IDF search** pattern: only core tools (Bash, Read, Edit, etc.) are loaded by default; everything else is hidden until the model discovers it via `search_extra_tools`. Search uses TF-IDF with weighted fields, scored by cosine similarity, and supports three query forms (`select:`, `discover:`, plain keyword).

We want this for ovolv999 too — but constrained by our own design rules:

- 5-dep cap (no `@anthropic-ai/sdk` style additions for tokenizers)
- No new concurrent abstractions
- Existing `load_skill` already does lazy loading; we want to **extend** rather than duplicate

## Options

1. **Import a TF-IDF library** (`natural`, `wink-nlp`, etc.) — fastest to ship, but breaks the 5-dep cap and adds 200KB+ for a 200-line algorithm.

2. **Reimplement TF-IDF from scratch in pure TypeScript** (chosen) — ~200 LOC, zero deps, full control over field weighting and stop words. The algorithm is well-understood and our existing `src/core/strings.ts` already has tokenization primitives we can lean on.

3. **Use embeddings via the configured LLM** — overkill: requires a round-trip to the model on every query, and at TF-IDF quality for keyword-style queries we don't need semantic search yet.

## Choice

Option 2, in three layers:

### Layer 1: `src/core/localSearch.ts` — pure algorithm

Exposes four composable primitives:

- `tokenize(text)` — lowercases, splits ASCII runs on `[a-z0-9\-_]`, emits CJK bigrams (`测试代码 → [测试, 试代, 代码]`), drops stop words.
- `tokenizeAndStem(text)` — adds a small Porter-like suffix stripper (`-ing` / `-tion` / `-ness` / etc.). CJK tokens are not stemmed.
- `computeWeightedTf(fields)` — augmented-max-normalized TF (`count / max`), with **max-merge across fields** (not sum, so name+description overlap doesn't double-count).
- `computeIdf(index)` — classic `Math.log(N / df)`, no smoothing. Caller multiplies `tf * idf` directly; missing-idf becomes 0.
- `cosineSimilarity(a, b)` — sparse dot product + sqrt-sum-of-squares. Returns 0 for empty vectors.

**Field weights** (fixed, from claude-code):

```ts
TOOL_FIELD_WEIGHT = { name: 3.0, searchHint: 2.5, description: 1.0 }
SKILL_FIELD_WEIGHT = { name: 3.0, whenToUse: 2.0, description: 1.0, allowedTools: 0.3 }
```

CJK bigrams get a structural advantage: a 4-character CJK query produces 3 bigrams, enough to score against the CJK bigrams in a tool name like `翻译` after bigram expansion. The `CJK_MIN_BIGRAM_MATCHES = 2` filter rejects 1-bigram noise matches unless there's also an ASCII match.

### Layer 2: `src/core/toolSearch.ts` — tool indexing

Mirrors claude-code's `src/services/searchExtraTools/toolIndex.ts`:

- `buildToolIndex(tools)` — only indexes tools where `metadata.shouldDefer === true`. (Default behaviour: tools are visible. This is a **backward-compatible** explicit opt-in — existing 34 tools keep working unchanged.)
- `getToolIndex(tools)` — lazy build + cached, with key-based invalidation (sorted tool name list).
- `searchTools(query, index, limit)` — TF-IDF + cosine, with name-substring boost (≥ 4 chars, score clamped to 0.75 minimum).
- `isDeferredTool(tool)` — `metadata.shouldDefer === true && metadata.alwaysLoad !== true && !isCoreTool(name)`.

The **CORE_TOOLS** list contains all tools in `createTools()` plus `search_extra_tools` itself. Tools on this list are never deferred.

### Layer 3: `src/tools/searchExtraTools.ts` — LLM-callable tool

Exposes a single tool, `search_extra_tools`, that the model calls when it needs to discover a deferred tool. Three query forms:

| Query | Behaviour |
|---|---|
| `select:ToolName` | Exact-name lookup. Returns immediately if found, empty if not. |
| `discover:keyword` | TF-IDF search; returns matches **without** marking them as discovered. |
| `keyword keyword2` | TF-IDF search; marks all matches as discovered (schema becomes visible). |

Matches are returned as a formatted text block (name + score + description + hint + parameter schema) so the model can read the result without parsing JSON. The structured outcome is also embedded as JSON after a `---` separator for any caller that wants it.

### Wiring

- `ToolMetadata` gains three new optional fields: `searchHint`, `shouldDefer`, `alwaysLoad`.
- `ToolRegistry` gains `markDiscovered(name)` + `getDiscovered()` (a `ReadonlySet<string>`). Discovery set survives across `reset()` calls — once a tool is discovered in a session, it stays discovered.
- `ToolPolicy.getExposedDefinitions()` accepts an optional `discovered` set. Tools that are `isDeferredTool(tool)` are filtered out unless they're in the discovered set. `search_extra_tools` is always exposed (so the model can keep discovering).
- `ToolContext` gains `getRegisteredTools()` (for the indexer) and `markToolDiscovered(name)` (callback to the registry). `boot.ts` wires both.

### Skill search upgrade

`src/core/skillSearch.ts` was reimplemented on top of TF-IDF but keeps its public API (`searchSkills`, `getRecommendedSkills`, `getSimilarSkills`, `formatSearchResults`). The internal `matchedFields` array still emits `name:exact` / `name:partial` for back-compat with `tests/skillSearch.test.ts`.

## Rejected

- **Default-on defer** (defer everything except core): too aggressive a behaviour change for a 0.5.0 patch. Existing tools + their tests expect to be visible. We keep the opt-in flag and let tool authors migrate at their own pace.
- **Async/streaming prefetch** (precompute the index on a worker thread): overkill for 34 tools. Sync build takes <5ms; lazy cache invalidates only on tool-roster change.
- **Embedding-based semantic search** (e.g. via OpenAI `text-embedding-3-small`): adds a network round-trip per query, requires caching of embeddings across restarts, and provides diminishing returns for keyword-style discovery. Revisit when we have a real "tool I'm thinking of but don't know the name" use case.

## Consequences

+ Long sessions can defer rarely-used tools (e.g. `Diagnostics`, `Sleep`, `Goal`, `MCP` tools) and save thousands of tokens per turn on schema alone.
+ `search_extra_tools` is the single entry point — the model doesn't have to know which tools are deferred; it just calls `search_extra_tools` when its current toolset doesn't fit.
+ Discovery is sticky per session — once a tool is found, its schema stays visible, so the model doesn't re-search on every turn.
+ Backward compatible: tools without `shouldDefer` work exactly as before.
- Tool authors who want to take advantage need to add `metadata.searchHint` (3–10 words, no trailing period) and `metadata.shouldDefer = true`. This is a documentation task, not enforced.
- The CORE_TOOLS list needs to be kept in sync with `createTools()` in `src/tools/index.ts`. We treat it as the source of truth and add new base tools there as they're introduced.

## Files

- `src/core/localSearch.ts` — pure TF-IDF primitives
- `src/core/toolSearch.ts` — tool indexing + search
- `src/tools/searchExtraTools.ts` — LLM tool
- `src/core/types.ts` — extended `ToolMetadata`, extended `ToolContext`
- `src/core/toolRuntime/toolRegistry.ts` — discovery set
- `src/core/toolRuntime/toolPolicy.ts` — defer filter
- `src/core/runtime/boot.ts` — wires the new context callbacks
- `src/tools/index.ts` — registers `search_extra_tools`
- `src/core/skillSearch.ts` — reimplemented on TF-IDF
- `tests/core/localSearch.test.ts`, `tests/core/toolSearch.test.ts`, `tests/tools/searchExtraTools.test.ts`, `tests/core/skillSearch.test.ts` — 75 new tests
