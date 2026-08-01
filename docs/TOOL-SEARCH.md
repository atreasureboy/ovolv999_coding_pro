# Tool Search & Deferred Tool Loading

ovolv999 supports **deferred tool loading**: tools marked as deferred are hidden from the LLM's system prompt by default. The model discovers them on demand through the `search_extra_tools` tool, which uses TF-IDF keyword ranking.

This saves context-window tokens in long sessions where most tools are unused.

## How it works

1. At boot, all tools in `createTools()` are registered in the `ToolRegistry`.
2. `ToolPolicy.getExposedDefinitions()` reads the registry, applies plan/task/profile filters, and **also filters out deferred tools** that haven't been discovered yet.
3. `search_extra_tools` is always exposed so the model can discover other tools.
4. When the model calls `search_extra_tools` and finds tools it wants, those tools are marked as **discovered** and their schemas become visible on the next LLM request.
5. Discovery is sticky for the rest of the session.

## Marking a tool as deferred

Add `metadata.shouldDefer: true` and a `metadata.searchHint` to your tool's `ToolMetadata`:

```ts
import { tool } from '../core/types.js'

const myTool: Tool = {
  name: 'MyTool',
  metadata: {
    readOnly: true,
    shouldDefer: true,        // ← hides schema by default
    searchHint: 'my custom tool one liner three to ten words no period',
  },
  definition: {
    type: 'function',
    function: {
      name: 'MyTool',
      description: 'Detailed description for when the tool IS visible.',
      parameters: { /* ... */ },
    },
  },
  execute: async (input, ctx) => { /* ... */ },
}
```

Conventions:

- **searchHint**: 3–10 words, lowercase, no trailing period, prefer terms not already in the tool name. Example: `NotebookEditTool`'s hint is `"edit Jupyter notebook cells (.ipynb)"` — "Jupyter" isn't in the name.
- **shouldDefer**: only set true for tools that the model rarely needs. Tools the model reaches for in most turns (Read, Edit, Bash, Agent, etc.) should stay always-loaded.
- **alwaysLoad**: if a specific tool must always be visible regardless of shouldDefer (e.g. a critical safety tool), set `alwaysLoad: true`.

## Three query forms

`search_extra_tools` accepts three query forms in its `query` parameter:

| Form | Behaviour | When to use |
|---|---|---|
| `select:ToolName` | Exact name lookup | You already saw the tool name in an `available-deferred-tools` hint. |
| `discover:keyword` | TF-IDF search; returns matches **without** marking them discovered | Just want to understand what a tool does before committing. |
| `keyword keyword2` (no prefix) | TF-IDF search; **marks** matches as discovered | Ready to use a tool. |

Examples:

```
search_extra_tools(query="select:NotebookEditTool")
search_extra_tools(query="discover:notebook cells")
search_extra_tools(query="schedule cron job")
search_extra_tools(query="worktree list")
```

The model's response includes a formatted text block (name + score + description + hint + parameter schema) followed by a JSON envelope with the same data for any caller that prefers structured access.

## Performance characteristics

- Index build is **O(N × M)** where N is the number of deferred tools and M is average description length. For the default toolset this is <5ms.
- The index is **cached** in `ToolRegistry`'s key-based cache and only rebuilt when the deferred-tool roster changes.
- TF-IDF scoring on a search is **O(N × K)** where K is the query token count (typically < 5). <1ms for our toolset.

## When NOT to defer

- Tools that the model uses in most turns (Read, Edit, Bash, Agent, Glob, Grep, TodoWrite, WebFetch, WebSearch). These should stay always-loaded.
- Tools that are part of an MCP server's core workflow (the MCP server author decides).
- Tools that are part of an `AgentPreset` (e.g. `code-reviewer`'s tools). Sub-agent tools should always be visible because the parent explicitly requested them.

## Migrating an existing tool

If you have a tool that's rarely used but currently always-loaded:

1. Add `metadata.searchHint` with a 3–10 word phrase.
2. Add `metadata.shouldDefer: true`.
3. Test: the tool should still appear in `search_extra_tools` results for related queries, and its schema should become visible after the model calls `search_extra_tools` and uses it.

## Configuration

There is no user-facing toggle. Defer is controlled per-tool by the tool's metadata, and the system is enabled by default. Tools that don't set `shouldDefer` are unaffected.
