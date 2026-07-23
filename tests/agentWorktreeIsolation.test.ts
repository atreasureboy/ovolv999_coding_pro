/**
 * P0-4 regression: parallel modifying agents share the parent cwd.
 *
 * Invariant (fi_goal.md §P0-4): a task that mutates state MUST run
 * inside an isolated git worktree on a dedicated branch. Read-only
 * tasks (the default) MAY share the parent cwd. The Runtime decides
 * isolation based on the orchestrator-supplied `modifies_state` flag
 * — the sub-agent itself has no say.
 *
 * Pre-fix: AgentTool spawned every sub-agent directly in
 * `context.cwd`, so two parallel modifying agents would race on the
 * same working tree, and a sub-agent that broke the build would
 * pollute the parent's workspace before the verify gate could catch
 * it. The existing EnterWorktree/ExitWorktree TOOLS were decorative —
 * the sub-agent had to invoke them itself, which fi_goal.md §P0-4
 * explicitly forbids ("should not be decided by the sub-model").
 *
 * Post-fix: AgentTool auto-creates a worktree when modifies_state:true,
 * spawns the child inside it, runs the verify gate inside it, and
 * either merges back (success) or discards (failure).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'

import { AgentTool } from '../src/tools/agent.js'
import { _resetWorktreeManagersForTest, getWorktreeManager } from '../src/tools/worktree.js'
import type { EngineConfig } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'

// ── Harness ────────────────────────────────────────────────────────────────

function fakeRenderer(): Renderer & { __calls: { kind: string; args: unknown[] }[] } {
  const calls: { kind: string; args: unknown[] }[] = []
  const r: Record<string, unknown> = { __calls: calls }
  for (const k of [
    'banner', 'info', 'warn', 'error', 'success',
    'startSpinner', 'stopSpinner',
    'beginAssistantText', 'endAssistantText', 'streamToken',
    'toolStart', 'toolResult',
    'compactStart', 'compactDone', 'contextWarning',
    'agentStart', 'agentDone', 'agentSummary', 'agentHeartbeat',
  ]) {
    r[k] = (...a: unknown[]) => { calls.push({ kind: k, args: a }) }
  }
  return r as unknown as Renderer & { __calls: typeof calls }
}

function baseConfig(o: Partial<EngineConfig> = {}): EngineConfig {
  return {
    apiKey: 'k',
    model: 'm',
    maxIterations: 10,
    cwd: '/tmp',
    permissionMode: 'auto',
    permissionManager: undefined,
    enabledModules: [],
    ...o,
  }
}

/**
 * Build a child-engine factory that records the cwd it was constructed
 * with. The returned engine's runTurn writes a file inside that cwd so
 * we can verify the worktree actually received the write (not the
 * parent cwd).
 */
function recordingChildEngine(filename: string, body: string): {
  factory: (config: EngineConfig) => {
    runTurn: () => Promise<{
      result: { output: string; reason: 'stop_sequence' | 'error' }
      newHistory: unknown[]
    }>
    abort: () => void
    dispose: () => void
  }
  constructedCwds: string[]
} {
  const constructedCwds: string[] = []
  return {
    constructedCwds,
    factory: (config: EngineConfig) => {
      constructedCwds.push(config.cwd)
      return {
        runTurn: () => {
          // Simulate the sub-agent writing a file inside ITS cwd.
          writeFileSync(join(config.cwd, filename), body, 'utf8')
          return Promise.resolve({
            result: { output: `wrote ${filename}`, reason: 'stop_sequence' as const },
            newHistory: [],
          })
        },
        abort: () => undefined,
        dispose: () => undefined,
      }
    },
  }
}

/** Child engine that returns reason='error'. */
function errorChildEngine(): {
  factory: (config: EngineConfig) => {
    runTurn: () => Promise<{
      result: { output: string; reason: 'stop_sequence' | 'error' }
      newHistory: unknown[]
    }>
    abort: () => void
    dispose: () => void
  }
  constructedCwds: string[]
} {
  const constructedCwds: string[] = []
  return {
    constructedCwds,
    factory: (config: EngineConfig) => {
      constructedCwds.push(config.cwd)
      return {
        runTurn: () => Promise.resolve({
          result: { output: 'engine error mid-run', reason: 'error' as const },
          newHistory: [],
        }),
        abort: () => undefined,
        dispose: () => undefined,
      }
    },
  }
}

let tmpRoot = ''
let gitRoot = ''

beforeEach(() => {
  tmpRoot = mkdtempSync(`${tmpdir()}/p0-4-`)
  // Real git repo so WorktreeManager can `git worktree add`.
  gitRoot = join(tmpRoot, 'repo')
  mkdirSync(gitRoot, { recursive: true })
  execSync('git init -b main', { cwd: gitRoot, stdio: 'pipe' })
  execSync('git config user.email t@t.test', { cwd: gitRoot, stdio: 'pipe' })
  execSync('git config user.name test', { cwd: gitRoot, stdio: 'pipe' })
  // Initial commit so worktree add has a base to branch from.
  writeFileSync(join(gitRoot, 'README.md'), '# repo\n')
  execSync('git add -A && git commit -m init', { cwd: gitRoot, stdio: 'pipe' })
  _resetWorktreeManagersForTest()
})

afterEach(() => {
  _resetWorktreeManagersForTest()
  rmSync(tmpRoot, { recursive: true, force: true })
})

/** Write a package.json whose `test` script passes. */
function writePassingPackageJson(dir: string): void {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'p0-4', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
  )
  // Commit so the worktree (which branches from HEAD) inherits it.
  execSync('git add -A && git commit -m pkg', { cwd: gitRoot, stdio: 'pipe' })
}

/** Write a package.json whose `test` script FAILS (used to trip verify gate). */
function writeFailingPackageJson(dir: string): void {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'p0-4', scripts: { test: 'node -e "process.exit(2)"' } }, null, 2),
  )
  execSync('git add -A && git commit -m pkg-fail', { cwd: gitRoot, stdio: 'pipe' })
}

// ─────────────────────────────────────────────────────────────────────
// P0-4.A: read-only tasks (default) never create a worktree
// ─────────────────────────────────────────────────────────────────────
describe('P0-4.A: read-only tasks (default) never create a worktree', () => {
  it('spawns the child in the parent cwd when modifies_state is omitted', async () => {
    const child = recordingChildEngine('read-only.txt', 'hi')
    const tool = new AgentTool({
      factory: child.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    const out = await tool.execute(
      { description: 'read-only task', prompt: 'just look around', subagent_type: 'general-purpose' },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    expect(out.isError).toBe(false)
    expect(child.constructedCwds).toEqual([gitRoot])
    // No worktree directory was created.
    expect(existsSync(join(gitRoot, '.ovolv999/worktrees'))).toBe(false)
  })

  it('spawns the child in the parent cwd when modifies_state:false is explicit', async () => {
    const child = recordingChildEngine('ro2.txt', 'hi')
    const tool = new AgentTool({
      factory: child.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    await tool.execute(
      { description: 'explicit ro', prompt: 'noop', modifies_state: false },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    expect(child.constructedCwds).toEqual([gitRoot])
    expect(existsSync(join(gitRoot, '.ovolv999/worktrees'))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-4.B: modifying tasks get an isolated worktree
// ─────────────────────────────────────────────────────────────────────
describe('P0-4.B: modifying tasks get an isolated worktree', () => {
  it('spawns the child inside a worktree path (not the parent cwd)', async () => {
    const child = recordingChildEngine('change.txt', 'edit')
    const tool = new AgentTool({
      factory: child.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    const out = await tool.execute(
      { description: 'modify the code', prompt: 'edit things', modifies_state: true },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    expect(out.isError).toBe(false)
    expect(child.constructedCwds).toHaveLength(1)
    const usedCwd = child.constructedCwds[0]
    // Child ran inside the worktree subdirectory, NOT the parent repo root.
    expect(usedCwd).not.toBe(gitRoot)
    expect(usedCwd).toContain('.ovolv999/worktrees/')
    // The auto-merge path commits the worktree's pending edits and
    // merges back, so by the time execute() returns the worktree dir
    // is gone and the file lives in the parent's HEAD.
    expect(existsSync(join(gitRoot, 'change.txt'))).toBe(true)
    // The specific worktree subdir is cleaned up.
    expect(existsSync(usedCwd)).toBe(false)
  })

  it('auto-merges the worktree branch back to base on success', async () => {
    const child = recordingChildEngine('feature.txt', 'new feature')
    const tool = new AgentTool({
      factory: child.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    await tool.execute(
      { description: 'add feature', prompt: 'add it', modifies_state: true },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    // After merge: parent HEAD now contains the file the sub-agent wrote.
    expect(existsSync(join(gitRoot, 'feature.txt'))).toBe(true)
    // The merge commit landed in git history.
    const log = execSync('git log --oneline', { cwd: gitRoot, encoding: 'utf8' })
    expect(log).toMatch(/agent: add feature/)
  })

  it('skips merge when merge_on_success:false (keeps worktree for review)', async () => {
    const child = recordingChildEngine('review.txt', 'pending review')
    const tool = new AgentTool({
      factory: child.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    const out = await tool.execute(
      {
        description: 'reviewable change',
        prompt: 'edit then wait',
        modifies_state: true,
        merge_on_success: false,
      },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    expect(out.isError).toBe(false)
    expect(out.content).toContain('[Worktree] kept')
    // The worktree path was recorded — file is there, NOT merged.
    const usedCwd = child.constructedCwds[0]
    expect(existsSync(join(usedCwd, 'review.txt'))).toBe(true)
    expect(existsSync(join(gitRoot, 'review.txt'))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-4.C: failures discard the worktree without merging
// ─────────────────────────────────────────────────────────────────────
describe('P0-4.C: failures discard the worktree without merging', () => {
  it('discards on engine-error reason (no merge)', async () => {
    const child = errorChildEngine()
    const tool = new AgentTool({
      factory: child.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    const out = await tool.execute(
      { description: 'boom', prompt: 'fail', modifies_state: true },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    expect(out.isError).toBe(true)
    expect(out.content).toContain('[Worktree] discarded')
    // No stray file merged into the parent.
    expect(existsSync(join(gitRoot, 'feature.txt'))).toBe(false)
    // The specific worktree subdir is gone.
    expect(existsSync(child.constructedCwds[0])).toBe(false)
  })

  it('discards on verify-gate failure (no merge of broken code)', async () => {
    // Parent repo has a failing test script — the worktree inherits it.
    writeFailingPackageJson(gitRoot)
    // The child "succeeds" (reason=stop_sequence) but the verify gate
    // in the worktree catches the broken test → must discard.
    const successChild = (() => {
      const constructedCwds: string[] = []
      return {
        constructedCwds,
        factory: (config: EngineConfig) => {
          constructedCwds.push(config.cwd)
          return {
            runTurn: () => Promise.resolve({
              result: { output: 'all done', reason: 'stop_sequence' as const },
              newHistory: [],
            }),
            abort: () => undefined,
            dispose: () => undefined,
          }
        },
      }
    })()

    const tool = new AgentTool({
      factory: successChild.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    const out = await tool.execute(
      { description: 'broken change', prompt: 'edit', modifies_state: true, verify: true },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    expect(out.isError).toBe(true)
    expect(out.content).toContain('[Verify Gate] ✗')
    expect(out.content).toContain('[Worktree] discarded')
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-4.D: parallel isolation — two modifying tasks get distinct worktrees
// ─────────────────────────────────────────────────────────────────────
describe('P0-4.D: parallel modifying tasks get distinct worktrees', () => {
  it('two concurrent modifying agents receive non-overlapping cwds', async () => {
    const childA = recordingChildEngine('a.txt', 'A was here')
    const childB = recordingChildEngine('b.txt', 'B was here')
    const toolA = new AgentTool({
      factory: childA.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })
    const toolB = new AgentTool({
      factory: childB.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    // Dispatch both in parallel — they must NOT share a worktree.
    // Sequential merges into `main` would conflict if they touched the
    // same branch, so each gets its own branch off HEAD.
    const [outA, outB] = await Promise.all([
      toolA.execute(
        { description: 'task A', prompt: 'edit a', modifies_state: true },
        { cwd: gitRoot, permissionMode: 'auto' },
      ),
      toolB.execute(
        { description: 'task B', prompt: 'edit b', modifies_state: true },
        { cwd: gitRoot, permissionMode: 'auto' },
      ),
    ])

    expect(outA.isError).toBe(false)
    expect(outB.isError).toBe(false)
    const cwdA = childA.constructedCwds[0]
    const cwdB = childB.constructedCwds[0]
    expect(cwdA).not.toBe(cwdB)
    // Both files merged into parent HEAD.
    expect(existsSync(join(gitRoot, 'a.txt'))).toBe(true)
    expect(existsSync(join(gitRoot, 'b.txt'))).toBe(true)
  })

  it('read-only + modifying in parallel: read-only stays in parent cwd', async () => {
    const roChild = recordingChildEngine('ro-marker.txt', 'ro')
    const modChild = recordingChildEngine('mod-marker.txt', 'mod')
    const roTool = new AgentTool({
      factory: roChild.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })
    const modTool = new AgentTool({
      factory: modChild.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    await Promise.all([
      roTool.execute(
        { description: 'inspect', prompt: 'just look', modifies_state: false },
        { cwd: gitRoot, permissionMode: 'auto' },
      ),
      modTool.execute(
        { description: 'mutate', prompt: 'edit', modifies_state: true },
        { cwd: gitRoot, permissionMode: 'auto' },
      ),
    ])

    // Read-only ran in parent cwd directly.
    expect(roChild.constructedCwds[0]).toBe(gitRoot)
    // Modifying ran inside a worktree.
    expect(modChild.constructedCwds[0]).not.toBe(gitRoot)
    expect(modChild.constructedCwds[0]).toContain('.ovolv999/worktrees/')
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-3 (five_goal §四): worktree creation MUST be fail-closed.
// Previously the test asserted a "graceful fallback to parent cwd"
// behavior — that is now EXPLICITLY FORBIDDEN. A modify task whose
// worktree cannot be created must NOT start the sub-agent and must
// surface as 'blocked' so the orchestrator can choose a real fallback
// (temporary_copy, retry, or downgrade to read_only) — never a silent
// cwd fallback that lets parallel modify agents trample each other.
// ─────────────────────────────────────────────────────────────────────
describe('P0-3: fail-closed when worktree creation is impossible', () => {
  it('blocks the run when the workspace is not a git repo (no parent-cwd fallback)', async () => {
    // tmpRoot is a plain dir — no .git
    const plain = join(tmpRoot, 'no-git')
    mkdirSync(plain, { recursive: true })
    _resetWorktreeManagersForTest()

    const child = recordingChildEngine('no-git-edit.txt', 'should not run')
    const tool = new AgentTool({
      factory: child.factory,
      parentConfig: baseConfig({ cwd: plain }),
      parentRenderer: fakeRenderer(),
    })

    const out = await tool.execute(
      { description: 'modify without git', prompt: 'edit', modifies_state: true },
      { cwd: plain, permissionMode: 'auto' },
    )

    // Sub-agent must NOT have been spawned.
    expect(out.isError).toBe(true)
    expect(child.constructedCwds).toEqual([])
    expect(existsSync(join(plain, 'no-git-edit.txt'))).toBe(false)
    // Structured shape — status:'blocked', retryable:true, diagnostic.
    const structured = out as typeof out & { status?: string; retryable?: boolean; diagnostics?: { code: string; message: string }[] }
    expect(structured.status).toBe('blocked')
    expect(structured.retryable).toBe(true)
    expect(structured.diagnostics?.[0]?.code).toBe('WORKTREE_CREATION_FAILED')
  })

  it('blocks the run when task_mode:"modify" cannot create a worktree', async () => {
    const plain = join(tmpRoot, 'no-git-2')
    mkdirSync(plain, { recursive: true })
    _resetWorktreeManagersForTest()

    const child = recordingChildEngine('no-git-edit.txt', 'should not run')
    const tool = new AgentTool({
      factory: child.factory,
      parentConfig: baseConfig({ cwd: plain }),
      parentRenderer: fakeRenderer(),
    })

    const out = await tool.execute(
      { description: 'modify via task_mode', prompt: 'edit', task_mode: 'modify' },
      { cwd: plain, permissionMode: 'auto' },
    )

    expect(out.isError).toBe(true)
    expect(child.constructedCwds).toEqual([])
    const structured = out as typeof out & { status?: string }
    expect(structured.status).toBe('blocked')
  })

  it('plan-mode agents skip worktree creation (read-only by definition)', async () => {
    const child = recordingChildEngine('plan.txt', 'should not write')
    const tool = new AgentTool({
      factory: child.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    const out = await tool.execute(
      {
        description: 'plan only',
        prompt: 'design',
        // planMode agents are read-only — modifies_state must be ignored.
        modifies_state: true,
        agent_config: { identity: { systemPrompt: 'plan-only', planMode: true } },
      },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    expect(out.isError).toBe(false)
    // Ran in parent cwd, no worktree spun up.
    expect(child.constructedCwds).toEqual([gitRoot])
    expect(existsSync(join(gitRoot, '.ovolv999/worktrees'))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-4.F: verify gate runs INSIDE the worktree, not the parent
// ─────────────────────────────────────────────────────────────────────
describe('P0-4.F: verify gate runs inside the worktree', () => {
  it('passes when the worktree has a passing package.json (parent has none)', async () => {
    // Parent has NO package.json; the sub-agent "creates" one inside
    // the worktree by writing it during runTurn. The verify gate must
    // run in the worktree (where package.json exists) — running it in
    // the parent cwd would falsely report "no verify commands found".
    const childWithPkg = {
      factory: (config: EngineConfig) => ({
        runTurn: () => {
          writeFileSync(
            join(config.cwd, 'package.json'),
            JSON.stringify({ name: 'wt-fixture', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
          )
          return Promise.resolve({
            result: { output: 'added package.json', reason: 'stop_sequence' as const },
            newHistory: [],
          })
        },
        abort: () => undefined,
        dispose: () => undefined,
      }),
      cwds: [] as string[],
    }

    const tool = new AgentTool({
      factory: childWithPkg.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    const out = await tool.execute(
      { description: 'add pkg', prompt: 'add package.json', modifies_state: true, verify: true },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    // Verify gate RAN (found package.json in the worktree) and passed.
    expect(out.content).toContain('[Verify Gate] ✓')
    expect(out.isError).toBe(false)
    // After merge, the parent repo now has the package.json.
    expect(existsSync(join(gitRoot, 'package.json'))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-4.G: merged branch is visible in git history after success
// ─────────────────────────────────────────────────────────────────────
describe('P0-4.G: merge artifacts are observable', () => {
  it('the agent commit shows up on base after merge', async () => {
    const child = recordingChildEngine('hist.txt', 'merged change')
    const tool = new AgentTool({
      factory: child.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    await tool.execute(
      { description: 'history test', prompt: 'edit', modifies_state: true },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    // The auto-commit + merge lands the sub-agent's commit on main.
    const log = execSync('git log --oneline', { cwd: gitRoot, encoding: 'utf8' })
    expect(log).toMatch(/agent: history test/)
    // The source branch is deleted post-merge (no leftover refs).
    const branches = execSync('git branch --list', { cwd: gitRoot, encoding: 'utf8' })
    expect(branches).not.toMatch(/wt\//)
    // And the file is on HEAD of the parent.
    expect(readFileSync(join(gitRoot, 'hist.txt'), 'utf8')).toBe('merged change')
  })

  it('after discard, the worktree branch is deleted (no leftover refs)', async () => {
    const child = errorChildEngine()
    const tool = new AgentTool({
      factory: child.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    await tool.execute(
      { description: 'discard test', prompt: 'fail', modifies_state: true },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    // No leftover worktree branches in the repo.
    const branches = execSync('git branch --list', { cwd: gitRoot, encoding: 'utf8' })
    expect(branches).not.toMatch(/wt\//)
    // No leftover specific worktree directory.
    expect(existsSync(child.constructedCwds[0])).toBe(false)
    // The worktree manager's tracking metadata is empty.
    const mgr = getWorktreeManager(gitRoot)
    expect(mgr.listWorktrees()).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-4 (five_goal §四): task_mode enum replaces modifies_state boolean.
// LLMs forgetting to set modifies_state:true would silently bypass
// isolation. An explicit task_mode:'modify' value (and a default
// verify gate) closes the loophole.
// ─────────────────────────────────────────────────────────────────────
describe('P0-4: task_mode:"modify" enforces isolation + verify default', () => {
  it('task_mode:"modify" creates a worktree even without modifies_state flag', async () => {
    const child = recordingChildEngine('task-mode.txt', 'via task_mode')
    const tool = new AgentTool({
      factory: child.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    const out = await tool.execute(
      { description: 'modify via task_mode', prompt: 'edit', task_mode: 'modify' },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    expect(out.isError).toBe(false)
    expect(child.constructedCwds[0]).not.toBe(gitRoot)
    expect(child.constructedCwds[0]).toContain('.ovolv999/worktrees/')
  })

  it('task_mode:"read_only" never creates a worktree', async () => {
    const child = recordingChildEngine('ro.txt', 'read only')
    const tool = new AgentTool({
      factory: child.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    await tool.execute(
      { description: 'explicit ro', prompt: 'look', task_mode: 'read_only' },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    expect(child.constructedCwds[0]).toBe(gitRoot)
  })

  it('task_mode:"modify" forces verify gate ON by default (cannot be silently bypassed)', async () => {
    // Install a FAILING verify package.json. If the gate were off
    // (default-on-via-modify-mode), the run would succeed; instead we
    // expect verification_failed.
    writeFailingPackageJson(gitRoot)

    const child = recordingChildEngine('would-merge.txt', 'edit')
    const tool = new AgentTool({
      factory: child.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    const out = await tool.execute(
      { description: 'no verify flag set', prompt: 'edit', task_mode: 'modify' },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    expect(out.isError).toBe(true)
    const structured = out as typeof out & { status?: string }
    expect(structured.status).toBe('verification_failed')
    expect(String(out.content)).toMatch(/Verify Gate\] ✗/)
  })

  it('explicit verify:false overrides default for read_only tasks', async () => {
    // read_only should not force-verify. Explicit verify:false on a
    // read_only task means no verify gate runs at all.
    const child = recordingChildEngine('ro-no-verify.txt', 'hi')
    const tool = new AgentTool({
      factory: child.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    const out = await tool.execute(
      { description: 'ro explicit', prompt: 'look', task_mode: 'read_only', verify: false },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    expect(out.isError).toBe(false)
    expect(String(out.content)).not.toMatch(/Verify Gate/)
  })

  it('modifies_state:true is treated as an alias for task_mode:"modify" (back-compat)', async () => {
    const child = recordingChildEngine('alias.txt', 'via modifies_state')
    const tool = new AgentTool({
      factory: child.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    // No verify gate will run because the test repo has no package.json
    // — so the default-on-verify is a no-op and we just check isolation.
    const out = await tool.execute(
      { description: 'alias', prompt: 'edit', modifies_state: true, verify: false },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    expect(out.isError).toBe(false)
    expect(child.constructedCwds[0]).toContain('.ovolv999/worktrees/')
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-5 (five_goal §五): merge conflict → 'blocked' (NOT 'failed').
// The sub-agent's work was sound; only the merge against a moved base
// failed. The worktree + branch must be PRESERVED so a parent agent
// (or human) can resolve the conflicts.
// ─────────────────────────────────────────────────────────────────────
describe('P0-5: delivery conflict → blocked + worktree preserved', () => {
  it('marks the run as blocked and surfaces conflict list on merge conflict', async () => {
    // Strategy: have the sub-agent write to a file that the parent
    // ALSO modifies after worktree creation but before merge — the
    // 3-way merge will then conflict.
    writeFileSync(join(gitRoot, 'shared.txt'), 'base\n', 'utf8')
    execSync('git add -A && git commit -m base-shared', { cwd: gitRoot, stdio: 'pipe' })

    // Child writes a non-conflicting change to shared.txt — actually
    // we want a CONFLICT, so we also move the base after worktree
    // creation. We can't easily inject that timing through the public
    // API, so instead the child writes the OPPOSITE line than what we
    // then commit to main before the merge.
    const child = recordingChildEngine('shared.txt', 'child-change\n')
    const tool = new AgentTool({
      factory: child.factory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    // Wrap the factory so we can move the base between worktree-creation
    // and merge — that's the standard way to produce a real conflict.
    const wrappedFactory = (config: EngineConfig) => {
      const engine = child.factory(config)
      const origRunTurn = engine.runTurn.bind(engine)
      engine.runTurn = async () => {
        const r = await origRunTurn()
        // Sub-agent has committed "child-change" to shared.txt in the
        // worktree (via the recordingChildEngine's writeFileSync +
        // commitPendingChangesInWorktree). Now move the BASE so the
        // merge conflicts.
        writeFileSync(join(gitRoot, 'shared.txt'), 'parent-change\n', 'utf8')
        execSync('git add -A && git commit -m parent-move', { cwd: gitRoot, stdio: 'pipe' })
        return r
      }
      return engine
    }

    const tool2 = new AgentTool({
      factory: wrappedFactory,
      parentConfig: baseConfig({ cwd: gitRoot }),
      parentRenderer: fakeRenderer(),
    })

    const out = await tool2.execute(
      { description: 'conflicting edit', prompt: 'edit shared', task_mode: 'modify', verify: false },
      { cwd: gitRoot, permissionMode: 'auto' },
    )

    expect(out.isError).toBe(true)
    const structured = out as typeof out & {
      status?: string
      summary?: string
      conflicts?: string[]
      retryable?: boolean
    }
    expect(structured.status).toBe('blocked')
    expect(structured.summary).toMatch(/delivery blocked/)
    expect(structured.conflicts).toContain('shared.txt')
    expect(structured.retryable).toBe(true)
  })
})
