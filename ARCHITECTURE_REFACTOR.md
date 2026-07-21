# Architecture Refactor — Final Report

## 1. 原架构问题

### 实际发现的问题（非复述任务描述）

**P0: ExecutionEngine 是一个 1806 行的上帝类**

engine.ts 同时承担了 20+ 职责：agent 配置合并、模块启动、system prompt 构建、模型调用、streaming 解析、上下文预算评估、上下文压缩、tool definition 过滤、tool 调度、tool 执行、权限检查、plan mode 管理、hook 管理、后台任务、文件历史、成本统计、abort 控制、query 状态机驱动、run 完成和异常处理。

**P1: 状态来源分散（12 处重复状态）**

以下状态在 engine.ts 中维护，同时部分在其他模块也有影子副本：
- `planModeActive` — engine 私有字段，tools 通过回调间接修改
- `currentTurnAbortController` — engine 私有字段
- `softAbortRequested` / `softAbortOwner` — engine 私有字段
- `systemPromptTokens` — engine 私有字段，ContextManager 也需要
- `lastAssistantTs` — engine 私有字段，compact 时间门控需要
- `_consecutiveCompactFailures` — engine 私有字段
- `_streamUsageSupported` — engine 私有字段，stream_options 兼容性
- `moduleBootResults` — engine 私有字段
- `allTools` — engine 私有字段

**P2: 控制逻辑重复（5 处）**

- Plan mode 检查在 `getToolDefinitions`（exposure）和 `executeToolCall`（execution）中各做一次，逻辑不同步
- Sub-agent 工具白名单过滤在两个路径中各做一次
- Tool result truncation 在多处内联实现
- Module 遍历在 5 处手动迭代（boot / iteration / tool call / complete / dispose）
- "是否继续下一轮"逻辑分散在 check_abort handler + state machine reducer + continuation_check

**P3: 死代码（~1400 行）**

- `concurrency.ts`（65 行）— 零生产导入
- `autoCompact.ts`（321 行）— 与 ContextManager 的压缩逻辑分叉（阈值 0.92 vs 0.85）
- 5 个死 Tool 类（Brief / CtxInspect / TerminalCapture / WebBrowser / PushNotification）— 导入导出但从不实例化
- `checkCommandPermission` 函数 — 零生产调用
- `runtime/types.ts` 中的 RunState/RunEvent/子系统接口（282 行）— Phase 1 的设计草图，从未接线

---

## 2. 最终架构

### 主要目录结构

```
src/core/
├── engine.ts                        # 薄门面 (299 行) — 组装 + 委托
├── runtime/
│   ├── coordinator.ts               # 主循环驱动 (448 行)
│   ├── boot.ts                      # 启动序列 (178 行)
│   ├── events.ts                    # RunEvent 类型化协议 + Emitter (101 行)
│   ├── sharedState.ts               # 跨 turn 共享状态 + 活跃追踪 (51 行)
│   └── terminationPolicy.ts         # 终止决策纯函数 (35 行)
│   ├── sharedState.ts               # 跨 turn 共享状态 (32 行)
│   └── terminationPolicy.ts         # 终止决策纯函数 (35 行)
├── model/
│   ├── modelGateway.ts              # LLM API 调用 (165 行)
│   └── streamConsumer.ts            # 流解析 + tool_call 累积 (181 行)
├── context/
│   ├── contextManager.ts            # budget + compaction (274 行)
│   └── toolResultBudget.ts          # truncate + aggregate (93 行)
├── toolRuntime/
│   ├── toolRegistry.ts               # 注册 + 查找 + 重名检测 (78 行)
│   ├── toolPolicy.ts                 # exposure + execution policy (107 行)
│   ├── toolExecutor.ts               # 单次 tool 执行 + hooks + 截断 (144 行)
│   └── toolScheduler.ts              # partition + batch 调度 (209 行)
├── moduleRuntime/
│   └── moduleManager.ts             # 模块生命周期 (145 行)
├── queryStateMachine.ts             # 纯 reducer 状态机 (253 行，未改动)
├── compact.ts                       # 压缩算法 (ContextManager 调用)
├── types.ts                         # EngineConfig, Tool, ToolContext 等
└── ... (其他基础设施模块)
```

### 核心组件与状态所有权

| 组件 | 职责 | 拥有的状态 |
|------|------|-----------|
| **ExecutionEngine** | 组装子系统，公开生命周期 API | `_turnInFlight`（重入保护） |
| **RuntimeCoordinator** | 驱动 Think→Act→Observe 循环 + 派发 RunEvent | per-turn 局部变量（loop vars, retry counters） |
| **boot()** | 启动序列（模块 boot → 注册工具 → 构建 prompt/defs/context） | 无（纯函数） |
| **RunEventEmitter** | 类型化内部事件协议 pub/sub | `handlers` 映射表 |
| **SharedRuntimeState** | 跨 turn 共享的可变状态 | `planModeActive`, `currentTurnAbortController`, `softAbortRequested/Owner`, `allTools`, `activeToolCalls`, `activeSubtasks` |
| **ModelGateway** | LLM API 调用 + stream_options 兼容 | `_streamUsageSupported` |
| **StreamConsumer** | 流解析 + thinking 分离 + tool_call 累积 | 无持久状态（per-call） |
| **ContextManager** | token 估算 + budget 评估 + compaction | `systemPromptTokens`, `lastAssistantTs`, `consecutiveCompactFailures`, `suppressCompactWarning`, `resolvedContextWindow`, `pendingSnipCount` |
| **ToolRegistry** | 工具注册 + 查找 + 重名冲突检测 | `tools: Map<string, Tool>` |
| **ToolPolicy** | 统一 exposure（模型可见）+ execution（运行时允许）policy | 无持久状态（纯函数） |
| **ToolScheduler** | partitionToolCalls + parallel/serial batch + aggregate budget | 无持久状态（活跃追踪写入 SharedRuntimeState） |
| **ToolExecutor** | 单次 tool 执行（policy + permission + hooks + 截断 + notify） | 无持久状态 |
| **ModuleManager** | 模块 boot/iteration/toolCall/complete/dispose | `modules[]`, `bootResults[]` |
| **TerminationPolicy** | 纯函数终止决策 | 无状态 |
| **QueryStateMachine** | 纯 reducer 状态转换 | 无状态 |

### 依赖方向

```
CLI / UI
   ↓
ExecutionEngine (facade)
   ↓
RuntimeCoordinator
   ↓
ModelGateway · ContextManager · ToolScheduler · ModuleManager
   ↓
基础类型 · 存储 · 外部适配器
```

**禁止的依赖方向**（均已验证）：
- model 层不依赖 engine ✓
- tool 层不依赖 UI 实现 ✓
- context 层不直接控制运行循环 ✓
- module 层不直接修改 engine 私有状态 ✓
- coordinator 不依赖具体 Bash/Read/Memory Tool 类 ✓

### 一次完整 Turn 的调用流程

```
engine.runTurn(userMessage, history, images)
  └─ coordinator.run(userMessage, history, images)
       ├─ moduleManager.boot(bootCtx)
       │    └─ → systemPromptSections, tools, toolContextPatch
       ├─ buildSystemPrompt(planMode, moduleSections)
       ├─ contextManager.beginTurn(systemPrompt)
       ├─ toolPolicy.getExposedDefinitions(allTools, planMode)
       ├─ buildToolContext(signal, patches, sharedState)
       │
       ├─ while (!isTerminal(state)):
       │    ├─ check_abort → TerminationPolicy.checkTermination()
       │    │    → hard_abort / soft_abort / max_iterations / continue
       │    ├─ budget_check → contextManager.evaluateBudget()
       │    │    → snipCompact (50%) / warn (70%) / autoCompact (85%)
       │    ├─ module_iteration → moduleManager.runIteration()
       │    │    → critic 注入纠错消息
       │    ├─ llm_call → modelGateway.call()
       │    │    ├─ StreamConsumer.consume()
       │    │    ├─ onUsage → costTracker.addUsage()
       │    │    └─ onContextOverflow → contextManager.reactiveCompact()
       │    ├─ continuation_check → checkTokenBudget()
       │    ├─ parse_response → JSON 验证 + malformed-args 处理
       │    └─ tool_execution → toolScheduler.schedule()
       │         ├─ partitionToolCalls() → parallel(safe) / serial(stateful)
       │         ├─ toolExecutor.execute() → policy + permission + execute
       │         │    └─ moduleManager.notifyToolCall()
       │         └─ enforceAggregateBudget()
       │
       ├─ finally: 清理 abort controller + soft-abort ownership
       ├─ moduleManager.runComplete()
       │    → reflection 模块 LLM 知识提取
       └─ hooks: OnComplete / OnError
```

---

## 3. 迁移内容

### 新增文件 (14)

| 文件 | 行数 | 来源 |
|------|------|------|
| `src/core/runtime/coordinator.ts` | 509 | engine.ts runTurn 主循环 |
| `src/core/runtime/sharedState.ts` | 32 | engine.ts 私有字段提取 |
| `src/core/runtime/terminationPolicy.ts` | 35 | engine.ts check_abort handler |
| `src/core/model/modelGateway.ts` | 165 | engine.ts callLLM 方法 |
| `src/core/model/streamConsumer.ts` | 181 | engine.ts consumeStream 方法 |
| `src/core/context/contextManager.ts` | 274 | engine.ts 6 个 context 方法 + 6 个字段 |
| `src/core/context/toolResultBudget.ts` | 93 | engine.ts truncateToolResult |
| `src/core/toolRuntime/toolPolicy.ts` | 107 | engine.ts getToolDefinitions + executeToolCall policy |
| `src/core/toolRuntime/toolExecutor.ts` | 103 | engine.ts executeToolCall |
| `src/core/toolRuntime/toolScheduler.ts` | 201 | engine.ts scheduleToolCalls + partitionToolCalls |
| `src/core/moduleRuntime/moduleManager.ts` | 145 | engine.ts 5 处 module 遍历 |

### 删除文件 (9)

| 文件 | 行数 | 原因 |
|------|------|------|
| `src/core/concurrency.ts` | 65 | 零生产导入 |
| `src/core/autoCompact.ts` | 321 | 与 ContextManager 分叉，未接入 |
| `src/core/runtime/types.ts` | 282 | Phase 1 设计草图，从未接线（StreamResult 移至 streamConsumer.ts） |
| `src/tools/brief.ts` | 106 | 导入但从不实例化 |
| `src/tools/ctxInspect.ts` | 194 | 同上 |
| `src/tools/terminalCapture.ts` | 136 | 同上 |
| `src/tools/webBrowser.ts` | 322 | 同上 |
| `src/tools/pushNotification.ts` | 179 | 同上 |
| `tests/concurrency.test.ts` + `tests/autoCompact.test.ts` + `tests/newTools.test.ts` | 813 | 对应死代码的测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/core/engine.ts` | 1806 → 273 行（-85%），成为薄门面 |
| `src/core/riskClassifier.ts` | 删除 `checkCommandPermission` 函数（零调用） |
| `src/tools/index.ts` | 删除 5 个死 Tool 类的导入/导出 |
| `tests/engine.test.ts` | partitionToolCalls 导入路径更新 |
| `tests/runtimeFixes.test.ts` | partitionToolCalls 导入路径 + moduleManager 访问更新 |
| `tests/riskClassifier.test.ts` | 删除 checkCommandPermission 的 6 个测试 |
| `README.md` | 架构图 + 统计 + 目录树全面更新 |

---

## 4. 行为兼容

### 保持不变的行为

- **CLI 使用方式** — `ovolv999` 命令不变
- **Engine 公开 API** — `runTurn()`, `abort()`, `softAbort()`, `dispose()`, `getModel()`, `setModel()`, `getCostTracker()`, `getBackgroundTaskManager()`, `getPermissionManager()`, `isPlanMode()`, `getConfig()`, `exitPlanMode()`, `enterPlanMode()`, `queueSnip()`, `getFileHistory()`, `getToolRegistry()`, `getEventEmitter()`, `getSharedState()` 全部可用
- **AgentConfig / Module API / Tool API / Renderer API / Hook 行为** — 未改动
- **Plan Mode 行为** — `planModeActive` 现在在 SharedRuntimeState 中，但行为完全一致（ExitPlanMode/EnterPlanMode 通过 ToolContext 回调修改）
- **Permission 行为** — ToolExecutor 仍使用 PermissionManager + riskClassifier
- **Streaming 展示** — StreamConsumer 的 thinking 分离 + text 聚合 + tool_call 累积不变
- **后台任务 / 子 Agent / MCP / LSP / SSH / Memory / FileHistory / CostTracker / EventLog** — 未改动

### 内部调整

- `partitionToolCalls` 不再从 `engine.ts` 导出 — 测试导入路径更新为 `toolRuntime/toolScheduler.js`
- `engine.modules` 变为 `engine.moduleManager.modules` — boot-throw 回归测试更新
- `ToolExecutor` 不再直接持有 `modules: AgentModule[]`，改为接收 `notifyToolCall` 回调

---

## 5. 验证结果

```bash
# 类型检查
$ npx tsc --noEmit
(clean — no output)

# 构建
$ npm run build
(clean — tsc compiles with no errors)

# 全部测试
$ npx vitest run
Test Files  138 passed (138)
     Tests  3339 passed (3339)
    Errors  1 error   (pre-existing lspClient.test.ts ENOENT — spawn /nonexistent/server-binary)

# Lint (重构文件)
$ npm run lint  (refactored files: 0 errors)
```

**Engine 大小轨迹**:
```
Phase 0 (原始):    1806 行
Phase 2 (Model):   1581 行  (-225)
Phase 3 (Context): 1197 行  (-384)
Phase 4 (Tool):     918 行  (-279)
Phase 5 (Module):   886 行  (-32)
Phase 6 (Coord):    273 行  (-613)
Gap 补齐后:         299 行  (+26 — 新增 ToolRegistry/EventEmitter 接线)
总计减少:           1507 行  (-83%)
```

**测试轨迹**:
```
Phase 0-6:  3424 tests / 139 files (全部通过，无增减)
Phase 7:    3329 tests / 136 files (删除 95 个死代码测试 + 3 个死测试文件)
Gap 补齐:   3339 tests / 138 files (+10 新测试: ToolRegistry + RunEventEmitter)
```

---

## 6. 未解决问题

1. **`LEGACY_PLAN_MODE_TOOLS` 和 `LEGACY_CONCURRENCY_SAFE_TOOLS` 仍作为回退保留** — 所有生产工具已通过 metadata 声明 `readOnly` 和 `concurrencySafe`，但回退常量仍保留作为防御性编程。移除需要更新 `engine.test.ts` 中的 `partitionToolCalls` 测试（它们不传 tool 实例，依赖回退）。

2. **`ToolMetadata.mutatesState / longRunning / requiresNetwork` 字段被设置但从未被生产代码读取** — 仅作为工具特征文档存在。20+ 个工具文件设置了这些字段，但 ToolPolicy 和 ToolScheduler 只消费 `readOnly` 和 `concurrencySafe`。

3. **`ToolContext.permissionManager` 字段被填充但从未被任何工具读取** — ToolExecutor 使用自己的 `deps.permissionManager`，不通过 context。可以移除但属于 ToolContext 接口变更。

4. **`loopEngine.ts`（212 行）仍通过 `bin/ovogogogo.ts` 的 `await import()` 延迟加载** — 这是一个多轮自治编排器（WAKE→SCAN→PLAN→DO→REVIEW），调用 `engine.runTurn()` 作为原语。不是竞争性主循环，而是更高层抽象。未在本轮重构范围内。

5. **RunEvent 已建立但消费者尚未迁移** — 当前 EventLog/Renderer/Hooks 仍通过各自的直接调用路径工作（`eventLog.append()`, `renderer.toolStart()` 等）。RunEventEmitter 已作为并行协议存在，但现有消费者尚未从直接调用迁移到订阅模式。这是一个渐进迁移路径，不破坏当前行为。

---

## 7. 后续建议

1. **消费者迁移到 RunEvent 订阅** — 将 EventLog/Renderer/Hooks 的直接调用路径逐步替换为 `.on(type, handler)` 订阅。Coordinator 最终只需 emit 事件，不再直接调用 renderer/eventLog。当前直接调用作为兼容层保留。

2. **RunState 统一模型** — QueryState + SharedRuntimeState 已覆盖大部分运行时状态，但 `activeToolCalls` 和 `activeSubtasks` 追踪尚未被任何消费者读取。未来调试器/可视化工具可通过 `engine.getSharedState().activeToolCalls` 实时查看执行状态。

3. **清理 ToolMetadata 未使用字段** — `mutatesState`、`longRunning`、`requiresNetwork` 要么在 ToolPolicy/riskClassifier 中消费，要么从接口中移除。

4. **动态工具注册** — 当前 ToolRegistry 在 boot 时一次性注册所有工具。如果未来需要运行时热加载/卸载工具（如 MCP server 连接/断开），ToolRegistry 已有 `register()`/`reset()` 接口支持。

5. **Provider 兼容性提取** — ModelGateway 中的 `stream_options.include_usage` 检测 + fallback 逻辑可提取为独立的 `providerCompatibility.ts`，当 provider 差异增多时。当前内联在 ModelGateway 中，覆盖单一兼容点。
