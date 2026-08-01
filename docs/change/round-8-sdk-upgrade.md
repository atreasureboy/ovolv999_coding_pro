# Round 8 变更记录 — SDK 升级(消除自创代码)

> 用户决策:升级依赖上限(5→8),接入 3 个成熟 npm 包消除自创代码。
> 原则:不重复造轮子 — 自实现的 SSE parser / JSON-RPC 2.0 / 文件监听 都不是我们的核心竞争力,换成成熟包。

## 范围

### 1. `@anthropic-ai/sdk` 替换自实现 Anthropic SSE

**现状**: `src/core/model/anthropicSse.ts` (~340 行)+ `src/core/model/anthropicAdapter.ts` (~190 行) 手写 SSE parser + chunk translator

**替换**: 接入 `@anthropic-ai/sdk`,adapter 直接调用 SDK 的 `client.messages.stream()`,翻译 SDK 事件到 OpenAI ChatCompletionChunk

**新依赖**: `@anthropic-ai/sdk`(从 0→1)

**收益**:
- 删除 ~530 行自实现代码
- 自动支持所有 beta header(thinking / prompt caching / task_budget)
- 官方维护

**保留**:
- adapter 的 OpenAI ChatCompletionChunk 输出形状(StreamConsumer 不变)
- providerOptions.anthropicBeta / cacheSystem / cacheTools / thinkingBudget(可改为直接传 SDK options)
- factory 分支(`provider: 'anthropic'`)

### 2. `chokidar` 替换 fs.watch polling/recursion

**现状**: `src/core/workspaceWatcher.ts` (~200 行) Node 原生 fs.watch + 递归 attach + debounce

**替换**: 用 chokidar 的 `watch()` 跨平台监听 + `add()` 动态增目录

**新依赖**: `chokidar`(从 0→1)

**收益**:
- 跨平台一致性(macOS FSEvents / Linux inotify / Windows ReadDirectoryChangesW)
- 真正的 recursive watch(我们之前需手写递归)
- 内置 debounce

**保留**:
- 公开 API(`WorkspaceWatcher` 类 + `setOnChange` + `start/stop/isRunning/getWatchedDirCount`)
- R7 的扩展名 / ignore / debounce 选项

### 3. `vscode-jsonrpc` 替换自实现 JSON-RPC 2.0 stdio

**现状**: `src/core/lsp/client.ts` (~210 行) 手写 Content-Length framing + request/response correlation + timeout

**替换**: 用 vscode-jsonrpc 的 `createMessageConnection(stream, stream)`,自动处理 framing + ID correlation + cancellation

**新依赖**: `vscode-jsonrpc`(从 0→1)

**收益**:
- 删除自实现 Content-Length parsing
- 自动 correlation + cancellation
- 与 vscode-lsp-* 系列兼容

**保留**:
- `LspClient` 公开 API(`start` / `definition` / `references` / `hover` / `documentSymbols` / `stop`)
- `pathToFileUri` helper

## 不在 Round 8 范围

- 真接入 `@aws-sdk/client-bedrock` / `@google-cloud/vertexai` / `@azure/ai-projects`(需要 STS / Workload Identity / Azure AD,工程量大,留给 Round 9+)
- Marketplace UI(产品外围)

## 验证

- `npx tsc --noEmit`
- `pnpm lint`
- `npx vitest run`
- **行为验证需用户手动**(Anthropic SDK 真实调用需 API key,LSP 需 typescript-language-server 安装,chokidar 真实文件事件)

## 风险

| 风险 | 缓解 |
|---|---|
| 依赖升级后装包失败(网络 / lockfile) | 先 `npm install`,失败则回退 |
| `@anthropic-ai/sdk` 大(2MB+) | 接受 — 用户已决定升级 |
| chokidar 在 Linux 容器内行为差异 | 测试已用 chokidar 默认 polling fallback |
| `vscode-jsonrpc` API 风格不同 | 包装一层,保持 LspClient 公开 API 不变 |
