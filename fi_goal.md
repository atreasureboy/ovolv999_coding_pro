# /goal：将 ovolv999_coding_pro 重构为可验证的多 Agent Coding Runtime

你现在是本仓库的主架构 Agent。

仓库：

https://github.com/atreasureboy/ovolv999_coding_pro

你的任务不是继续堆积零散工具和命令，而是把该项目从“功能很多的 Coding Agent”逐步升级为：

> 支持多模型 Worker、任务隔离、结构化状态、事件持久化、中途干预、失败恢复和自动验收的可验证 Coding Agent Runtime。

本任务允许长期迭代。你必须持续执行：

> 现状验证 → 设计 → 最小闭环实现 → 测试 → 审计 → 修复 → 下一轮

不要在只完成表面代码后提前结束。

---

## 一、工作原则

### 1. 先验证，不能盲目相信任务描述

以下问题来自外部静态审计，但你必须先阅读当前源码、测试和 Git 历史，确认问题在当前版本中是否仍然存在。

如果问题已经修复：

* 记录证据；
* 检查测试是否覆盖；
* 不得重复重构。

如果问题描述与源码不符：

* 以源码为准；
* 说明实际情况；
* 调整实施方案。

### 2. 不允许为了重构而重构

任何架构修改必须至少解决一个明确问题：

* 状态不一致；
* 假成功；
* 并发冲突；
* 无法恢复；
* 无法观测；
* 上下文丢失；
* Provider 耦合；
* 测试不可验证；
* 子 Agent 无法控制。

不得仅因为“设计更优雅”就大规模改写稳定代码。

### 3. 保持向后兼容

优先采用：

> 新协议 → Adapter 接入旧实现 → 测试验证 → 逐步迁移 → 删除旧实现

不要一次性推倒重写。

### 4. 禁止伪造完成

不得：

* 删除失败测试；
* 放宽断言使测试通过；
* 用空实现、TODO 或 mock 代替核心逻辑；
* 只修改类型而不完成运行逻辑；
* 把验证失败的任务标记为成功；
* 仅根据子 Agent 自我报告判断完成。

最终状态必须由代码、测试、Git diff 和验收结果共同决定。

---

# 二、第一阶段：验证并修复确定性问题

先建立问题清单，对以下项目逐一验证。

每项都需要：

1. 定位相关源码；
2. 判断是否真实存在；
3. 添加能复现问题的测试；
4. 实施最小修复；
5. 运行关联测试；
6. 运行全量测试；
7. 记录修改前后的行为差异。

---

## P0-1：模型切换状态同步

检查模型切换后，以下组件是否仍可能保留旧模型状态：

* ModelGateway；
* ContextManager；
* 上下文窗口缓存；
* Reflection；
* Critic；
* 模块系统；
* Provider 和模型能力配置。

目标：

建立统一的运行时模型配置源，例如：

```ts
interface ModelRuntimeConfig {
  model: string
  provider: string
  contextWindow: number
  capabilities: ModelCapabilities
  pricing?: ModelPricing
}
```

模型切换应当成为完整事务：

```text
解析模型
→ 解析 Provider
→ 解析模型能力
→ 更新上下文窗口
→ 清理相关缓存
→ 通知依赖模块
→ 提交配置
```

禁止不同组件分别保存互相不一致的模型状态。

---

## P0-2：长回复 continuation 输出完整性

检查 RuntimeCoordinator 在模型因长度限制进行续写时：

* 最终 TurnResult.output 是否只保留最后一段；
* 流式输出、消息历史、最终返回结果是否一致；
* 多次 continuation 是否发生内容丢失或重复。

建立以下不变量测试：

```text
最终返回的 output
=
本轮所有 assistant 输出片段按顺序拼接
=
消息历史中本轮 assistant 内容之和
```

---

## P0-3：子 Agent 假成功

检查 AgentTool 及相关执行路径：

* typecheck、lint、test 失败后，任务是否仍然返回成功；
* isError、status、文本报告之间是否可能冲突；
* 父 Agent 是否需要自行阅读自然语言才能发现验证失败。

统一任务状态至少包括：

```ts
type TaskStatus =
  | 'queued'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'verification_failed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'blocked'
```

只有以下条件全部满足，才能标记为 `completed`：

```text
Worker 正常结束
+ 产生符合目标的结果
+ 验收命令通过
+ 修改范围符合约束
+ 没有未处理错误
```

---

## P0-4：并行修改型 Agent 文件竞争

检查多个 Agent 并发执行时是否共用同一个工作目录。

区分任务类型：

```text
只读任务：
允许共享主工作区

修改型任务：
必须独立 Git worktree
必须具有独立分支
必须独立执行测试
必须生成独立 diff
必须经过父 Agent 验收后才能合并
```

是否创建 worktree 不应由子模型自行决定，而应由 Runtime 根据任务是否修改状态自动决定。

必须测试：

* 两个 Agent 修改同一文件；
* 两个 Agent 修改不同文件；
* 一个 Agent 跑测试时另一个修改代码；
* 一个 Agent 失败时是否污染其他任务；
* 合并冲突如何处理。

---

## P0-5：Claude Code tmux 完成检测

检查 Claude Code 集成是否通过固定 `[DONE]` 文本判断完成。

如果复用 tmux Session，必须防止误读历史任务的 `[DONE]`。

最低限度需要：

```text
[TASK_START <task_id>]
[TASK_PROGRESS <task_id> ...]
[TASK_DONE <task_id>]
[TASK_FAILED <task_id> ...]
```

完成判断必须绑定唯一 task_id，只能读取本次任务发送后的输出。

长期目标是将 Claude Code、M3、GLM 等外部模型封装成统一 WorkerAdapter：

```ts
interface WorkerAdapter {
  start(task: TaskSpec): Promise<RunHandle>
  status(runId: string): Promise<RunStatus>
  steer(runId: string, instruction: string): Promise<void>
  cancel(runId: string): Promise<void>
  collect(runId: string): Promise<RunResult>
}
```

不要继续让主 Agent 依赖解析完整终端文本来理解任务状态。

---

## P0-6：Workflow 变量替换

检查 Workflow 的步骤变量是否真正生效。

统一变量语法，例如：

```text
${inputs.target}
${steps.analyze.output}
${steps.test.exitCode}
${artifacts.patch.path}
```

要求：

* 支持嵌套字段；
* 支持前序步骤结果；
* 找不到变量时必须明确报错；
* 不得静默保留未替换占位符；
* 增加串行、并行、失败分支测试。

---

## P0-7：模块依赖启动顺序

检查 ModuleManager 是否虽然计算了依赖关系，却仍使用 Promise.all 并发启动所有模块。

要求：

* 按拓扑层级启动；
* 同一层无依赖模块才允许并行；
* 检测循环依赖；
* 区分关键模块与 best-effort 模块；
* 生命周期 Hook 采用一致的错误策略。

例如：

```ts
interface ModuleMetadata {
  dependencies: string[]
  criticality: 'critical' | 'best_effort'
}
```

关键模块启动失败时，Runtime 不得继续假装正常运行。

---

## P0-8：EpisodicMemory 初始化计数

检查已有 JSONL 记忆文件重新加载后，entryCount 是否正确。

增加测试：

* 空文件首次写入；
* 已有 N 条记录后重启；
* 达到容量限制后裁剪；
* 损坏行和部分写入恢复；
* 并发写入一致性。

---

## P0-9：清理与状态刷新

同时检查以下风险：

* ToolScheduler 的 active call 是否始终在 finally 中清理；
* Plan Mode 是否在同一 Turn 内读取过期状态；
* BackgroundTask 取消后状态是否一致；
* AbortSignal 是否贯穿模型、工具、Agent 和 Worker；
* Runtime 退出时是否正确回收 tmux、进程、worktree 和临时文件。

---

# 三、第二阶段：引入统一 ExecutionRun

完成第一阶段后，引入统一执行协议。

不要马上删除旧状态系统，先使用 Adapter 接入。

建议结构：

```ts
interface ExecutionRun {
  id: string
  parentRunId?: string

  kind:
    | 'turn'
    | 'agent'
    | 'external_worker'
    | 'shell_task'
    | 'workflow'
    | 'loop'

  goal: string
  status: RunStatus
  phase: string

  worker?: string
  workspace: WorkspaceRef

  acceptance: AcceptanceRule[]
  budget: RunBudget
  resources: ResourceClaim[]

  artifacts: ArtifactRef[]
  verification?: VerificationResult

  createdAt: string
  updatedAt: string
}
```

统一状态机：

```text
queued
→ preparing
→ running
→ waiting
→ verifying
→ succeeded
```

任意阶段可以进入：

```text
failed
cancelled
timed_out
blocked
verification_failed
```

需要逐步接入：

```text
普通模型 Turn
AgentTool
Claude Code
BackgroundTask
Workflow
LoopEngine
Shell Task
Worktree Task
```

完成后，UI、日志、取消、恢复、验收和状态查询都必须基于 ExecutionRun，而不是各模块独立维护状态。

---

# 四、第三阶段：统一事件系统

建立统一事件信封：

```ts
interface RunEvent<T> {
  eventId: string
  runId: string
  parentRunId?: string
  sequence: number
  timestamp: string
  type: string
  payload: T
}
```

至少支持：

```text
run.created
run.started
run.progress
run.blocked
run.steered
run.cancelled
run.completed
run.failed

tool.requested
tool.started
tool.completed
tool.failed

artifact.created

verification.started
verification.completed
verification.failed
```

要求：

* 每个 Run 的 sequence 单调递增；
* 事件先持久化，再推送给 UI；
* 进程崩溃后可根据事件恢复状态；
* 订阅器异常不能静默吞掉；
* best-effort 订阅器错误需要记录；
* critical 订阅器错误必须改变 Run 状态。

初期可以使用 JSONL，后续再迁移 SQLite。

---

# 五、第四阶段：工具资源调度

当前工具调度不能只依赖：

* 工具名；
* 是否标记为并行安全；
* Shell 命令正则。

引入动态资源声明：

```ts
interface ResourceClaim {
  type:
    | 'file'
    | 'directory'
    | 'git'
    | 'port'
    | 'process'
    | 'network'

  key: string
  access: 'read' | 'write' | 'exclusive'
}
```

示例：

```text
Read(src/core/engine.ts)
→ file:src/core/engine.ts / read

Edit(src/core/engine.ts)
→ file:src/core/engine.ts / write

npm test
→ directory:repo / read
→ process:test-runner / exclusive

npm install
→ directory:node_modules / exclusive
→ file:package-lock.json / write
```

调度器根据资源冲突决定是否并发。

必须增加：

* 死锁避免；
* 获取资源超时；
* 取消时释放锁；
* Run 结束后强制清理；
* worktree 级别资源隔离；
* Git 操作串行化。

---

# 六、第五阶段：结构化 ToolResult

逐步减少把所有结果塞入字符串的做法。

统一为：

```ts
interface ToolResult {
  status:
    | 'success'
    | 'failed'
    | 'cancelled'
    | 'timed_out'

  summary: string

  exitCode?: number
  stdout?: string
  stderr?: string

  artifacts?: ArtifactRef[]
  diagnostics?: Diagnostic[]
  retryable?: boolean
}
```

要求：

* Bash 非零退出码不能返回 success；
* 失败时仍保留 stdout 和 stderr；
* 父 Agent 不需要解析文本判断成功失败；
* 测试报告、补丁、日志作为 Artifact 返回；
* 大体积输出写入 Artifact Store，不直接塞入上下文。

---

# 七、第六阶段：上下文与 WorkingState

不要继续依赖自由文本对话摘要维护长期任务状态。

引入：

```ts
interface WorkingState {
  objective: string
  constraints: string[]

  confirmedFacts: Fact[]
  decisions: Decision[]

  filesRead: string[]
  filesChanged: string[]

  verification: {
    passed: string[]
    failed: string[]
  }

  unresolved: string[]
  nextActions: string[]

  artifacts: ArtifactRef[]
}
```

上下文组装方式：

```text
稳定系统提示
+ 当前 WorkingState
+ 最近原始消息
+ 与当前任务相关的 Artifact
+ 按需检索的长期记忆
```

要求：

* 不得把自动摘要伪装成新的用户消息；
* 不得生成不存在的 assistant 确认消息；
* 压缩前后关键事实、约束、失败项和修改记录必须保持；
* 增加上下文压缩不变量测试；
* 模型切换后重新计算上下文预算。

---

# 八、第七阶段：记忆系统收敛

审计并统一：

* SemanticMemory；
* EpisodicMemory；
* KnowledgeBase；
* Reflection；
* 项目经验；
* Artifact 元数据。

优先使用 SQLite + FTS5，不要急于引入复杂向量数据库。

长期记忆至少包含：

```ts
interface MemoryRecord {
  repo: string
  branch?: string
  commit?: string

  sourceRunId: string
  confidence: number
  verified: boolean

  createdAt: string
  expiresAt?: string
}
```

要求：

* 验证失败的任务不得直接写入长期记忆；
* Reflection 结果必须标记来源；
* 代码相关记忆必须绑定 commit；
* 过时记忆能够失效；
* 冲突记忆不能直接覆盖；
* embedding 仅作为可选插件。

---

# 九、第八阶段：Provider 能力抽象

不要继续在多个文件中硬编码模型名称、上下文窗口、价格和能力。

统一：

```ts
interface ModelCapabilities {
  toolCalling: boolean
  parallelToolCalling: boolean
  reasoningTokens: boolean
  promptCaching: boolean
  usageStreaming: boolean
  imageInput: boolean

  maxContext: number
  maxOutput: number
}
```

每个 Provider Adapter 负责：

```text
内部统一消息
→ Provider 请求
→ Provider 流式响应
→ 内部统一事件
```

RuntimeCoordinator 不应包含 OpenAI、Anthropic、M3、GLM 的专用分支逻辑。

---

# 十、子 Agent 使用规范

你可以调用 Claude Code、M3、GLM 或其他 Worker，但必须遵守：

### 1. 主 Agent 保留架构控制权

子 Agent 只执行明确模块任务，不得自行改变总体架构。

### 2. 每个任务必须包含

```text
任务目标
允许修改范围
禁止修改范围
验收标准
测试命令
输出格式
超时条件
失败处理方式
```

### 3. 修改型任务必须隔离

* 独立 worktree；
* 独立分支；
* 独立日志；
* 独立验证；
* 独立 diff。

### 4. 不信任自我报告

子 Agent 说“完成”不代表完成。

主 Agent必须检查：

* Git diff；
* 测试结果；
* 类型检查；
* lint；
* 验收条件；
* 是否出现范围外修改；
* 是否引入新架构债。

### 5. 子 Agent 失败后先归因

区分：

```text
需求不清
架构理解错误
工具失败
测试环境失败
模型能力不足
上下文不足
任务范围过大
代码本身存在阻塞
```

不能无脑使用相同 Prompt 重试。

---

# 十一、测试要求

必须建立分层测试：

## 单元测试

覆盖：

* 状态机；
* 变量替换；
* 模型配置同步；
* ToolResult；
* 资源冲突；
* 事件排序；
* Memory 计数；
* continuation 拼接。

## 集成测试

覆盖：

* Agent → worktree → 修改 → 验证 → 合并；
* Claude Worker → 进度 → 完成 → 结果收集；
* Worker 崩溃恢复；
* 主进程重启恢复；
* 取消长任务；
* 并行只读任务；
* 并行修改冲突；
* Workflow 前序结果传递。

## 故障注入测试

主动模拟：

* 模型中断；
* 工具超时；
* tmux Session 丢失；
* Worker 无响应；
* 测试进程卡死；
* JSONL 写入一半；
* SQLite 锁冲突；
* worktree 删除失败；
* Git merge 冲突；
* Provider 返回畸形数据。

## 回归要求

每次架构改动后运行：

```text
关联测试
→ 模块测试
→ 全量测试
→ 类型检查
→ lint
```

记录修改前后的测试数量、失败数量和耗时。

---

# 十二、工作节奏

每轮只完成一个完整闭环，不要同时大范围修改所有系统。

推荐顺序：

```text
第一轮：
验证并修复 P0 问题

第二轮：
ExecutionRun 最小实现
仅接入 AgentTool

第三轮：
接入 Claude Code Worker

第四轮：
接入 BackgroundTask 和 Workflow

第五轮：
事件持久化与恢复

第六轮：
自动 worktree 和 Verification Gate

第七轮：
资源调度器

第八轮：
WorkingState 和上下文压缩

第九轮：
Memory 收敛

第十轮：
Provider 能力抽象
```

每轮结束后进行架构审计：

* 是否增加重复状态；
* 是否产生新的事实来源；
* 是否引入兼容层但没有迁移计划；
* 是否产生无法测试的抽象；
* 是否扩大 RuntimeCoordinator；
* 是否出现新的上帝类；
* 是否存在假成功路径；
* 是否能够取消和恢复。

---

# 十三、阶段性交付格式

每个阶段结束后更新：

```text
docs/architecture/
docs/decisions/
docs/runtime/
```

并输出：

## 1. 本轮目标

说明本轮试图解决什么问题。

## 2. 实际发现

列出源码验证结果，不得仅复述任务描述。

## 3. 架构决策

说明选择了什么方案、放弃了什么方案以及原因。

## 4. 修改文件

列出关键文件和功能变化。

## 5. 测试结果

必须包含实际命令和结果。

## 6. 未解决问题

明确剩余风险，不得隐藏。

## 7. 下一轮建议

按照收益、风险和依赖关系排序。

---

# 十四、最终验收目标

项目最终应当实现：

* 所有执行行为都有统一 Run ID；
* 所有子任务都有父子关系；
* 所有状态变化都有结构化事件；
* 修改型 Agent 自动使用独立 worktree；
* 子 Agent 可以查询、steer、cancel 和 collect；
* 任务完成必须通过 Verification Gate；
* 验证失败绝不标记成功；
* Worker 崩溃或主进程重启后可恢复状态；
* 工具并发由资源冲突决定；
* 上下文压缩不丢失关键工作状态；
* 长期记忆绑定来源和 commit；
* Provider 差异不泄漏到主 Runtime；
* README 不再主要宣传工具数量，而是展示 Runtime 能力和实测指标。

最终项目定位应从：

> 功能丰富的 Coding Agent / Claude Code 仿制品

升级为：

> 可观测、可控制、可恢复、可验证的多模型 Coding Agent Runtime。

现在开始：

1. 阅读完整仓库；
2. 建立当前架构地图；
3. 验证 P0 问题；
4. 创建实施计划；
5. 从最小、确定、可测试的修复开始；
6. 完成后继续下一轮，不要在仅输出分析报告后停止。
