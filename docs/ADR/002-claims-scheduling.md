# ADR-002: Claims-based concurrency scheduling

## Context
Tools execute concurrently when safe, serially when they conflict.

## Problem
A name-based "safe tools" whitelist (Read/Glob/Grep parallel, rest
serial) was both unsafe (two Edits to the *same file* would race) and
over-restrictive (two Edits to *different files* were forced serial).

## Options
1. **Name whitelist** — coarse, unsafe for same-resource conflicts.
2. **Per-tool `isConcurrencySafe()` boolean** — still can't express
   "Read(a) + Edit(a) conflict, but Read(a) + Edit(b) don't".
3. **Resource claims** — each tool declares what resource (file/dir/git/
   process) it touches and how (read/write/exclusive); the scheduler
   groups by pairwise conflict.

## Choice
Option 3: `ResourceClaim[]` via `metadata.claims(input)`, a
`claimsConflictBetween` planner predicate, and atomic
`ResourceScheduler.acquire` as the authoritative guard.

## Consequences
+ Precise: same-file read+write serialise; different-file writes
  parallelise. Git is forced exclusive.
+ The scheduler partition is an *optimisation* — acquire() is the real
  correctness guard, so a wrong partition just under-parallelises.
- Tools without claims default to serial (conservative); coverage is
  6/27 tools today (the modifying ones).

## File
`src/core/resourceScheduler.ts`, `src/core/toolRuntime/toolScheduler.ts`.
