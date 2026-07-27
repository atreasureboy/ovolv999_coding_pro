# Changelog

All notable changes are documented here. This project follows Semantic Versioning while it remains in the `0.x` development series.

## 0.3.6

### Reliability

- Bound completion candidates to the active run, goal, acceptance contract, checkpoint sequence, quality gates, TaskGraph, and Worker state.
- Added authoritative provider attempt chains with per-attempt usage, cost, latency, and model attribution.
- Hardened lease ownership with stable process identity, owner tokens, and atomic takeover and release.
- Separated heartbeat liveness from evidence-backed progress and park the runtime after repeated heartbeat persistence failures.
- Restored checkpoints without replaying quality gates already backed by valid evidence.
- Preserved partial, blocked, conflicted, and patch-bearing Worker worktrees for parent recovery.
- Made terminal run outcomes explicit and single-emission.

### Distribution

- Added reproducible npm installs from a committed lockfile.
- Made Unix and Windows updates staged and rollback-safe.
- Added cross-platform CI, dependency automation, package smoke tests, and a tag-driven release workflow.
- Reduced the published package to runtime artifacts and public documentation.

