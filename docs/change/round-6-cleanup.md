# Round 6 变更记录 — 收尾 + 原则修正

> 用户原则:不删,而是注释。WorkspaceWatcher 库保留代码 + 注释掉接线。

## 范围

### 1. Daemon CLI flag(P0,借鉴 claude-code UX)

**借鉴目标**: claude-code 的 `claude --daemon` / `claude daemon-ps` / `claude daemon-attach <id>`

**实现**:
- `bin/ovogogogo.ts` 加 `--daemon` / `--daemon-ps` / `--daemon-attach <id>` / `--daemon-kill <id>` / `--daemon-stop` 参数解析
- 直接复用已有的 `DaemonServer` / `DaemonClient` 库
- 子命令:`ovolv999 daemon <sub>` 路由(`ps` / `attach` / `kill` / `stop`)

### 2. SessionStore.recordTurn 自动调用(P0)

**现状**: DaemonServer.recordTurn 存在但没调用方
**接入**: 在 DaemonServer.processRequest 的 dispatch 路径里,如果 op 是 'message',在 listener 返回后自动 `appendTurn(sessionId, ...)` — **借鉴 claude-code 的 session 持久化触发时机**

### 3. WorkspaceWatcher 注释(P1,违反"不重复造轮子")

**用户决策**: 不删,改成注释

**实现**:
- 把 `WorkspaceWatcher` 类的 export 改为 `/* R6-roadmap */ export const WorkspaceWatcher = ...`
- 在类顶部加 JSDoc 注释说明:"Roadmap: this watcher uses polling which violates 'no reinventing the wheel'. Consider chokidar or fs.watch before wiring."
- 在 `engineAssembly.ts` 等任何 runtime 接线处加注释(目前没有,但说明这处将来不接)
- 单元测试保留(库级测试有效)

### 4. `<available-deferred-tools>` system-reminder(P2,直接抄)

**借鉴目标**: claude-code 的 system-reminder 块,列出 deferred 工具名让模型知道有这些可用

**实现**:
- `coordinator.ts` 在 llm_call 前,从 ToolRegistry.getDeferCandidates() 取 deferred 工具名
- 如果 > 0,append 一条 `available_deferred_tools` ControlMessageLog 消息
- `formatControlMessage()` 输出 `[runtime control · available_deferred_tools] ...`

### 5. README + 5-Round 借鉴总结(P2)

**新增章节**:
- README.md 增加"Borrowed from claude-code"章节,列出 5 Round 的所有借鉴
- 链接到 `docs/HOOKS.md` / `docs/PERMISSION-MODES.md` / `docs/SANDBOX.md` 等

## 验证

- `npx tsc --noEmit`
- `pnpm lint`
- `npx vitest run`
- **行为验证需用户手动**(尤其 daemon CLI flag)

## 风险

| 风险 | 缓解 |
|---|---|
| Daemon CLI 与现有子命令冲突(`ps` / `attach` / `kill` / `stop` 已被 `--bg` 使用) | 用 `daemon <sub>` 子命令路由,与 `--bg` 解耦 |
| Session record 频繁写盘 | 异步 append,失败仅 log 不抛 |
| WorkspaceWatcher 注释掉后会死代码 | 注释明确说明"Roadmap: not wired" |
| `<available-deferred-tools>` 增加 system prompt 长度 | 只在 deferred > 0 时注入,且每 5 turn 一次(去重) |
