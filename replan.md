# Ovolv999 Runtime 架构级重构

当前目标：

对当前 `ovolv999_coding` 项目进行一次完整的架构级重构。

这不是功能开发任务，也不是简单地拆分大文件。目标是解决当前核心运行时职责过度集中、状态来源分散、控制语义重复、模块耦合过深的问题，使项目从“功能堆叠的 Claude Code 仿制品”演进为一个边界清晰、状态统一、可扩展、可维护的 Agent Runtime。

你必须直接阅读、分析并修改当前仓库，不要只输出建议或设计方案。

---

## 一、本轮范围

本轮只处理架构优化。

暂时不要建设以下内容：

* 不建设新的 eval/benchmark 框架
* 不准备真实编码任务评测集
* 不增加新的 Agent 功能
* 不增加新的工具和斜杠命令
* 不重新设计 UI
* 不大规模修改记忆系统算法
* 不以“对标 Claude Code 新功能”为目标
* 不删除当前已有功能

可以运行现有测试、类型检查、构建和 lint，以确保架构重构没有破坏现有行为。

不要为了让测试通过而降低测试强度、删除测试、跳过测试或者用大量 mock 掩盖架构问题。

---

## 二、核心问题

重点审计并解决以下问题：

### 1. ExecutionEngine 职责过多

当前 Engine 同时涉及：

* Agent 配置合并
* Module 启动及生命周期
* System Prompt 构建
* 模型调用
* Provider 兼容
* Streaming 解析
* 上下文预算
* 上下文压缩
* Tool Definition 过滤
* Tool 调度
* Tool 执行
* 权限检查
* Plan Mode
* Hook
* 后台任务
* 文件历史
* 成本统计
* Abort
* Query 状态
* Run 完成和异常处理

需要把具体执行能力从 Engine 中剥离。

最终 Engine 应当主要作为：

* 向后兼容入口
* Runtime 组装入口
* 对外生命周期接口
* 高层调用门面

Engine 不应继续亲自实现模型、上下文、工具、模块等子系统的具体逻辑。

### 2. 运行状态缺少唯一真相源

检查以下模块是否分别维护了相互重叠的状态：

* ExecutionEngine
* queryStateMachine
* loop engine
* Agent/Worker
* BackgroundTask
* Plan Mode
* Goal/Workflow
* AbortController
* 上下文预算状态
* iteration 状态
* completion 状态

建立统一的 `RunState` 或等价模型。

至少明确以下状态的唯一所有者：

* 当前运行阶段
* 当前 iteration
* 当前消息上下文
* 当前 Plan Mode
* 当前预算
* 当前 Abort 状态
* 当前活跃 Tool Call
* 当前子任务
* 当前完成/失败原因
* 当前运行结果

其他模块不能私自维护另一套相同语义的状态。

### 3. 控制逻辑重复

查找多个模块中重复存在的：

* 是否继续下一轮
* 是否结束
* 是否允许工具
* 是否进入或退出 Plan Mode
* 是否触发压缩
* 是否认为任务完成
* 是否取消当前操作
* 是否重试请求

这些语义需要拥有明确的权威实现。

注意：

权限白名单、工具暴露过滤和执行时权限复查属于纵深防御，不应因为“去重”而删除执行时复查。

---

## 三、目标架构

先根据实际代码审计再确定最终文件名，但整体职责应接近以下结构：

```text
src/core/
├── runtime/
│   ├── coordinator.ts
│   ├── state.ts
│   ├── events.ts
│   ├── reducer.ts
│   ├── boot.ts
│   ├── lifecycle.ts
│   └── terminationPolicy.ts
│
├── model/
│   ├── modelGateway.ts
│   ├── streamConsumer.ts
│   ├── providerCompatibility.ts
│   └── modelTypes.ts
│
├── context/
│   ├── contextManager.ts
│   ├── contextBudget.ts
│   ├── compactionService.ts
│   └── toolResultBudget.ts
│
├── toolRuntime/
│   ├── toolRegistry.ts
│   ├── toolPolicy.ts
│   ├── toolScheduler.ts
│   ├── toolExecutor.ts
│   └── toolRuntimeTypes.ts
│
├── moduleRuntime/
│   ├── moduleManager.ts
│   ├── moduleLifecycle.ts
│   └── moduleTypes.ts
│
└── engine.ts
```

这只是职责参考，不要机械照搬。

如果仓库已有对应模块，应当复用、迁移或升级已有实现，不要创建一套与旧系统并行的新框架。

---

## 四、统一运行时模型

### RunState

设计一个明确的运行状态结构，例如：

```ts
interface RunState {
  runId: string
  phase: RunPhase
  iteration: number

  messages: OpenAIMessage[]

  planMode: {
    active: boolean
    verificationRequired: boolean
  }

  budget: {
    inputTokens: number
    outputTokens: number
    maxTokens?: number
    contextUsageRatio: number
  }

  activeToolCalls: Map<string, ActiveToolCall>
  activeSubtasks: Map<string, ActiveSubtask>

  abort: {
    requested: boolean
    kind?: 'soft' | 'hard'
    reason?: string
  }

  completion?: {
    status: 'completed' | 'failed' | 'cancelled' | 'budget_exhausted'
    reason: string
  }
}
```

根据当前项目实际类型调整，不要为了符合示例重复定义已有类型。

### RunEvent

建立类型化的内部事件协议，例如：

```ts
type RunEvent =
  | { type: 'RUN_STARTED'; runId: string }
  | { type: 'BOOT_COMPLETED' }
  | { type: 'ITERATION_STARTED'; iteration: number }
  | { type: 'MODEL_REQUESTED'; requestId: string }
  | { type: 'MODEL_STREAM_STARTED'; requestId: string }
  | { type: 'MODEL_COMPLETED'; requestId: string }
  | { type: 'TOOL_REQUESTED'; callId: string; toolName: string }
  | { type: 'TOOL_STARTED'; callId: string }
  | { type: 'TOOL_COMPLETED'; callId: string; result: ToolResult }
  | { type: 'TOOL_FAILED'; callId: string; error: string }
  | { type: 'CONTEXT_COMPACTED'; strategy: string }
  | { type: 'PLAN_MODE_ENTERED' }
  | { type: 'PLAN_MODE_EXITED' }
  | { type: 'ABORT_REQUESTED'; kind: 'soft' | 'hard'; reason: string }
  | { type: 'RUN_COMPLETED'; reason: string }
  | { type: 'RUN_FAILED'; error: string }
```

要求：

* Event 是内部运行时协议，不只是日志格式。
* 状态变化应通过清晰的 transition/reducer 或集中式状态方法完成。
* EventLog、Telemetry、Renderer、Hooks 可以订阅或适配这些事件。
* 不允许为了“事件化”引入复杂消息总线、分布式系统或者重量级框架。
* 事件系统必须保持进程内、类型安全、容易追踪。

---

## 五、职责边界

### 1. RuntimeCoordinator

只负责：

* 启动运行时
* 推进 Think → Act → Observe 循环
* 接收子系统结果
* 派发 RunEvent
* 根据 RunState 和 TerminationPolicy 决定下一步
* 协调清理与结束

它不应：

* 直接解析流式 chunk
* 直接执行 Bash 或其他工具
* 直接完成上下文压缩
* 直接判断权限规则
* 直接拼接所有 Prompt
* 直接实现 Provider 兼容逻辑

### 2. ModelGateway

负责：

* OpenAI-compatible API 调用
* 请求参数标准化
* Provider 差异兼容
* 重试和超时边界
* Streaming 请求建立

不要让 ModelGateway 决定 Agent 下一步做什么。

### 3. StreamConsumer

负责：

* 消费流式响应
* thinking/reasoning 内容分离
* assistant text 聚合
* tool_call 增量参数聚合
* 缺失 tool call ID 的兼容处理
* finish reason 和 usage 提取

输出规范化结果，不操作 Tool，也不修改整个 RunState。

### 4. ContextManager

负责：

* 上下文 token 估算
* 系统提示词和 Tool Schema 预算
* microCompact
* snipCompact
* autoCompact
* 大型 Tool Result 持久化或裁剪
* 压缩后的消息返回

保留当前已有压缩策略和兼容行为，不要顺便重新设计整套压缩算法。

### 5. ToolRegistry

负责：

* Tool 注册
* Tool 查找
* Tool Definition 获取
* Module Tool 和额外 Tool 合并
* 重名冲突处理

### 6. ToolPolicy

负责：

* Agent 工具白名单
* disallowedTools
* Plan Mode 工具限制
* PermissionManager
* 风险分类
* 工具是否可见
* 工具是否可以执行

必须区分：

```text
exposure policy：模型是否能看到工具
execution policy：模型即使猜到工具名，运行时是否允许执行
```

两层检查都要保留。

### 7. ToolScheduler

负责：

* 根据 metadata 判断 readOnly、concurrencySafe、stateful
* 将 Tool Call 分批
* 并行执行安全工具
* 串行执行状态修改工具
* 保证返回顺序和 tool_call_id 对应关系正确

ToolScheduler 不直接实现权限检查和具体 Tool 逻辑。

### 8. ToolExecutor

负责单次 Tool Call：

* 输入解析和校验
* 执行时权限复查
* Hook 调用
* AbortSignal 传递
* 调用 Tool
* 错误标准化
* Tool Result 限制
* Module `onToolCall`
* 文件历史等必要副作用

### 9. ModuleManager

负责：

* enabledModules 解析
* 依赖排序
* boot
* onIteration
* onToolCall
* onComplete
* teardown
* Module 提供的 Prompt、Tool、Context Patch 聚合

Engine 不再亲自循环调用每个 Module。

### 10. TerminationPolicy

统一处理：

* maxIterations
* token budget exhausted
* context 无法恢复
* 用户取消
* API 失败
* 正常无 Tool Call 结束
* Plan Mode 的特殊结束条件
* 显式完成信号
* 子任务状态

本轮只统一结束语义，不需要建设完整的任务质量评测或 Completion Evidence 系统。

---

## 六、依赖方向

建立明确依赖方向：

```text
CLI / UI
   ↓
Engine facade
   ↓
RuntimeCoordinator
   ↓
Model / Context / ToolRuntime / ModuleRuntime
   ↓
基础类型、存储、外部适配器
```

禁止出现：

* model 层依赖 Engine
* tool 层依赖 UI 实现
* context 层直接控制运行循环
* module 层直接修改 Engine 私有状态
* Renderer 决定运行时状态
* RuntimeCoordinator 依赖具体 Bash、Read、Memory Tool 类
* 新旧两套 Runtime 长期并存
* 为解决循环依赖而大量使用 `any`、动态 import 或全局变量

如果发现循环依赖，优先提取最小稳定接口或基础类型，而不是绕过类型系统。

---

## 七、执行顺序

必须按增量方式执行，禁止 Big Bang Rewrite。

### 阶段 0：架构审计

首先阅读：

* `AGENTS.md`
* `README.md`
* `goal.md`
* `package.json`
* `src/core/engine.ts`
* `src/core/types.ts`
* `src/core/queryStateMachine.ts`
* `src/core/module.ts`
* `src/core/moduleRegistry.ts`
* `src/core/compact.ts`
* `src/tools/index.ts`
* Agent、后台任务、Loop、Workflow、Goal 相关代码

完成：

1. 绘制当前调用关系。
2. 列出 Engine 当前所有职责。
3. 列出重复状态和重复控制语义。
4. 确认外部公开接口和兼容边界。
5. 在仓库中创建简洁的架构重构文档。

不要在完成审计后停止，审计只是实施前置步骤。

### 阶段 1：建立 Runtime Contracts

先加入：

* RunState
* RunPhase
* RunEvent
* RuntimeResult
* RuntimeDependencies
* TerminationReason
* 必要的接口类型

先适配现有代码，不立刻搬迁全部实现。

### 阶段 2：提取 Model Runtime

从 Engine 中提取：

* API 请求
* Streaming 建立
* Streaming 消费
* Provider 兼容
* usage 收集
* stall timeout

保证用户可见的流式输出、reasoning 输出和 tool_call 聚合行为不变。

### 阶段 3：提取 Context Runtime

提取：

* context window 解析
* max output token 限制
* token 预算
* compact 策略编排
* aggregate tool result budget

优先封装已有 `compact.ts`，不要复制一套压缩逻辑。

### 阶段 4：提取 Tool Runtime

依次建立：

* ToolRegistry
* ToolPolicy
* ToolScheduler
* ToolExecutor

保持：

* Agent 白名单
* Plan Mode
* PermissionManager
* riskClassifier
* Hook
* Module onToolCall
* Abort
* 并发分区
* 大结果处理

全部行为兼容。

### 阶段 5：提取 Module Runtime

统一 Module 生命周期。

删除 Engine 内部重复的 Module 遍历和聚合逻辑，但保持现有 Module API 尽量兼容。

### 阶段 6：建立 RuntimeCoordinator

将现有 `runTurn` 主循环迁移到 RuntimeCoordinator。

RuntimeCoordinator 必须依赖接口化子系统，而不是直接引用所有具体实现。

Engine 最终成为薄门面：

```ts
class ExecutionEngine {
  constructor(...) {
    this.runtime = createRuntime(...)
  }

  runTurn(...) {
    return this.runtime.run(...)
  }

  abort() {
    return this.runtime.abort(...)
  }

  dispose() {
    return this.runtime.dispose(...)
  }
}
```

这只是意图示例，不要求机械照搬。

### 阶段 7：统一状态与清理旧路径

处理：

* queryStateMachine 与 RunState 的关系
* loop engine 与 RuntimeCoordinator 的关系
* Plan Mode 状态来源
* Abort 状态来源
* BackgroundTask 与主 Runtime 的接口
* EventLog 与 RunEvent 的适配
* CostTracker 与 Budget State 的边界

旧实现如果已无调用，应安全删除。

不要保留：

* `legacyRuntime`
* `newRuntime`
* `engineV2`
* 大量双写状态
* 永久兼容分支

迁移期间可以短暂适配，最终只保留一条主路径。

---

## 八、质量原则

### 不要做伪重构

以下不算完成：

* 只把 Engine 的 private 方法移动到几个 util 文件
* 新文件只是转发 Engine 方法
* Engine 仍然持有并修改全部状态
* 新增很多 Manager，但职责仍然重叠
* 通过 EventEmitter 包装旧逻辑，却没有统一状态
* 仅仅降低单文件行数
* 用大量依赖注入样板代码制造“架构感”
* 为每个简单函数创建一个 class
* 创建抽象工厂、服务定位器或全局容器，但没有实际必要

### 抽象标准

只有满足以下至少一项时才创建抽象：

* 拥有明确状态
* 拥有独立生命周期
* 隔离外部副作用
* 存在多个实现
* 是稳定的架构边界
* 能显著降低 Engine 耦合

### 注释标准

注释解释：

* 为什么存在这个边界
* 状态由谁拥有
* 哪些行为必须保持兼容
* 哪些检查属于纵深防御

不要写重复代码含义的低价值注释。

---

## 九、兼容性约束

必须尽量保持：

* CLI 使用方式
* Engine 对外公开 API
* AgentConfig
* Module API
* Tool API
* Renderer API
* Plugin API
* Hook 行为
* Plan Mode 行为
* Permission 行为
* Streaming 展示
* 后台任务
* 子 Agent
* MCP
* LSP
* SSH
* Memory
* FileHistory
* CostTracker
* EventLog

确实需要修改公开接口时：

1. 先证明旧接口阻碍正确架构。
2. 提供兼容适配层。
3. 更新仓库内全部调用点。
4. 在最终报告中明确记录。

---

## 十、验证要求

本轮不建设新评测系统，但每个阶段完成后至少执行适用的：

```bash
pnpm typecheck
pnpm build
pnpm lint
pnpm test
```

以 `package.json` 实际 scripts 为准。

要求：

* 先修复当前分支原有失败与重构引入失败之间的归因问题。
* 不修改测试来迎合错误实现。
* 不因单个非关键测试失败而放弃整个架构重构。
* 对无法修复的原有问题明确记录证据。
* 不必为了提高测试数字而新增大量测试。
* 对新抽取的关键纯逻辑，如果没有任何现有覆盖，可以补充少量必要回归测试，但不要把任务转成测试工程。

---

## 十一、工作方式

你可以使用只读子 Agent 并行审计以下区域：

* Engine 和 Query State
* Tool Runtime
* Context/Compact
* Module System
* Agent/Worker/Background
* CLI 与外部兼容接口

主 Agent 必须负责：

* 最终架构决策
* 状态模型统一
* 跨模块整合
* 冲突解决
* 代码修改
* 最终验证

不要让多个子 Agent 同时重构相同核心文件。

采用小步迁移：

```text
分析
→ 建立接口
→ 适配旧实现
→ 搬迁职责
→ 切换调用路径
→ 验证
→ 删除旧路径
```

不要只生成计划后停止。

不要因为一次构建成功就提前宣布完成。

---

## 十二、完成标准

只有满足以下条件才能结束任务：

1. ExecutionEngine 已显著收缩为 Runtime 门面或高层协调入口。
2. 模型调用、流式解析、上下文管理、工具运行时、模块生命周期已拥有明确边界。
3. RunState 或等价结构成为运行状态的唯一真相源。
4. 运行时状态变化拥有集中、可追踪的路径。
5. 是否继续和是否结束由统一策略决定。
6. Tool 暴露策略和执行策略边界明确。
7. Plan Mode、Abort、Budget、Iteration 不再由多个模块重复持有。
8. 没有新旧两套主循环长期并存。
9. 没有为了拆文件而制造大量空壳包装。
10. 当前主要功能和公开接口保持兼容。
11. 类型检查和构建通过。
12. 现有测试结果不低于重构前基线；原有失败必须单独说明。
13. README 中的架构说明与最终实现一致。
14. 提供最终架构文档。

---

## 十三、最终输出

完成代码修改后，输出：

### 1. 原架构问题

说明实际发现的问题，不要只复述任务描述。

### 2. 最终架构

列出：

* 主要目录
* 核心组件
* 每个组件的状态所有权
* 组件依赖方向
* 一次完整 Turn 的调用流程

### 3. 迁移内容

列出：

* 新增文件
* 修改文件
* 删除文件
* 旧职责迁移位置
* 兼容层

### 4. 行为兼容

说明哪些行为保持不变，哪些接口发生了调整。

### 5. 验证结果

列出实际执行的命令和结果。

### 6. 未解决问题

只列真实存在且本轮不适合继续处理的问题，不要创建泛化 TODO。

### 7. 后续建议

限制在 3～5 项，并且必须建立在本轮实际重构结果上。

现在开始直接审计和修改当前仓库。不要只给出方案，不要等待确认，不要提前停止。
