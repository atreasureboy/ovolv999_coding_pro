/**
 * Global tool filtering rules for sub-agents.
 *
 * Inspired by claude-code's agentToolUtils.ts, adapted for ovolv999.
 *
 * Sub-agents are spawned from inside another agent's runTurn (via the
 * Agent tool) and inherit a much narrower blast radius than the main
 * thread. To prevent recursion, plan-mode bleed-through, and accidental
 * escape from a sandboxed preset, this module owns the GLOBAL denylist
 * that overrides any per-agent allow/deny list.
 *
 * The filter is applied IN ADDITION to the per-agent lists in
 * AgentConfig (allowlist via `tools` and personal denylist via
 * `disallowedTools`), so a preset that gives Bash to a sub-agent still
 * loses Agent, EnterPlanMode, ExitPlanMode, and VerifyPlanExecution.
 * That ordering matters: the global set is the inner-most ring, so it
 * can never be opted back into by the outer layers.
 */

/**
 * Tools ALWAYS blocked for sub-agents — applied regardless of preset
 * or caller's `AgentConfig.tools` allowlist.
 *
 * Each entry here is a one-line reasoning note:
 *   - `Agent`            → recursion guard. A sub-agent must NOT be able
 *                          to spawn further sub-agents; without this
 *                          a model could escalate quota / latency costs
 *                          linearly and turn a single prompt into an
 *                          unkillable tree of API calls.
 *   - `EnterPlanMode`    → plan mode is main-thread only. A sub-agent
 *                          that entered plan mode would deadlock the
 *                          calling engine: ExitPlanMode is main-thread
 *                          too, so there is no way out.
 *   - `ExitPlanMode`     → same reason — without it a sub-agent could
 *                          exit plan mode the host never asked for.
 *   - `VerifyPlanExecution` → plan-mode verification is a host-only
 *                          concern (it inspects the main thread's
 *                          finished plan), not something a sub-agent
 *                          should be able to invoke.
 *
 * Exported as a `Set` (and as a const array) so callers can build their
 * own denylists without re-typing the names, and tests can assert the
 * exact membership.
 */
export const SUB_AGENT_DISALLOWED_TOOLS: ReadonlySet<string> = new Set<string>([
  'Agent',                     // prevent infinite recursion
  'EnterPlanMode',             // plan mode is main-thread only
  'ExitPlanMode',              // plan mode is main-thread only
  'VerifyPlanExecution',       // plan mode is main-thread only
])

/**
 * Filter tool DEFINITIONS for a sub-agent.
 * Returns a filtered array of tool names.
 *
 * Precedence (innermost last, so each layer can further restrict):
 *   1. Start with the full `toolNames` list.
 *   2. Apply the agent's allowlist (`AgentConfig.tools`). Tools NOT on
 *      the allowlist are dropped, EXCEPT MCP tools (`mcp__<server>__<tool>`)
 *      which are always passed through — MCP tools are namespaced by
 *      server and are individually opted-in by the host, so a global
 *      allowlist usually shouldn't strip them.
 *   3. Apply {@link SUB_AGENT_DISALLOWED_TOOLS}. This MUST come after
 *      the allowlist so `Agent` can't be re-introduced by listing it in
 *      a preset's `tools` field — the recursion guard is absolute.
 *   4. Apply the per-agent denylist (`AgentConfig.disallowedTools`) last
 *      so a caller can pin specific tools off on top of any preset.
 *
 * The function is intentionally pure — no I/O, no logging, no module
 * lookups — so the engine can call it cheaply on every `getToolDefinitions`
 * pass and so the tests can pin the exact contract without spinning up
 * the rest of the harness.
 *
 * @param toolNames - All tool names from the engine's ToolDefinition[].
 * @param allowlist - `AgentConfig.tools` (undefined = no per-agent allowlist).
 * @param denylist - `AgentConfig.disallowedTools` (undefined = no extras).
 * @returns Filtered array of tool names.
 */
export function filterToolsForSubAgent(
  toolNames: string[],
  allowlist: string[] | undefined,
  denylist: string[] | undefined,
): string[] {
  // Start with all tools
  let result = toolNames

  // Apply allowlist (if set)
  if (allowlist) {
    // Round 41 audit fix: case-insensitive match — frontmatter entries
    // like `tools: read, bash` previously matched nothing and the
    // sub-agent silently booted with ZERO tools.
    const allowed = new Set(allowlist.map((n) => n.toLowerCase()))
    result = result.filter(name => allowed.has(name.toLowerCase()) || name.startsWith('mcp__'))
  }

  // Apply global disallow set (sub-agents never get these)
  result = result.filter(name => !SUB_AGENT_DISALLOWED_TOOLS.has(name))

  // Apply per-agent denylist (if set)
  if (denylist) {
    const denied = new Set(denylist.map((n) => n.toLowerCase()))
    result = result.filter(name => !denied.has(name.toLowerCase()))
  }

  return result
}