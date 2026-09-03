# Round 2 变更记录 — 收尾与连接

> Phase 1-5 的所有代码已就位但部分未连接进 CLI / Module。这一轮把"库代码"接通到"用户可见入口"。

## 范围

1. **Hook 全部事件接通**:Phase 2 只接通了 PreToolUse / PostToolUse,还差 UserPromptSubmit / SessionStart / PostToolUseFailure
2. **ACP WebSocket CLI 入口**:`--acp-ws 8765` 真实可用
3. **MCP OAuth 接入 McpModule**:OAuth token 自动获取、刷新、过期清理
4. **Anthropic 增强**:thinking blocks + prompt caching(beta headers)
5. **CHANGELOG / README 更新**:5 大特性的对外描述
6. **Provider 扩展占位**:Bedrock / Vertex / Foundry stub(标记为"未接线"等待后续)

## 设计决策

**Hook 全部事件接通**:在 coordinator.ts 的合适位置(`runTurn` 开头 / tool execution 异常分支)调用 `runner.runUserPromptSubmit` / `runner.runSessionStart` / `runner.runPostToolUseFailure`。这些事件在前几轮已经留好接口,本次只是补上线。

**ACP WS CLI 入口**:`bin/ovogogogo.ts` 增加 `--acp-ws` 参数解析,启动 `AcpWebSocketServer` + 创建 `ACPServer` 实例 + `WebSocketACPTransport` 适配。

**MCP OAuth 接入 McpModule**:`McpModule.boot()` 触发 OAuth 流程(若 server 配置有 `oauth`);`McpModule.execute()` 调用 `getValidToken()` 自动附加 `Authorization: Bearer` header。

**Anthropic thinking + caching**:通过 `providerOptions.anthropicBeta` 显式启用,不开启时维持纯 Messages API 兼容(spec 默认行为)。

**Provider stub**:在 `src/core/model/providerAdapter.ts` 的 factory 增加 `bedrock` / `vertex` / `foundry` 分支,throw `Error('Provider not yet wired')` 并在 README 标注"未来版本"。这是诚实的 — claude-code-best 的 v2.8.4 还没完全接好 Bedrock/Vertex(主要是 SDK 依赖),我们更不应假装。

## 新增 / 修改文件

| 文件 | 变更 |
|---|---|
| `src/core/runtime/coordinator.ts` | 调用 `runUserPromptSubmit` / `runSessionStart` / `runPostToolUseFailure` |
| `bin/ovogogogo.ts` | 解析 `--acp-ws <port>` |
| `src/cli/acpServer.ts` | ACP WS 启动逻辑 + CLI 集成 |
| `src/modules/mcp/index.ts` | OAuth flow 接入 boot/execute |
| `src/core/model/anthropicAdapter.ts` | 接受 `providerOptions.anthropicBeta` + `cacheControl` |
| `src/core/model/providerAdapter.ts` | bedrock/vertex/foundry stub |
| `CHANGELOG.md` | 5 项新特性条目 |
| `README.md` | Hook / Tool Search / ACP-WS / OAuth 简介 |
| `src/cli/help.ts` (若存在) | 新增 `--acp-ws` 帮助文本 |

## 不在 Round 2 范围

- Sandbox/Bubble 模式(OS 层隔离,需要后续独立 PR)
- Background sessions / daemon(与现有 BackgroundTaskManager 重叠)
- LSP / IDE Bridge / Voice / Computer-Use(违反零原生约束)
- Plugins / Marketplace(产品外围)
- 真正的 SDK 集成(Bedrock/Vertex 走 STS / service account,工程量大)

## 验证

- `npx tsc --noEmit`
- `pnpm lint`
- `npx vitest run`
- **行为验证需用户手动**(CL州.md 验证哲学)

## 风险

| 风险 | 缓解 |
|---|---|
| McpModule OAuth 改动影响现有 MCP 用户 | OAuth 仅在 server 配置含 `oauth` 字段时触发;无配置走原路径 |
| ACP WS 启动阻塞主进程 | 单独 Node 子进程或异步后台启动,主进程不依赖 |
| provider stub 误导用户 | README 明确标注 "experimental stub" |
| Anthropic beta header 漂移 | pin 到 `2025-01-01` 锁定版本 |
