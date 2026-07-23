# ADR-003: Separate internal control messages from user history

## Context
The runtime sometimes needs to nudge the model: "your last response was
empty, retry", "continue from where you were cut off", "a critic found
a problem", "context was compacted".

## Problem
These were injected as `role: 'user'` messages (and compaction even
forged a `role: 'assistant'` acknowledgment). This polluted the real
conversation history, put words in the user's/assistant's mouth, and
made session exports misleading.

## Options
1. **Keep `role: 'user'`** — simplest, but semantically wrong.
2. **An `InternalControlMessage` type** — stored separately, converted
   to provider form at the adapter boundary, never in user exports.
3. **`role: 'system'`** — runtime context, not user input; alternation-
   safe; no synthetic partner turn needed.

## Choice
Option 3 as the pragmatic middle (and option 2 as the full future
design). Control nudges (stall guard, critic guidance, compaction
summary) are now `role: 'system'`. The full InternalControlMessage type
(remaining Phase 1.2) will tag them so exports/compaction can filter
them explicitly.

## Consequences
+ No forged user/assistant messages; history stays honest.
+ `role: 'system'` works across OpenAI-compatible providers without a
  new message type.
- Coordinator nudges (empty-retry/length-continue) still use
  `role: 'user'` — the remaining 1.2 migration.

## File
`src/core/compact.ts` (summary → system), `src/core/runtime/progressMonitor.ts`
(`interventionMessageForStall` → system), `src/core/runtime/criticTrigger.ts`.
