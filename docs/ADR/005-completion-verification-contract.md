# ADR-005: Completion requires a verification contract

## Context
Models emit `finish_reason: 'stop_sequence'` when they believe they're
done.

## Problem
"Model said stop" ≠ "task actually done". The model can declare
completion over a failed test suite, while child workers are still
running, or without having changed anything. This is the classic
false-success failure mode.

## Options
1. **Trust stop_sequence → succeeded** — what we had; unsafe.
2. **Always require explicit verification** — too rigid for Q&A turns
   that legitimately produce no changes.
3. **Conservative contract gate** — block `succeeded` only on *positive*
   failure evidence (failed verification, running children, unfinished
   TaskGraph nodes); allow otherwise.

## Choice
Option 3: `CompletionContract` + `Reviewer`. The Run is marked
`blocked` (not `succeeded`) when verification failed or children are
outstanding. A deterministic Reviewer gives a post-run
completed/partial/blocked verdict from structured state.

## Consequences
+ False-success is structurally prevented at the Run-status level.
+ Normal Q&A turns still succeed (no false blocks — only positive
  failure evidence blocks).
+ `result.reason` is unchanged (callers unaffected); only the Run
  status is gated.

## File
`src/core/runtime/completionContract.ts`, `reviewer.ts`,
`src/core/runtime/coordinator.ts` (terminal transition).
