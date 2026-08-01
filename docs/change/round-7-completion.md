# Round 7 变更记录 — 剩余借鉴补全

> 用户原则:继续借鉴。这次聚焦不破 5 依赖约束的剩余模块。

## 范围

### 1. bubblewrap (bwrap) Linux fallback

**借鉴目标**: claude-code 的 Linux sandbox fallback(优先 Landlock,bwrap 作为 fallback)

**现状**: `shellSandbox.ts` 只有 macOS sandbox-exec 和 Landlock helper 两路

**实现**: `src/core/shellSandbox.ts` 增加 `bubblewrapArgs(workdir)` 生成 bwrap 命令行,spawn `bwrap --unshare-net --ro-bind /usr ... -- <command>`;Linux 上若 Landlock helper 不可用,降级到 bwrap

### 2. WorkspaceWatcher: polling → fs.watch

**修正 R6 注释**: 原 polling 自创违反"不重复造轮子"。改为 Node 原生 `fs.watch`(递归用 `fs.watch(dir, { recursive: true })` on macOS/Windows,逐个目录 watch on Linux)。

**修改**:
- `src/core/workspaceWatcher.ts` 把 setInterval 替换为 fs.watch
- 重新启用 boot 时接线(原先 R6 注释为不接,现在 native 方案可接)

### 3. Hook 事件扩展

**借鉴目标**: claude-code 的 27 种 hook 事件

**当前**: 我们有 9 种(PreToolUse / PostToolUse / PostToolUseFailure / UserPromptSubmit / SessionStart / SessionEnd / Stop / PreCompact / PostCompact)

**实现**: 确认全部 9 种都被 coordinator 触发(SessionStart / SessionEnd / Stop / PreCompact / PostCompact 之前未触发)

### 4. Skill marketplace pattern

**借鉴目标**: claude-code 的 `bundledSkills` + `userSkills` + `projectSkills` 三层加载

**现状**: `src/skills/loader.ts` 只支持 builtin + global + project,**没有 marketplace bundling**

**实现**: `skills/marketplace.ts`(新)— 扫描 `~/.ovogo/skills/marketplace/<name>/SKILL.md` 目录,加载 SKILL.md 作为只读 skill(不写 marketplace UI,只加 loader)

## 验证

- `npx tsc --noEmit`
- `pnpm lint`
- `npx vitest run`

## 不在 Round 7 范围(违反约束)

- `@anthropic-ai/sdk` 真集成(破 5 依赖)— 留 Round 8 等用户决策
- Voice / Computer-Use / IDE Bridge / SSH(产品外围)
- Cloud Artifacts / Marketplace UI(非核心)
- 真 Provider SDK 集成 Bedrock/Vertex/Foundry(需要 STS / Workload Identity)

## 风险

| 风险 | 缓解 |
|---|---|
| bwrap 不存在导致 warning 噪音 | detect 阶段只 log 一次 |
| fs.watch 递归问题(Linux 限制) | Linux 上逐个目录 watch,macOS/Windows 用 recursive |
| Hook 触发频率过高 | SessionStart / SessionEnd 各触发一次 |
| Skill marketplace 路径混淆 | 严格 marketplace/ 前缀,与 user/project 完全分开 |
