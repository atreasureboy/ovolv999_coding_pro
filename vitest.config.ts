import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/worktrees/**',
      '**/claude-code/**',
      '**/loop-kit/**',
      '**/reference/**',
    ],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Round 42: cap parallel workers — the default (CPU-count) fork pool
    // OOM'd at 4GB heap with the full 320-file suite on this host, killing
    // 10 workers mid-run and reporting phantom failures. 4 workers keep
    // the full suite green without resource lossage.
    maxWorkers: 4,
    minWorkers: 1,
  },
})
