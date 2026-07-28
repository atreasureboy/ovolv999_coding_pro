# ADR-007: DONE.flag integrity (nonce + checkpoint binding)

## Context
The loop enforces Driver/Model privilege separation: the model may only
write CANDIDATE_DONE.flag; the Driver writes DONE.flag after the joint
six-condition gate (ADR-005's contract applied per loop iteration). Since
v0.3.3 the loop-top check recognized Driver authorship with a substring
match: `content.includes('DRIVER_VERIFIED')`.

## Problem
Substring matching is forgeable. A model that writes a DONE.flag whose
body merely contains "DRIVER_VERIFIED" — via Write, Edit, or Bash —
sails through the check, and the loop exits `succeeded` with acceptance
and quality gates skipped entirely. This was the only bypass in the
anti-false-success defense chain. The threat model is not an adversarial
shell escape artist; it is prompt-induced corner-cutting — a model that
sees the DONE.flag convention referenced in its prompt and shortcuts.

## Options
1. **In-memory nonce + checkpoint binding** — the Driver mints a UUID at
   process start that never touches disk and never appears in a prompt,
   and embeds it in the flag. Verification accepts two paths: nonce
   match (same process), or binding to a `phase='succeeded'` checkpoint
   (runId + sequence + gates⊆ + live goal/acceptance hash equality),
   which covers resume after a crash, where the nonce died with the
   previous process but the Driver-signed checkpoint survived.
2. **Tool-layer write ban only** — forbid model tools from touching
   DONE.flag. Bash bypasses it, and after a crash there is no way to
   distinguish a legitimate flag from a forgery.
3. **Filesystem permissions / OS ACLs** — violates the zero-native-dep,
   cross-platform install constraint (ADR-006 spirit), and cannot defend
   against a same-process writer anyway.

## Choice
Option 1, layered with option 2's tool ban:
- DONE.flag becomes strict JSON: `parseDoneFlag` / `verifyDoneFlag` /
  `renderDoneFlag` in loopEngine.ts. Legacy plaintext flags verify as
  forgeries and are renamed to DONE.flag.rejected — an intentional
  0.x compatibility break.
- The Driver writes the checkpoint FIRST: `finishLoopRun('succeeded')`
  persists `phase='succeeded'` at `++checkpointSequence`, then the bound
  flag references that sequence. A crash between the two is benign:
  resume short-circuits on `restoredCp.phase === 'succeeded'`. The flag
  is forensic; the checkpoint is the source of truth.
- Write and Edit tools hard-reject the four driver-owned files under
  `.loop/` — DONE.flag, loop.lock, checkpoint.json,
  checkpoint.previous.json — via `isLoopDriverOwnedPath` (structural
  basename matching: catches absolute and relative spellings without
  cwd resolution). checkpoint.json is guarded because forging
  `phase='succeeded'` there is the one way to satisfy checkpoint
  binding; the `.previous.json` backup is guarded because `load()`
  falls back to it on a corrupt main file.
- CANDIDATE_DONE.flag, PARKED.flag, STATE.md, HISTORY.md stay
  model-writable — that is the collaboration surface.

## Rejected
- Option 2 alone: Bash is unguarded by design (below) and post-crash
  legitimacy would be undecidable.
- Per-iteration rejected names (DONE.flag.rejected-iterN): would ripple
  into /loop-status flag listing and setLoopGoal cleanup; a fixed name
  overwriting with the most recent forgery plus the console warning is
  enough forensics.
- Extending the ban to notebookEdit/worktree tools: binding is the
  primary gate, and their write shapes cannot produce a valid payload
  (notebook structure fails parseDoneFlag and the checkpoint phase
  check alike).

## Consequences
+ Under the threat model, no file tool can forge loop completion.
+ Post-crash resume still validates a legitimate flag via checkpoint
  binding — no manual "was this flag ours?" judgment for the user.
+ Editing GOAL.md / ACCEPTANCE.md invalidates stale flags (live-hash
  mismatch): completion belonged to the old contract.
- Bash `cat > .loop/DONE.flag` remains possible but fails binding;
  Bash-forged checkpoint.json is outside the 0.x threat model — the
  sandbox is the answer at that layer, same as for any other shell
  side channel.
- 0.x break: plaintext DONE.flag files from older versions are
  rejected (renamed). Already-completed loops still resume correctly
  through the checkpoint short-circuit.

## File
`src/core/loopEngine.ts` (DoneFlagPayload, parseDoneFlag, verifyDoneFlag,
renderDoneFlag, loop-top verification, post-resume short-circuit, Driver
write ordering); `src/core/pathSecurity.ts` (isLoopDriverOwnedPath);
`src/tools/fileWrite.ts` + `src/tools/fileEdit.ts` (write ban).
