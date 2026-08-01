# Phase 3 变更记录 — Anthropic 原生 SDK 适配器

> 审计追踪:从 OpenAI 兼容单传输扩到 Anthropic 原生 Messages API。

## 范围

实现 `AnthropicAdapter implements ProviderAdapter`,把 Anthropic Messages API 流式响应翻译为 OpenAI ChatCompletionChunk 形状(让现有 StreamConsumer 不变)。零依赖 — 用 Node 内置 `fetch` + `ReadableStream` 自实现 SSE 解析,绕过 `@anthropic-ai/sdk`。

## 设计决策

**方案 B:fetch 自实现(已选定)** — 不引入新依赖。代价是:
- 需要自己实现 SSE 解析(Anthropic event types)
- 需要自己处理 thinking blocks / prompt caching beta headers
- 需要自己写 message → SSE chunk 翻译

**方案 A(SDK):被否决** — 破坏"5 依赖"约束(ADR-006)。

## 翻译契约

### Request 翻译 (OpenAI ChatCompletion → Anthropic Messages)

| OpenAI | Anthropic |
|---|---|
| `systemPrompt`(顶层 system message) | 顶层 `system` 字段 |
| `messages[]`(role:user/assistant/tool) | `messages[]`(role:user/assistant;tool 合并到 user 的 tool_result 块) |
| `tools[]`(function format) | `tools[]`(input_schema 格式,顶层 `name`/`description`/`input_schema`) |
| `max_tokens` | `max_tokens`(Anthropic 必填) |
| `temperature` | `temperature`(Anthropic 接受) |

### Stream 翻译 (Anthropic SSE → OpenAI ChatCompletionChunk)

| Anthropic event | ChatCompletionChunk |
|---|---|
| `message_start` | 初始化 message metadata |
| `content_block_start {type: 'text'}` | `choices[].delta.content = ''` |
| `content_block_delta {type: 'text_delta', text: '...'}` | `choices[].delta.content += text` |
| `content_block_start {type: 'tool_use'}` | 准备累积 tool_call(id, name) |
| `content_block_delta {type: 'input_json_delta', partial_json: '...'}` | `choices[].delta.tool_calls[].function.arguments += partial` |
| `message_delta {delta: {stop_reason: '...'}}` | `choices[].finish_reason = stop_reason` |
| `message_delta {usage: {output_tokens: N}}` | 累积 usage |
| `message_stop` | 终止流 |

### Beta headers

- `prompt-caching-2024-07-31`:在 system 块 / tool / message 末尾追加 `cache_control: {type: 'ephemeral'}`(本次不实现,留待后续)
- `extended-thinking-2025-...`:thinking 块解析(本次不实现,留待后续)
- 第一次只支持 Messages API 标准 spec

## 新增文件

| 文件 | 职责 |
|---|---|
| `src/core/model/anthropicAdapter.ts` | `AnthropicAdapter implements ProviderAdapter` |
| `src/core/model/anthropicSse.ts` | SSE 解析 + 事件分发 |
| `tests/model/anthropicAdapter.test.ts` | 翻译正确性(单元 + mock fetch) |

## 修改文件

| 文件 | 变更 |
|---|---|
| `src/core/model/providerAdapter.ts` | `createProviderAdapter` factory 增加 `pid === 'anthropic'` 分支 |
| `src/core/model/modelGateway.ts` | 调用前注入 anthropic-version / anthropic-beta headers(由 adapter 自行负责,这里不动) |
| `src/config/settings.ts` | 支持 `provider: 'anthropic'` + `baseURL: 'https://api.anthropic.com'` 默认 |

## 不在 Phase 3 范围

- Extended thinking blocks
- Prompt caching(beta `prompt-caching-2024-07-31`)
- `server-side-fallback-2026-06-01`(跨 provider fallback)
- `task_budget` beta
- 自托管 Anthropic-compatible endpoint(`ANTHROPIC_NATIVE_BASE_URL`)

## 验证

- `npx tsc --noEmit`
- `pnpm lint`
- `npx vitest run`
- **行为验证需用户手动**:配置 `provider: 'anthropic'` + 真实 API key,启动 ovolv999

## 风险

| 风险 | 缓解 |
|---|---|
| SSE 解析 edge cases | 单元测试覆盖正常流 + 异常流 |
| Anthropic API 版本漂移 | 用 `anthropic-version: 2023-06-01` 锁定,失败时显式抛出 |
| 流中断 / 网络错误 | 复用现有 `ModelGatewayError` 与 Provider 熔断器 |
| Thinking blocks 漏处理 | 第一次跳过,后续加 |
