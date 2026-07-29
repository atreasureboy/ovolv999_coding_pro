# ADR-004: Role-aware main and worker model split

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
Option 3: `ModelRouter` with config-driven `ModelProfile[]` for the main
runtime, plus role-aware profile assignment when the existing `AgentTool`
constructs a child engine. Main profiles carry `main` or `architect`; worker
profiles carry `builder`, `reviewer`, `utility`, `worker`, or `planner`.
Cross-provider worker profiles resolve credentials only through `apiKeyEnv`.

## Consequences
+ Trivial tasks use the cheap model (saves tokens); hard tasks escalate.
+ Manual `--model`/`/model` always wins (predictable).
+ Fallback never replays side-effectful tools (fires at LLM-call boundary).
+ A frontier main agent can delegate implementation to a builder model and
  retain final acceptance authority.
+ Child results carry status, verification, changed files, blockers, model
  attempts, cost, and retained worktree information.
- Missing worker credentials fall back to the parent transport with an
  explicit reason.
- Embedding profiles are reserved for a future retrieval binding and are never
  spawned as autonomous agents by the current runtime.
- Requires the user to declare profiles in config (single-model default
  degrades gracefully).

## Configuration

```json
{
  "models": {
    "profiles": [
      {
        "id": "architect",
        "provider": "openai",
        "model": "frontier-model",
        "roles": ["main", "architect"]
      },
      {
        "id": "builder",
        "provider": "minimax",
        "model": "coding-model",
        "baseURL": "https://example.com/v1",
        "apiKeyEnv": "OVOLV999_BUILDER_API_KEY",
        "roles": ["builder", "worker"]
      },
      {
        "id": "retrieval",
        "provider": "openai",
        "model": "embedding-model",
        "apiKeyEnv": "OVOLV999_EMBEDDING_API_KEY",
        "roles": ["embedding"]
      }
    ]
  }
}
```

## Files

- `src/core/model/modelRouter.ts`
- `src/core/model/agentModelPolicy.ts`
- `src/tools/agent.ts`
