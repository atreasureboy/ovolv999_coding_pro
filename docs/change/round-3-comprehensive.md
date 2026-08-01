# Round 3 变更记录 — 全面借鉴(权限/Sandbox/Daemon/LSP)

> 用户目标"全面借鉴"。重新审视 `docs/comparison/claude-code-vs-ovolv999.md`,选出 4 个我们差距最大 / claude-code 做得最好的方向。

## 范围

### 1. Permission Modes(7 种)

**当前**: 只有 2 种(`default` 隐式 + `plan` 显式)
**借鉴后**: claude-code 7 种(`default` / `acceptEdits` / `bypassPermissions` / `dontAsk` / `plan` / `auto` / `bubble`)

| Mode | 行为 |
|---|---|
| `default` | 每个工具调用前 ask(当前 default 隐式行为) |
| `acceptEdits` | Edit/Write 自动允许,其他 ask |
| `bypassPermissions` | 全部允许,仅 hook 拦截 |
| `dontAsk` | 不 ask,模型自律 + hook 兜底 |
| `plan` | 只允许只读工具(已有,Phase 0 即此) |
| `auto` | 模型自律 + 危险命令 ask(类似当前 `auto`) |
| `bubble` | shell 命令在沙箱内执行 |

**实现**:`src/core/permissionSystem.ts` 增加 `PermissionMode` 7 选项 + 模式切换 CLI 命令 `/mode`

### 2. Sandbox / Bubble 模式

**当前**: 无 shell 沙箱
**借鉴后**: shell 命令在 OS 层沙箱执行

- macOS: `sandbox-exec`(内置)
- Linux: Landlock(seccomp 替代品,内核原生)
- Windows: 暂不支持(限制说明)

**入口**:`--permission-mode bubble` 或 `/mode bubble`

**实现**:`src/core/shellSandbox.ts` — 启动 sandbox-exec / Landlock wrapper,拦截 Bash 工具的 execute

### 3. Daemon 模式(长会话监督)

**当前**: `--bg` 只是 BackgroundTaskManager 进程内队列
**借鉴后**: 真正长驻 supervisor,引擎在两次 turn 之间不退出,会话持久化

**入口**:`--daemon --socket ~/.ovolv999/daemon.sock` + `ovolv999 --attach <session-id>`

**架构**:
- Daemon 进程:管理多个 session,监听 IPC socket
- Session:每个 session 一个独立 engine 实例 + 转 JSONL 持久化
- Attach 协议:stdin/stdout over IPC,支持 `ovolv999 --attach <id>` 重新接回会话

**实现**:
- `src/core/daemon/daemonServer.ts`
- `src/core/daemon/daemonClient.ts`
- `src/core/daemon/sessionManager.ts`

### 4. LSP 集成

**当前**: 无 LSP 客户端
**借鉴后**: `LspTool` —— 列出工具定义,LLM 调用即可跳转定义 / 找引用 / hover

**架构**:
- `src/core/lsp/client.ts` — JSON-RPC 2.0 over stdio / TCP / Unix socket 客户端
- `src/core/lsp/protocol.ts` — LSP 类型最小子集
- `src/tools/lspTool.ts` — 暴露给 LLM 的 4 个方法:`definition` / `references` / `hover` / `documentSymbol`

**使用**:`~/.ovogo/settings.json` 配置 LSP server,LLM 自动发现

## 不在 Round 3 范围(留给后续)

- 真正的 Anthropic SDK / Bedrock / Vertex / Foundry SDK(零依赖约束下不值得)
- Marketplace / Plugins(产品外围,工程量极大)
- Skills marketplace / auto-improvement(产品外围)
- SSH 远程会话(需要完整的 SSH 客户端)
- Voice / Computer-Use(违反零原生约束)
- WSS / WebSocket TLS(单独 issue)

## 验证

- `npx tsc --noEmit`
- `pnpm lint`
- `npx vitest run`
- **行为验证需用户手动**(CLAUDE.md 验证哲学)

## 风险

| 风险 | 缓解 |
|---|---|
| Sandbox 在不同 OS 上行为差异 | macOS / Linux 分支 + 失败时降级到默认模式 |
| Daemon 锁文件冲突 | 启动时检查 + 启动失败退避 |
| LSP server 启动慢 | 异步初始化,失败时 tool 不可用而非崩溃 |
| Permission mode 误用 | 启动时打印当前 mode + 警告危险 mode |
