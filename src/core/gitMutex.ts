/**
 * GitMergeMutex — process-global exclusivity around parent-tree git
 * mutations (merge delivery, worktree removal).
 *
 * Round 32: enabling parallel Agent delegation unmasked a race — each
 * child is a separate ExecutionEngine with its OWN ResourceScheduler
 * (engine.ts:281), so claim-based git exclusivity cannot serialize
 * sibling-vs-sibling delivery into the SHARED parent cwd. Two children
 * finalizing concurrently would race on .git/index.lock and leave a
 * dirty index. The mutex is module-level: every engine in this process
 * contends on the same promise chain, and the CLI/daemon split is
 * documented as out of scope (cross-process exclusivity remains git's
 * own index.lock).
 */

let chain: Promise<void> = Promise.resolve()

/**
 * Run `fn` under global git-mutation exclusivity. FIFO — resolvers are
 * queued in call order, so a burst of finishing agents delivers in
 * deterministic arrival sequence. `fn`'s rejection propagates to its own
 * caller without breaking the chain.
 */
export function withGitMutex<T>(fn: () => Promise<T>): Promise<T> {
  // FIFO: run after the previous holder settles, whether it succeeded
  // or failed — the chain never breaks. fn's own rejection propagates
  // to THIS caller only.
  const run = chain.then(fn, fn)
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
