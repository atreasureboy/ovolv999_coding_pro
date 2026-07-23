# ADR-006: JSONL EventStore (with SQLite as a swappable backend)

## Context
Run state + events need to persist for crash recovery and auditing.

## Problem
Choosing a storage backend trades off simplicity vs queryability.

## Options
1. **JSONL (append-only line file)** — zero deps; line-atomic appends;
  trivial replay; weak at multi-condition queries / large histories.
2. **SQLite WAL** — relational queries, transactions, schema migration;
  a native dependency (better-sqlite3) that can complicate cross-
  platform install.
3. **In-memory only** — no recovery.

## Choice
Option 1 now, with option 2 as a swappable backend behind the
`EventStore` interface. JSONL already supports atomic `appendBatch`
(run-state + event commit together) and idempotent eventId dedup. SQLite
is deferred until JSONL genuinely can't support a need (TaskGraph
queries, large histories) — and only if its native dep doesn't hurt
installation (eight_goal §八).

## Rejected
Option 3 — recovery is a headline capability. Option 2 immediately —
the native-dep install risk isn't justified while JSONL meets current
needs; a data-driven case is required first.

## Consequences
+ Zero native deps; `curl|sh` install stays clean.
+ EventStore interface means SQLite can land without touching consumers.
- No multi-condition queries (fine for current single-process scale).

## File
`src/core/executionRunEvents.ts` (`EventStore`, `JsonlEventStore`).
