# Round 5 变更记录 — 真实接入修补(从表面 → 真接)

> 用户指出 Round 1-4 的若干模块是"表面接入"。本轮把 P0 的 4 项从库级接通到运行时流程。

## 范围(全部 P0)

### 1. Sandbox/Bubble 模式真实接入

**现状**: `permissionMode === 'bubble'` 时 `isSandboxMode()` 返回 true,但 **Bash 工具执行时从不调用 shellSandbox**

**接入**: 在 `src/tools/bash.ts` 的 execute() 开头检查 ToolContext 中的 permissionMode,若为 'bubble',在 macOS 上用 `macOSSandboxExecArgv` 包 argv,在 Linux 上 spawn `ovolv999-sandbox-helper`,然后执行

### 2. Permission mode 门控真实接入

**现状**: ToolExecutor.execute() 只用 `permissionManager.check()`,**不读 `permissionMode`**;7 个 mode 形同虚设

**接入**: ToolContext 增加 `permissionMode` 字段;在 ToolExecutor 决策前读 mode:
- `plan` → 只读
- `acceptEdits` → Edit/Write/NotebookEdit 不 ask
- `auto` → 全部 allow,只有 dangerous ask
- `bypassPermissions` → 全部 allow
- `dontAsk` → 全部 allow,无 prompt
- `bubble` → 同 default + shell sandbox
- `default` → 当前行为

### 3. Hook additionalContext 真实接入

**现状**: `context.hookContext` 收集但**永不传给 LLM**

**接入**: ToolExecutor 在 tool 完成 + hook outcome 触发后,把 hookContext 写入 `ControlMessageLog`(`hook_additional_context` 类型已在 Phase 2 注册),下次 LLM call 的 `renderForProvider()` 携带后立即 clear

### 4. LSP 工具暴露

**现状**: `LspClient` 库完整但**根本无 tool**

**接入**: 新建 `src/tools/lspTool.ts`,将 `definition` / `references` / `hover` / `documentSymbol` 暴露为 4 个 LLM-callable 方法,LSP server 配置从 `~/.ovogo/settings.json` `lsp.servers` 读取,首次调用时 lazy spawn server

## 不在 Round 5 范围(留给 Round 6)

- P1: WorkspaceWatcher 接入 boot
- P1: Daemon CLI flag(`--daemon` / `--daemon-ps` / `--daemon-attach`)
- P1: Session auto-record
- P2: `<available-deferred-tools>` 提醒
- P2: MCP OAuth PKCE browser flow
- P2: ACP WS session 连续性

## 验证

- `npx tsc --noEmit`
- `pnpm lint`
- `npx vitest run`
- **行为验证需用户手动**(每项都是接进运行时流程)

## 风险

| 风险 | 缓解 |
|---|---|
| Sandbox 改变 Bash 输出格式(沙箱错误 vs 应用错误) | 解析 stderr 区分 `EPERM`/`EACCES` 并加 `[sandbox-blocked]` 前缀 |
| Permission mode 决策与用户已有规则冲突 | mode 只是第一道闸,permissionRules 仍生效 |
| Hook additionalContext 注入错误位置 | 仅在工具调用完成后注入,不影响 tool result 本身 |
| LSP 工具调用超时影响整体 turn | 30s LSP timeout,失败返回"lsp unavailable" |
