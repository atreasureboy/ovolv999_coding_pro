# /goal：完成 ovolv999_coding_pro 多 Agent Runtime 主链路收敛

你是本仓库的主架构 Agent，负责持续审计、实现、测试和收敛架构。

仓库：

https://github.com/atreasureboy/ovolv999_coding_pro

当前项目已经完成了一轮重大重构，引入了以下基础设施：

* ExecutionRun；
* ExecutionRunRegistry；
* 运行事件与持久化；
* WorkerAdapter；
* Claude Code Worker；
* Agent Worktree 隔离；
* Verification Gate；
* ResourceScheduler；
* StructuredToolResult；
* WorkingState；
* Workflow 严格变量替换；
* Module 拓扑启动。

本轮任务不是继续增加新的抽象、工具或命令，而是解决当前最重要的问题：

> 新基础设施已经存在，但部分仍然是孤立实现，没有真正接入 Engine、ToolScheduler、AgentTool、ClaudeCodeTool、ContextManager 和 Workflow 的主执行链。

最终目标是让项目中的所有执行行为统一具备：

* 唯一 Run ID；
* 正确的父子 Run 关系；
* 结构化状态；
* 结构化事件；
* Worktree 隔离；
* 资源锁；
* 中途 steer；
* 取消；
* 结果收集；
* 自动验证；
* 失败传播；
* 可恢复或至少可识别的崩溃状态。

---

# 一、总执行要求

你必须执行完整闭环：

```text
读取当前仓库
→ 建立真实架构地图
→ 验证问题是否存在
→ 添加失败测试
→ 实施最小修复
→ 运行关联测试
→ 运行全量测试
→ 审计新增架构债
→ 继续下一项
```

不得只输出分析报告。

不得因为任务范围较大而提前结束。

不得在只增加接口、类型或空 Adapter 后宣称完成。

---

# 二、真实性要求

以下问题来自外部静态源码审计。

你必须逐项验证，不能直接假设结论正确。

每个问题必须标记为：

```text
CONFIRMED
PARTIALLY_CONFIRMED
ALREADY_FIXED
NOT_REPRODUCIBLE
DESIGN_RISK
```

每项必须提供：

1. 相关文件；
2. 相关函数或类；
3. 当前真实行为；
4. 是否有测试覆盖；
5. 修复方案；
6. 修复后验证结果。

源码与任务描述冲突时，以当前源码为准。

不要为了迎合任务描述强行修改没有问题的代码。

---

# 三、最高优先级目标：ExecutionRun 真正接入主链

## P0-1：修复 ExecutionRunRegistry 初始化和注入顺序

重点审计：

```text
src/core/engine.ts
src/tools/index.ts
src/tools/agent.ts
src/tools/claudeCode.ts
src/core/runtime/*
src/core/toolRuntime/*
```

检查 Engine 当前是否存在以下初始化顺序问题：

```text
createTools()
→ ToolExecutor
→ ToolScheduler
→ 后续才创建 ExecutionRunRegistry
```

如果工具创建时没有收到 ExecutionRunRegistry，则 AgentTool 和 ClaudeCodeTool 可能无法创建子 Run。

必须实现：

```text
ExecutionRunRegistry 永远先创建
→ EventBus 创建
→ 可选 EventStore 挂载
→ ExecutionContextProvider 创建
→ createTools 注入运行时依赖
→ ToolExecutor
→ ResourceScheduler
→ ToolScheduler
→ RuntimeCoordinator
```

## 强制要求

ExecutionRunRegistry 必须始终存在。

不能只有配置 `executionRunLogDir` 时才创建 Registry。

正确分层应为：

```ts
ExecutionRunRegistry
// 始终存在，管理当前内存运行状态

RunEventBus
// 始终存在，分发运行事件

RunEventStore
// 可选，持久化 JSONL 或 SQLite

RunRecoveryService
// 可选，负责恢复或识别失联任务
```

不得将“是否开启持久化”与“是否拥有 ExecutionRun”绑定。

---

## P0-2：通过调用上下文动态传递当前 Run

不能把固定 `parentRunId` 保存在 Tool 构造函数中，因为每一轮 Turn 都有不同的 Run。

建立或完善统一上下文：

```ts
interface ExecutionContext {
  runId: string
  parentRunId?: string

  workspaceId: string
  workspacePath: string

  signal: AbortSignal

  model?: string
  provider?: string

  metadata?: Record<string, unknown>
}
```

ToolContext 中必须携带当前执行上下文：

```ts
interface ToolContext {
  execution: ExecutionContext
  renderer?: Renderer
  logger?: Logger
}
```

工具调用链必须是：

```text
TurnRun 创建
→ RuntimeCoordinator 设置当前 ExecutionContext
→ ToolExecutor 收到 ToolContext
→ AgentTool 创建 child AgentRun
→ ClaudeCodeTool 创建 child ExternalWorkerRun
→ Workflow Step 创建 child WorkflowStepRun
→ ShellTask 创建 child ShellRun
```

必须建立真实父子关系：

```text
TurnRun
├── ToolRun
│   └── AgentRun
│       ├── VerificationRun
│       └── DeliveryRun
└── ClaudeWorkerRun
```

不要只在文本或 metadata 中记录父 ID，Registry 中的 Run tree 必须可以查询。

---

# 四、Worktree 隔离必须 fail-closed

## P0-3：禁止修改型 Agent 在 Worktree 失败后回退主目录

审计 AgentTool 当前行为。

重点检查是否存在：

```text
modifies_state = true
→ 创建 worktree 失败
→ 输出 warning
→ 回退 cwd
→ 继续运行子 Agent
```

这是禁止行为。

修改型任务必须：

```text
Worktree 创建成功
→ 启动子 Agent

Worktree 创建失败
→ 不启动子 Agent
→ Run 进入 blocked
→ 返回结构化错误
```

建议结果：

```ts
{
  status: 'blocked',
  summary: 'Unable to create isolated workspace',
  retryable: true,
  diagnostics: [
    {
      code: 'WORKTREE_CREATION_FAILED',
      message: '...',
    }
  ]
}
```

## 非 Git 仓库策略

不得静默回退。

必须显式选择：

```ts
type WorkspacePolicy =
  | 'git_worktree_required'
  | 'temporary_copy'
  | 'read_only'
```

规则：

### git_worktree_required

* 必须在 Git 仓库中；
* 必须创建独立分支；
* 创建失败则 blocked。

### temporary_copy

* 创建临时目录副本；
* 必须隔离写入；
* 必须明确不支持自动 Git merge；
* 最终以 patch 或 Artifact 交付。

### read_only

* 禁用 Write/Edit；
* Bash 仅允许只读命令；
* 不允许任何文件系统写操作。

---

## P0-4：任务模式不能依赖模型正确填写布尔值

审计当前是否依赖：

```text
modifies_state: true
verify: true
merge_on_success: true
```

LLM 忘记填写布尔值时，不得绕过隔离和验证。

改成明确模式：

```ts
type AgentTaskMode =
  | 'read_only'
  | 'modify'
```

## read_only 模式

必须：

* 不提供 Write；
* 不提供 Edit；
* 限制 Bash；
* 禁止 Git 修改；
* 可以共享主工作区；
* 可以并发运行。

## modify 模式

必须：

* 强制隔离工作区；
* 默认开启验证；
* 默认禁止直接操作父分支；
* 生成独立 diff；
* 产生变更 Artifact；
* 验证通过后才允许交付。

如果当前 Bash 副作用无法可靠判断，则只要 Agent 获得完整 Bash 能力，就默认使用 `modify` 模式。

不得用“模型承诺不修改”代替技术限制。

---

# 五、交付失败不能标记成功

## P0-5：修复 Worktree merge 失败后的最终状态

将任务结果拆成独立阶段：

```ts
interface AgentExecutionOutcome {
  worker: WorkerOutcome
  verification: VerificationOutcome
  delivery: DeliveryOutcome
}
```

分别处理：

```text
Worker 执行
Verification 验证
Delivery 合并或生成补丁
```

状态映射必须明确：

```text
Worker 失败
→ failed

Worker 成功、验证失败
→ verification_failed

Worker 和验证成功、合并冲突
→ blocked

Worker 和验证成功、交付成功
→ succeeded
```

不得使用单个旧变量：

```ts
const failed = workerFailed || verificationFailed
```

然后在 merge 失败后忘记更新。

建议状态：

```ts
type RunStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'waiting'
  | 'verifying'
  | 'delivering'
  | 'succeeded'
  | 'failed'
  | 'verification_failed'
  | 'blocked'
  | 'cancelled'
  | 'timed_out'
```

## DeliveryResult

```ts
interface DeliveryResult {
  status:
    | 'delivered'
    | 'conflict'
    | 'failed'
    | 'not_required'

  branch?: string
  commit?: string
  patchArtifact?: ArtifactRef

  conflicts?: string[]
  diagnostics?: Diagnostic[]
}
```

发生合并冲突时：

* 保留 Worktree；
* 保留分支；
* 不删除成果；
* 输出冲突文件列表；
* 生成 patch Artifact；
* Run 进入 blocked；
* 支持后续人工或父 Agent 处理。

---

# 六、Claude Code 异步任务必须保持真实状态

## P0-6：禁止 `wait:false` 后立刻 succeeded

审计：

```text
src/tools/claudeCode.ts
WorkerAdapter
tmux 相关代码
```

当前若任务只是成功发送到 tmux，不代表任务完成。

正确状态：

```text
created
→ preparing
→ running
→ waiting
```

当 `wait:false` 时，返回：

```ts
{
  runId,
  workerId,
  sessionId,
  status: 'waiting',
  detached: true
}
```

但 Run 必须保持非终态。

不得：

```text
任务已发送
→ succeeded
→ 删除 runId/session 映射
```

## 同一 Run 生命周期

以下操作必须继续操作同一个 runId：

```text
status(runId)
capture(runId)
steer(runId, instruction)
wait(runId)
cancel(runId)
collect(runId)
```

不得要求调用者切换到 session 名称作为新的主身份。

session 只是 WorkerDescriptor 的实现细节。

---

## P0-7：Claude 任务完成标记必须绑定 Task ID

即使暂时仍使用 tmux 输出解析，也必须做到：

```text
[TASK_START task-id]
[TASK_PROGRESS task-id phase=...]
[TASK_DONE task-id]
[TASK_FAILED task-id reason=...]
```

要求：

* 每个任务唯一 taskId；
* 记录发送任务前的 pane cursor 或输出位置；
* 只解析该位置之后的输出；
* 完成标记必须携带相同 taskId；
* 旧任务的 `[DONE]` 不得匹配；
* session 重用不得污染新任务；
* 输出截断时不得直接假设成功。

---

## P0-8：扩展 WorkerAdapter 完整生命周期

当前 WorkerAdapter 如果只有 `steer`，则不足以统一 Worker。

升级为：

```ts
interface WorkerAdapter<
  TTask extends WorkerTask = WorkerTask,
  TResult extends WorkerResult = WorkerResult
> {
  readonly workerKind: string

  start(
    task: TTask,
    context: ExecutionContext
  ): Promise<WorkerHandle>

  status(
    runId: string
  ): Promise<WorkerStatus>

  steer(
    runId: string,
    instruction: string
  ): Promise<DeliveryAck>

  cancel(
    runId: string,
    reason?: string
  ): Promise<void>

  collect(
    runId: string
  ): Promise<TResult>

  reattach?(
    descriptor: WorkerDescriptor
  ): Promise<WorkerHandle | null>
}
```

## WorkerHandle

```ts
interface WorkerHandle {
  runId: string
  workerKind: string
  workerInstanceId: string
  descriptor: WorkerDescriptor
}
```

## WorkerDescriptor

必须可序列化，用于重启后重连：

```ts
interface WorkerDescriptor {
  type: 'tmux' | 'process' | 'remote' | 'internal'
  sessionId?: string
  pid?: number
  host?: string
  metadata?: Record<string, unknown>
}
```

Claude Code、内部 Agent、未来 M3、GLM 都应逐步实现同一协议。

---

# 七、Verification Gate 必须成为强制状态门

## P0-9：修改型任务默认验证

修改型任务必须默认拥有 Verification Gate。

不能依赖模型主动传：

```text
verify: true
```

验收流程：

```text
Worker 完成
→ 收集 diff
→ 检查修改范围
→ 运行 typecheck
→ 运行 lint
→ 运行关联测试
→ 运行必要的全量测试
→ 生成 VerificationResult
→ 决定是否允许 Delivery
```

## VerificationResult

```ts
interface VerificationResult {
  status:
    | 'passed'
    | 'failed'
    | 'skipped'
    | 'inconclusive'

  checks: VerificationCheck[]
  startedAt: string
  completedAt: string
}
```

```ts
interface VerificationCheck {
  name: string
  command?: string

  status:
    | 'passed'
    | 'failed'
    | 'timed_out'
    | 'cancelled'
    | 'skipped'

  exitCode?: number
  stdoutArtifact?: ArtifactRef
  stderrArtifact?: ArtifactRef

  durationMs: number
}
```

## 禁止假成功

验证失败时：

```text
ToolResult.status = failed
Run.status = verification_failed
isError = true
```

不得只把失败信息追加到自然语言输出。

---

# 八、ResourceScheduler 接入 ToolScheduler

## P1-1：ResourceScheduler 不能继续孤立存在

审计：

```text
src/core/resourceScheduler.ts
src/core/toolRuntime/toolScheduler.ts
src/core/toolRuntime/toolExecutor.ts
src/tools/*
```

ToolScheduler 当前如果仍只依赖：

* 工具名称；
* `isConcurrencySafe`；
* 静态安全列表；
* Bash 正则；

则 ResourceScheduler 尚未真正接入。

建立：

```ts
interface ResourceAwareTool {
  getResourceClaims(
    input: unknown,
    context: ToolContext
  ): Promise<ResourceClaim[]> | ResourceClaim[]
}
```

```ts
interface ResourceClaim {
  type:
    | 'file'
    | 'directory'
    | 'repository'
    | 'git_branch'
    | 'process'
    | 'port'
    | 'network'
    | 'workspace'

  key: string

  access:
    | 'read'
    | 'write'
    | 'exclusive'
}
```

## 示例

```text
Read(src/core/engine.ts)
→ file:/abs/path/src/core/engine.ts / read

Edit(src/core/engine.ts)
→ file:/abs/path/src/core/engine.ts / write

git status
→ repository:/repo / read

git merge
→ repository:/repo / exclusive

npm test
→ workspace:/worktree / read
→ process:test-runner:/worktree / exclusive

npm install
→ directory:/worktree/node_modules / exclusive
→ file:/worktree/package-lock.json / write
```

---

## P1-2：资源生命周期

执行链必须为：

```text
解析工具参数
→ 生成 ResourceClaims
→ 原子获取全部资源
→ 工具执行
→ finally 释放资源
```

必须处理：

* AbortSignal；
* 超时；
* 工具异常；
* ToolExecutor 异常；
* Run 取消；
* Worker 崩溃；
* Engine shutdown。

任何路径都不得泄漏资源锁。

---

## P1-3：避免死锁

不得逐个无序获取资源。

至少采用一种策略：

### 策略 A：全局排序

按照：

```text
type
→ key
→ access
```

排序后统一申请。

### 策略 B：原子批量申请

只有所有资源都可获取时才成功。

推荐原子批量申请。

增加测试：

* A 需要 file1 + file2；
* B 需要 file2 + file1；
* 两者不能死锁；
* 取消一个后另一个能继续；
* 超时后所有部分锁释放。

---

# 九、StructuredToolResult 成为唯一内部结果

## P1-4：字符串结果只作为兼容层

建立统一内部结果：

```ts
interface StructuredToolResult {
  status:
    | 'success'
    | 'failed'
    | 'cancelled'
    | 'timed_out'
    | 'blocked'

  summary: string

  exitCode?: number
  stdout?: string
  stderr?: string

  diagnostics?: Diagnostic[]
  artifacts?: ArtifactRef[]

  retryable?: boolean

  metadata?: Record<string, unknown>
}
```

旧的：

```ts
{
  content: string
  isError: boolean
}
```

只能作为 Provider Tool Message 的序列化兼容层。

内部不得再通过解析 `content` 判断：

* 是否成功；
* 测试是否失败；
* 是否超时；
* 是否产生补丁；
* 是否需要重试。

---

## P1-5：Bash 非零退出码语义

Bash 返回非零退出码时：

```ts
{
  status: 'failed',
  exitCode: 1,
  stdout: '...',
  stderr: '...',
}
```

即使模型仍需要看到输出，也不能标记 success。

可以增加：

```ts
acceptableExitCodes?: number[]
```

只有显式允许的退出码才视为成功。

---

# 十、WorkingState 真正接入 ContextManager

## P1-6：WorkingState 不能只停留在数据结构

审计：

```text
src/core/workingState.ts
src/core/context/contextManager.ts
src/core/compact.ts
RuntimeCoordinator
ToolExecutor
RunEventBus
```

WorkingState 必须成为长期任务的结构化状态源。

初期不要让模型自由覆盖整个 WorkingState。

优先通过确定性事件自动更新。

---

## 自动更新规则

### 读取文件成功

```text
tool = Read
status = success
→ filesRead 添加规范化路径
```

### 修改文件成功

```text
tool = Edit / Write
status = success
→ filesChanged 添加规范化路径
```

### 测试成功

```text
测试命令 exitCode = 0
→ verification.passed
```

### 测试失败

```text
测试命令 exitCode != 0
→ verification.failed
→ unresolved 添加失败摘要
```

### 子任务阻塞

```text
AgentRun / WorkerRun = blocked
→ unresolved 添加阻塞原因
```

### 架构决策

只有显式 `decision.recorded` 事件可以更新 decisions。

不得从普通聊天文本自动推断所有决定。

---

## P1-7：上下文组装

模型上下文应逐步变成：

```text
稳定 System Prompt
+ 当前 ExecutionRun 摘要
+ WorkingState
+ 最近原始消息
+ 当前任务相关 Artifact
+ 必要的历史记忆
```

不得继续完全依赖自由文本压缩摘要。

不得：

* 把摘要伪装成 user 消息；
* 创造不存在的 assistant 确认消息；
* 将失败事实压缩掉；
* 将未完成事项改写成已完成。

---

## P1-8：WorkingState 压缩不变量

增加测试确保压缩前后不丢失：

```text
objective
constraints
confirmedFacts
decisions
filesChanged
verification.failed
unresolved
nextActions
artifacts
```

可以压缩：

* 重复描述；
* 已过时过程日志；
* 冗余工具输出；
* 已被 Artifact 持久化的大文本。

不得压缩掉：

* 用户约束；
* 验证失败；
* 未解决阻塞；
* 未提交修改；
* 当前分支和 commit；
* 关键文件路径。

---

# 十一、Workflow 接入 ExecutionRun

## P1-9：每个 Workflow Step 创建子 Run

结构：

```text
WorkflowRun
├── StepRun: analyze
├── StepRun: implement
├── StepRun: test
└── StepRun: deliver
```

每一步必须：

* 有独立状态；
* 有输入快照；
* 有输出 Artifact；
* 有错误；
* 有持续时间；
* 有资源声明；
* 可取消。

---

## P1-10：禁止同步阻塞 Shell

如果 Workflow 当前使用 `execSync`：

* 改成统一 Shell Worker；
* 支持流式输出；
* 支持 AbortSignal；
* 支持超时；
* 创建 ShellRun；
* 结果使用 StructuredToolResult。

---

## P1-11：Workflow 最终状态

增加：

```ts
type WorkflowStatus =
  | 'succeeded'
  | 'succeeded_with_warnings'
  | 'failed'
  | 'blocked'
  | 'cancelled'
```

`continueOnError` 后完成的工作流不能与完全成功等价。

---

# 十二、ModuleManager 严格依赖语义

## P2-1：循环依赖处理

关键模块发生循环依赖：

```text
Engine boot 必须失败
```

不得把循环模块放进 best-effort 层继续启动。

输出完整依赖环：

```text
moduleA → moduleB → moduleC → moduleA
```

---

## P2-2：关键级别

```ts
interface ModuleMetadata {
  dependencies: string[]

  criticality:
    | 'critical'
    | 'best_effort'
}
```

### critical

* 初始化失败阻止 Engine boot；
* Hook 失败影响当前 Run；
* 必须记录结构化错误。

### best_effort

* 失败记录事件；
* 不阻塞主链；
* 支持重试策略。

---

## P2-3：模块重试

增加可选：

```ts
interface ModuleRetryPolicy {
  maxAttempts: number
  cooldownMs: number
  backoff?: number
}
```

不要让一次临时初始化失败导致模块在整个 Engine 生命周期永久失效。

---

# 十三、模型运行配置收敛

## P2-4：禁止各组件复制模型状态

检查：

* Engine；
* ModelGateway；
* ContextManager；
* Reflection；
* Critic；
* Provider；
* 模块。

建立共享状态：

```ts
interface RuntimeModelState {
  model: string
  provider: string

  capabilities: ModelCapabilities

  contextWindow: number
  maxOutput: number

  pricing?: ModelPricing

  version: number
}
```

组件持有对 RuntimeModelState 的引用或订阅更新。

不得通过类型断言修改其他组件的私有字段。

---

## P2-5：模型切换事务

```text
验证目标模型存在
→ 解析 Provider
→ 加载 capabilities
→ 计算上下文窗口
→ 校验工具能力
→ 通知组件 prepare
→ 原子提交 RuntimeModelState
→ 清理旧缓存
→ 发出 model.changed 事件
```

任何一步失败：

```text
保持旧模型完整状态
```

不能出现部分组件已经切换、部分仍使用旧模型。

---

# 十四、恢复语义必须真实

## P2-6：区分“识别失联”和“恢复运行”

如果当前重启后只是：

```text
发现 running/waiting Run
→ 标记 failed
```

则项目只能宣传：

> 崩溃后状态识别。

不能宣传：

> 自动故障恢复。

---

## P2-7：可重连 Worker

对 Claude tmux、后台进程实现：

```ts
reattach(descriptor)
```

重启后：

```text
读取非终态 Run
→ 读取 WorkerDescriptor
→ 检查 tmux session / PID 是否存在
→ 存在则重新连接
→ 不存在则标记 lost
```

建议增加状态：

```text
lost
```

区别于普通 `failed`。

---

# 十五、测试要求

不得仅增加单元测试。

必须建立以下测试。

## A. ExecutionRun 接线测试

```text
1. Engine 启动后 Registry 永远存在
2. Turn 创建 TurnRun
3. Turn 内调用 AgentTool 创建 child AgentRun
4. AgentRun.parentRunId 等于 TurnRun.id
5. ClaudeCodeTool 创建 child ExternalWorkerRun
6. ToolRun、VerificationRun、DeliveryRun 父子关系正确
```

## B. Worktree 隔离测试

```text
1. Worktree 创建失败时 Agent 不启动
2. 修改型 Agent 不得写主工作区
3. 两个修改型 Agent 使用不同 worktree
4. 一个 Agent 失败不会污染另一个
5. merge 冲突后 Run = blocked
6. merge 冲突后成果分支仍保留
7. read_only Agent 无 Write/Edit
```

## C. Claude Worker 测试

```text
1. wait:false 后 Run = waiting
2. detached Run 保留 session 映射
3. status(runId) 查询真实状态
4. steer(runId) 能发送到正确任务
5. 旧任务 DONE 不会误匹配
6. 同一 tmux session 连续任务不会串线
7. cancel 后 Run = cancelled
8. Worker 最终失败会更新原 Run
```

## D. Verification 测试

```text
1. typecheck 失败 → verification_failed
2. lint 失败 → verification_failed
3. test 失败 → verification_failed
4. 验证失败禁止 merge
5. 验证成功才进入 delivering
6. 非零 Bash exitCode 不得 success
```

## E. ResourceScheduler 测试

```text
1. 两个 read claim 可以并发
2. read/write 冲突不能并发
3. write/write 冲突不能并发
4. exclusive 阻塞所有同 key 资源
5. 多资源申请不死锁
6. Abort 后释放所有锁
7. timeout 后释放所有锁
8. Tool 异常后 finally 释放锁
```

## F. WorkingState 测试

```text
1. Read 成功更新 filesRead
2. Edit 成功更新 filesChanged
3. 测试失败更新 verification.failed
4. blocked Run 更新 unresolved
5. compact 后约束不丢失
6. compact 后失败项不丢失
7. 大型 Artifact 不直接塞入上下文
```

## G. 恢复测试

```text
1. tmux session 存在时可 reattach
2. tmux session 丢失时 Run = lost
3. 主进程重启后 Run tree 可重新加载
4. 事件 sequence 不重复
5. 部分 JSONL 写入可以安全忽略或恢复
```

---

# 十六、故障注入

主动模拟：

* Worktree 创建失败；
* Git merge 冲突；
* Git 分支被删除；
* tmux Session 丢失；
* Claude 无完成标记；
* Claude 输出旧的 DONE；
* Worker 卡死；
* ToolScheduler 被取消；
* 验证命令超时；
* EventStore 写入失败；
* Context compact 中断；
* ResourceScheduler 获取一半资源后取消；
* Engine 在 Worker 运行时崩溃。

每种故障必须明确：

```text
Run 最终状态
资源是否释放
成果是否保留
是否可重试
是否产生 Artifact
父 Run 如何收到失败
```

---

# 十七、禁止事项

不得：

* 新增大量与目标无关的工具；
* 重写 UI；
* 重写所有 Provider；
* 同时迁移所有 Memory；
* 用 TODO 代替实际实现；
* 删除兼容代码但不完成迁移；
* 把所有逻辑重新塞进 Engine；
* 创建新的上帝类；
* 使用文本正则代替已有结构化状态；
* 依赖子 Agent 自称成功；
* 通过删除测试或弱化断言完成任务；
* 在验证失败时继续自动合并；
* 在 Worktree 失败时写主目录；
* 把异步派发视为任务成功。

---

# 十八、实施顺序

必须按以下顺序进行，除非源码验证证明依赖关系不同。

## Phase 1：ExecutionRun 主链接线

完成：

* Registry 始终存在；
* 初始化顺序修复；
* ExecutionContext 动态传递；
* Agent/Claude 创建真实子 Run；
* 父子 Run 测试。

## Phase 2：Worktree 与 Delivery 正确性

完成：

* 修改型任务 fail-closed；
* task mode；
* merge 失败 blocked；
* 成果保留；
* 强制 Verification Gate。

## Phase 3：Claude Worker 生命周期

完成：

* detached waiting；
* status/steer/cancel/collect；
* taskId；
* run/session 映射；
* WorkerAdapter 扩展。

## Phase 4：ResourceScheduler 主链接入

完成：

* Tool 资源声明；
* ToolScheduler 获取锁；
* finally 释放；
* 冲突和死锁测试。

## Phase 5：StructuredToolResult 收敛

完成：

* 内部统一结果；
* Bash 退出码；
* 旧 content/isError 兼容层。

## Phase 6：WorkingState 接入

完成：

* 工具事件自动更新；
* ContextManager 注入；
* compact 不变量；
* Artifact 按需加载。

## Phase 7：Workflow 和恢复能力

完成：

* Workflow Step Run；
* Shell Worker；
* reattach；
* lost 状态；
* 崩溃测试。

不要并行展开所有 Phase。

每个 Phase 必须形成可测试闭环后再进入下一阶段。

---

# 十九、每轮工作记录

维护：

```text
docs/runtime-audit/
├── architecture-map.md
├── confirmed-issues.md
├── implementation-plan.md
├── migration-status.md
├── test-matrix.md
└── unresolved-risks.md
```

同时维护 ADR：

```text
docs/decisions/
```

每个重大决定记录：

```text
背景
问题
候选方案
选择
放弃方案
后果
迁移方式
回滚方式
```

---

# 二十、每阶段输出格式

每完成一个 Phase，输出：

## 1. 验证结果

逐项标记：

```text
CONFIRMED
PARTIALLY_CONFIRMED
ALREADY_FIXED
NOT_REPRODUCIBLE
DESIGN_RISK
```

## 2. 根因

说明为什么原实现会出现问题。

## 3. 实施方案

说明实际选择的架构与兼容策略。

## 4. 修改文件

列出文件与关键函数。

## 5. 测试结果

必须包含实际执行命令：

```text
命令
通过数量
失败数量
耗时
新增测试
```

## 6. 架构审计

检查：

* 是否新增重复状态源；
* 是否新增上帝类；
* 是否存在假成功；
* 是否存在 fail-open；
* 是否泄漏资源；
* 是否破坏向后兼容；
* 是否仍依赖自然语言解析状态。

## 7. 未完成事项

不得隐藏失败或剩余风险。

## 8. 下一阶段入口条件

只有入口条件满足才能继续下一 Phase。

---

# 二十一、最终验收标准

最终必须满足：

```text
1. ExecutionRunRegistry 始终存在
2. Turn、Tool、Agent、Worker、Workflow Step 都有 Run
3. Run 父子关系真实可查询
4. 修改型 Agent 强制隔离
5. Worktree 失败时 fail-closed
6. 验证失败绝不成功
7. merge 失败进入 blocked
8. Claude detached 任务保持非终态
9. Worker 支持 status/steer/cancel/collect
10. ResourceScheduler 接入 ToolScheduler
11. 工具并发由资源冲突决定
12. StructuredToolResult 是唯一内部状态源
13. WorkingState 接入上下文主链
14. 上下文压缩不丢关键状态
15. Workflow 每一步拥有独立 Run
16. AbortSignal 贯穿完整执行链
17. 资源在所有失败路径释放
18. 崩溃后可识别 lost Worker
19. 可重连的 Worker 能 reattach
20. README 中的架构能力有真实测试支持
```

---

# 二十二、最终项目定位

本轮完成后，项目不应继续主要定位为：

> 拥有大量工具和命令的 Claude Code 仿制品。

而应定位为：

> 一个面向长期编码任务，支持异构模型 Worker、结构化任务状态、隔离执行、资源调度、中途干预、自动验证、失败传播和运行恢复的多 Agent Coding Runtime。

现在立即开始：

1. 拉取并读取当前完整仓库；
2. 建立当前实际架构地图；
3. 验证 ExecutionRun 是否真正接入 AgentTool 和 ClaudeCodeTool；
4. 添加能够暴露问题的失败测试；
5. 优先完成 Phase 1；
6. Phase 1 全量验证通过后继续 Phase 2；
7. 不要在仅完成分析、接口定义或部分骨架后停止。
