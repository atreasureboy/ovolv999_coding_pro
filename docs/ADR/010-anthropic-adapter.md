# ADR-010: Anthropic native adapter (zero-deps fetch)

## Context

ovolv999 currently routes everything through `OpenAICompatibleAdapter`, even Anthropic API calls. This means we lose access to first-party features that Anthropic's own SDK handles natively:

- thinking blocks (extended thinking)
- prompt caching (`prompt-caching-2024-07-31`)
- cross-provider fallback (`server-side-fallback-2026-06-01`)
- token-budget beta (`task-budgets-2026-03-13`)

Adding `@anthropic-ai/sdk` would solve this, but it violates our root-level "5 依赖" constraint (ADR-006): we ship `curl | sh` and any new runtime dependency is a regression on that promise.

## Options

1. **Adopt `@anthropic-ai/sdk`** — instant access to thinking, caching, betas. Rejected: violates "5 依赖" constraint.
2. **Hand-roll a thin SDK using `fetch` + SSE parsing** (chosen) — keeps the dependency count at 5; we own the protocol layer; can add new betas as needed.
3. **Stay on OpenAI compatibility** — free, but loses all Anthropic-native features forever.

## Choice

### Architecture

`AnthropicAdapter implements ProviderAdapter` translates the request body and the response stream between OpenAI Chat Completions shape (which `StreamConsumer` already understands) and Anthropic Messages API shape:

- **Request translation**: separate `system` field (top-level) from `messages[]`; convert OpenAI `tools[]` (function format with `parameters`) into Anthropic `tools[]` (with `input_schema`); convert `messages[]` history (with `tool_calls`/`tool`/`user`/`assistant` roles) into Anthropic's content-block shape.
- **Stream translation**: parse Anthropic SSE (`message_start`, `content_block_start`, `content_block_delta`, `message_delta`, `message_stop`) and emit OpenAI `ChatCompletionChunk` deltas. State: per-stream tool-call accumulators so `input_json_delta` partial JSON is concatenated into a final `tool_calls[i].function.arguments`.
- **Transport**: built-in `fetch` with `signal` cancellation, `x-api-key` header, `anthropic-version` pinned to `2023-06-01`.

### Beta headers

We support `prompt-caching-2024-07-31` and `extended-thinking-2025-...` when explicitly requested via the `providerOptions` field (added in v0.6.0). The adapter emits the correct `anthropic-beta` header and the request body shape changes accordingly:

```ts
providerOptions: {
  anthropicBeta: ['prompt-caching-2024-07-31', 'extended-thinking-2025-...'],
  cacheControl: { type: 'ephemeral' },  // applied to last system/tool block
  thinkingBudget: 4096,                 // extended thinking
}
```

`thinking` content blocks are passed through as opaque content; the stream translator extracts them but `StreamConsumer` ignores them (they don't affect the model's downstream output).

### Why not use the SDK

The OpenAI SDK is already a runtime dependency. We could similarly add `@anthropic-ai/sdk` (~80KB, no native bindings). The cost:

- One more package to track upstream
- Version-drift risk against the OpenAI SDK
- Installs break in environments without npm (some shell-only installations)

In exchange, we get the Anthropic SDK's type definitions and SDK-managed retry. We can recover the latter through our existing `ModelGateway` retry pipeline (which already understands retryable errors per `ModelGateway.isRetryableProviderError`).

## Rejected

- **Use Anthropic SDK in dev only** (no runtime dep): we'd still need to test the live protocol in dev, which means downloading it anyway. No benefit.
- **Skip Anthropic support entirely**: blocks 60% of potential users (those with Anthropic API keys).
- **Write a generic streaming SDK for any provider**: too much scope creep for v0.5.x; revisit in v0.7.

## Consequences

+ Zero new runtime deps — "5 依赖" constraint preserved.
+ First-party Anthropic features unlocked (thinking, caching, betas) — directly addresses the "we were OpenAI-only" complaint in the comparison report.
+ Same `ProviderAdapter` interface — `StreamConsumer`, `ModelGateway`, fallback chain all work unchanged.
+ Backward compatible: existing `provider: 'openai'` / `provider: 'minimax'` continue to use the OpenAI-compatible adapter. Set `provider: 'anthropic'` to switch.
- We own the SSE parser; Anthropic API drift requires us to update the translator. Mitigation: pinned `anthropic-version`, contract tests in `tests/model/anthropicAdapter.test.ts`.
- Retry is the gateway's responsibility (already in place); the adapter itself doesn't retry.
- We don't ship a TypeScript shim for Anthropic types — consumers go through the OpenAI-shaped `ChatCompletionChunk` type.

## Files

- `src/core/model/anthropicAdapter.ts` — adapter implementation
- `src/core/model/anthropicSse.ts` — SSE parser + chunk translator + request body builder
- `src/core/model/providerAdapter.ts` — factory branch for `provider: 'anthropic'`
- `tests/model/anthropicAdapter.test.ts` — 26 tests covering parsing, translation, finish-reason mapping
