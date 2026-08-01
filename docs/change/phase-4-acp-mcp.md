# Phase 4 变更记录 — ACP WebSocket 桥 + MCP OAuth

> 审计追踪:把现有 stdio-only ACP 升级为双 transport(stdio + WebSocket),并补 MCP OAuth。

## 范围

1. **ACP transport 抽象化**:`StdioTransport` 与 `WebSocketTransport` 共用 `ACPTransport` 接口
2. **ACP WebSocket 服务**:`--acp-ws --port 8765`,每个 client 一个独立 ACP 实例
3. **MCP OAuth**:Authorization Code + PKCE 流程,token 持久化,自动 refresh

## 设计决策

**ACP Transport 抽象**:把现有 stdio JSON-RPC 解析抽到 `ACPTransport` 接口(`onMessage` / `send` / `close`),`StdioTransport` 包装现有 readline 代码,`WebSocketTransport` 用 Node 内置 `http.createServer` + `ws` upgrade。

**注意**:`ws` 是否要引入?**否** — `ws` 是 5 个运行时依赖之外的额外包(CLAUDE.md "5 依赖")。改用 Node 自带 `http` + 手写 WebSocket frame 解析(WebSocket 协议本身不复杂,握手 + 文本帧足够覆盖 90% 用例)。

**MCP OAuth 简化**:只支持 OAuth 2.1 Authorization Code + PKCE;不实现 Dynamic Client Registration(避免复杂度)。Token 存 `~/.ovogo/mcp-tokens.json`。

## 新增文件

| 文件 | 职责 |
|---|---|
| `src/integrations/acpTransport.ts` | `ACPTransport` 接口 + `StdioTransport` 包装 |
| `src/integrations/acpWebSocket.ts` | WebSocket 服务 + `WebSocketTransport` |
| `src/integrations/mcpOAuth.ts` | OAuth PKCE flow + token store |
| `tests/integrations/acpTransport.test.ts` | transport 抽象测试 |
| `tests/integrations/acpWebSocket.test.ts` | WebSocket 服务器集成测试(用 raw http client) |
| `tests/integrations/mcpOAuth.test.ts` | PKCE 生成 + token store + refresh 测试(mock fetch) |

## 修改文件

| 文件 | 变更 |
|---|---|
| `src/integrations/acp.ts` | 现有 readline 逻辑包装为 `StdioTransport`;新增 `--acp-ws` 命令行入口 |
| `src/cli/engineAssembly.ts` | 启动时根据 argv 选择 transport |

## 不在 Phase 4 范围

- WebSocket 二进制帧(只支持文本帧)
- mTLS / WSS(暂不支持,后续可加)
- MCP Dynamic Client Registration
- 多 client 共享同一个 engine(每个 client 一个独立 engine 实例)

## 验证

- `npx tsc --noEmit`
- `pnpm lint`
- `npx vitest run`
- **行为验证需用户手动**:启动 `ovolv999 --acp-ws --port 8765`,用任何 WS 客户端连入测试

## 风险

| 风险 | 缓解 |
|---|---|
| WS 服务器耗资源 | 每 client 独立 AbortController,断连立即清理 |
| Token 泄漏 | `~/.ovogo/mcp-tokens.json` 权限 0600,不进 git(`.gitignore`) |
| OAuth redirect_uri 端口冲突 | 默认随机端口 + 用户可指定 `--oauth-port` |
| WebSocket frame 解析 bug | 单元测试覆盖 RFC 6455 最小子集(握手 + 文本帧) |
