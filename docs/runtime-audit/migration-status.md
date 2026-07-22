# Migration Status

## Fully Migrated
- **ToolExecutor** — structured fields preserved via `{...raw, content, isError}` (no more `toLegacy()`)
- **Bash** — separate `stdout`/`stderr` fields in all settle() branches
- **ClaudeCodeTool** — runId-keyed operations (capture/wait/send/stop accept `runId`)
- **WorkerAdapter** — `wait(runId)` and `reattach(runId, descriptor)` signatures
- **ModuleManager** — cycle detection throws (no more best-effort boot)
- **Engine.setModel()** — transactional with rollback

## Backward Compatible
- **Legacy content/isError** — still produced alongside structured fields
- **session-keyed operations** — `input.session` still accepted as fallback
- **Model fan-out** — `onModelChanged`/`notifyModelChanged` push preserved alongside `RuntimeModelState`
- **SharedRuntimeState** — old fields unchanged, `modelState` added alongside

## Pending Future Migration (Not Blocking)
- Coordinator reads `config.model` directly → should read `sharedState.modelState.model`
- Critic/Reflection modules hold private `model` copy → should subscribe to `RuntimeModelState`
- UI store (`ui/ink/store.ts`) has independent `setModel` → should subscribe
