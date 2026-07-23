# ADR-004: Main-model + cheap-worker role split

## Context
A single model for every task is either too expensive (strong model for
trivial work) or too weak (cheap model for architecture).

## Problem
Token cost and quality both matter for a personal tool. Routing
everything to one model wastes budget on easy parts and under-performs
on hard parts.

## Options
1. **Single model** — simplest; no adaptivity.
2. **Keyword routing** (`if goal.includes('refactor')`) — brittle, not
   explainable, "if/else masquerading as routing".
3. **Multi-criteria scorer** — score each ModelProfile against task
   signals (complexity, context, budget, health, role); manual override
   wins; fallback chain on failure.

## Choice
Option 3: `ModelRouter` with config-driven `ModelProfile[]`. An explicit
`(1-complexity)*cost` term makes trivial→cheap and complex→strong. The
decision emits `reasonCodes` so `/route` and `/why` explain it from
structured data, not a hallucination.

## Consequences
+ Trivial tasks use the cheap model (saves tokens); hard tasks escalate.
+ Manual `--model`/`/model` always wins (predictable).
+ Fallback never replays side-effectful tools (fires at LLM-call boundary).
- Requires the user to declare profiles in config (single-model default
  degrades gracefully).

## File
`src/core/model/modelRouter.ts`.
