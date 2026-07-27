# Contributing

## Development setup

Use Node.js 20 or newer.

```bash
npm ci
npm run build
```

## Required checks

Before opening a pull request, run:

```bash
npm run typecheck
npm run lint
npm test
npm run eval:deterministic
npm run build
```

Add focused Vitest coverage for every behavior change. Keep TypeScript in strict ESM mode, follow neighboring patterns, and place tests under `tests/`.

## Pull requests

Keep changes scoped, explain the affected runtime call chain, and include actual verification results. Do not weaken assertions or mark capabilities complete before they are connected to the production execution path.

