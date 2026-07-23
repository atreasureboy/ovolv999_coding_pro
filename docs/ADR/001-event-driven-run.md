# ADR-001: Event-driven Run state machine

## Context
Every execution (a turn, an agent delegation, a worker, a workflow step)
needs a trackable identity and lifecycle.

## Problem
Ad-hoc status fields scattered across modules made it impossible to
answer "what is running right now?", recover after a crash, or build a
trace. We needed a single source of truth for execution state.

## Options
1. **Scattered per-module status** — what we had; unobservable.
2. **A central registry + typed events** — one ExecutionRunRegistry,
   every state change emits a structured event, persisted to JSONL.
3. **An external orchestrator** (Temporal/Airflow) — overkill for an
   in-process agent; adds heavy infra.

## Choice
Option 2: `ExecutionRunRegistry` + `RunEventBus` + JSONL `EventStore`.
Every run has an id, kind, parentRunId, status, phase. Events are
persisted first (write-side throws on failure), then fanned to
subscribers.

## Rejected
Option 3 — violates the "personal tool, no heavy deps" constraint.

## Consequences
+ Crash recovery (`recoverRegistryFromStore`), `/trace` explainability,
  parent-child run trees.
+ A second status source must NEVER exist — the registry is authoritative.
- In-process pub/sub has no production `.on()` subscribers yet
  (persistence works; live subscription is an extension point).
