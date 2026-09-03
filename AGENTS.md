# AGENTS.md

## Build & Test Commands

- **Typecheck:** `npx tsc --noEmit`
- **Run all tests:** `npx vitest run`
- **Run single test file:** `npx vitest run tests/<file>.test.ts`
- **Run tests in watch mode:** `npx vitest`
- **Build:** `pnpm build`
- **Run the tool:** `ovolv999` (symlink → dist/bin/ovogogogo.js)

## Code Style

- TypeScript strict mode, ESM modules
- No comments unless explicitly requested
- Follow existing patterns in neighboring files
- Test files go in `tests/`, mirrored structure from `src/`

## Architecture

- `src/core/` — engine, types, compact, costTracker, providers, workflow
- `src/tools/` — tool implementations (Bash, Read, Write, Edit, Grep, Glob, Agent, Worktree, etc.)
- `src/commands/` — slash commands
- `src/ui/` — Ink/React REPL + keybindings
- `src/skills/` — skill loader + extractor
- `src/integrations/` — ACP protocol server
- `src/utils/` — shared utilities (clipboard, cleanup, apiError, etc.)
