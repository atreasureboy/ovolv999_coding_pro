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
constructs a child engine. `tier: top | secondary` is the only configured
source of model strength. Roles describe purpose: main profiles carry `main`
or `architect`; worker profiles carry `builder`, `reviewer`, `utility`,
`worker`, or `planner`.
Cross-provider worker profiles resolve credentials only through `apiKeyEnv`.
Every child preset defaults to a secondary role. The root main agent is the
only caller allowed to request `architect`, and the request must carry an
`escalation_reason`. Nested agents cannot promote themselves. A configured
secondary profile with missing credentials fails closed instead of silently
consuming the main model.
Secondary delegation is intended for repetitive work, bounded implementation,
reading and summarization, tests, and independent review. Architecture,
cross-module public interfaces, migrations, security boundaries, and root-cause
decisions require `architect`. Profile scoring prioritizes coding, reasoning,
and tool capability; cost and speed are weak tie-breakers only.

## Consequences
+ Main turns route only among configured top profiles; bounded child work uses
  configured secondary profiles.
+ Manual `--model`/`/model` always wins (predictable).
+ Fallback never replays side-effectful tools (fires at LLM-call boundary).
+ A frontier main agent can delegate implementation to a builder model and
  retain final acceptance authority.
+ Child results carry status, verification, changed files, blockers, model
  attempts, cost, and retained worktree information.
- Legacy single-model installs without any profiles still use their only
  model for compatibility.
- Configured multi-model installs fail closed when the eligible secondary
  profile or credential is unavailable.
- Embedding generation and vector storage are outside this runtime stage.
- Requires the user to declare profiles in config (single-model default
  degrades gracefully).

## Configuration

```json
{
  "models": {
    "profiles": [
      {
        "id": "architect",
        "tier": "top",
        "provider": "openai",
        "model": "frontier-model",
        "roles": ["main", "architect"]
      },
      {
        "id": "builder",
        "tier": "secondary",
        "provider": "minimax",
        "model": "coding-model",
        "baseURL": "https://example.com/v1",
        "apiKeyEnv": "OVOLV999_BUILDER_API_KEY",
        "roles": ["builder", "worker"]
      }
    ]
  }
}
```

## Files

- `src/core/model/modelRouter.ts`
- `src/core/model/agentModelPolicy.ts`
- `src/tools/agent.ts`
