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
  },
})
