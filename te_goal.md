你现在是 `ovolv999_coding_pro` 项目的高级 Coding Agent Runtime 架构师和主要实现者。

仓库：

https://github.com/atreasureboy/ovolv999_coding_pro

本轮版本目标：

# v0.3.1 Runtime Truth & Integration

上一轮已经实现：

* ModelRouter；
* TaskGraph；
* TaskPlan；
* ProgressMonitor；
* StallDetector；
* CompletionContract；
* Critic；
* Reviewer；
* `/route`、`/models`、`/tasks`、`/trace`、`/why`；
* 确定性 Eval。

本轮不得继续横向堆叠大型功能。

目标是：

> 让上述能力真正接入唯一主执行链，修复“模块存在但没有真实控制 Runtime”的问题，使代码行为、测试、文档和面试声明完全一致。

---

## 一、强制原则

1. 先读取当前真实代码，不要仅根据本 Prompt 修改。
2. 不得删除上一轮已经实现的高级能力。
3. 不得新建第二套 Router、TaskGraph、ProgressMonitor、CompletionContract 或 EventStore。
4. 不得只增加类型、接口、注释或 TODO。
5. 所有修复必须接入真实 `ExecutionEngine → RuntimeCoordinator` 路径。
6. 关键行为必须有失败测试和成功测试。
7. 不得用模型自我声明作为任务完成证据。
8. 不得为了保持旧测试通过而保留错误语义。
9. 需要兼容时应增加明确的 compatibility adapter，而不是继续双轨运行。
10. 每个阶段完成后运行相关测试。
11. 最终必须实际执行 typecheck、lint、unit、integration 和 deterministic eval。
12. 未实际运行的命令不得声称通过。

---

# 二、Phase 0：建立当前失败基线

首先创建：

```text
docs/V0_3_1_RUNTIME_TRUTH.md
```

记录：

* 当前真实模型路由调用链；
* 模型切换如何影响 ProviderAdapter；
* TaskGraph 的创建和销毁周期；
* CompletionContract 当前调用位置；
* ProgressMonitor 的所有数据输入；
* CriticModule 与新 CriticTrigger 是否同时运行；
* `/trace` 和 `/why` 的真实数据来源；
* Eval 当前验证了什么、没有验证什么。

在修改代码前，先为以下已知风险编写回归测试，使测试能够真实暴露问题：

1. 自动路由一次后不应变成人工 override；
2. 第二轮任务不应继承第一轮 TaskGraph；
3. 未满足 acceptance criteria 时不得 succeeded；
4. Run 状态 blocked 时，TurnResult 不得仍被统计为成功；
5. 不同 Provider 的 profile 不得仅通过修改 model 字符串切换；
6. Provider fallback 不得重新执行已经完成的工具调用；
7. `/why` 不得输出没有真实决策记录支持的结论。

先看到测试失败，再实施修复。

---

# 三、Phase 1：修复 ModelRouter 主执行链

## 1.1 分离人工切换与自动切换

当前不得继续让自动路由调用会设置 manual override 的 `setModel()`。

拆分为：

```typescript
setModelByUser(modelOrProfile: string): void
applyRoutingDecision(decision: RoutingDecision): void
clearModelOverride(): void
```

语义：

### setModelByUser

用于：

* CLI `--model`；
* `/model`；
* 用户显式选择。

行为：

* 设置 sticky manual override；
* 切换模型运行时；
* 产生 `MODEL_OVERRIDE_SET` 事件。

### applyRoutingDecision

仅用于 Router。

行为：

* 不设置 manual override；
* 应用本轮路由；
* 产生 `ROUTING_DECISION_APPLIED`；
* 下一轮仍允许重新路由。

### clearModelOverride

用于：

```text
/model auto
/route auto
```

清除人工覆盖并恢复自动路由。

增加测试：

* 自动路由连续三轮可以选择不同模型；
* 自动选择不会产生 manual override；
* `/model xxx` 会锁定；
* `/model auto` 会恢复；
* 路由模型与当前模型相同时不重复发事件。

---

## 1.2 ProviderRuntimeBinding

不要把跨 Provider 切换等价于修改 `config.model`。

定义：

```typescript
interface ProviderRuntimeBinding {
  profileId: string;
  provider: string;
  model: string;
  baseURL?: string;
  apiKeyRef?: string;
  adapter: ProviderAdapter;
  capabilities: ModelCapabilities;
}
```

增加统一的：

```typescript
ModelRuntimeManager
```

职责：

* 根据 ModelProfile 构造或复用 ProviderAdapter；
* 切换当前 binding；
* 管理不同 Provider 的 client；
* 通知 ContextManager；
* 通知 ModuleManager；
* 重置 ModelGateway provider-specific 状态；
* 保证失败时事务回滚。

如果本轮不准备实现跨 Provider Client 管理，则必须：

1. 在配置验证阶段拒绝不同 Provider 的 profile；
2. 明确报错；
3. 不得让 Router 选择无法执行的 profile；
4. README 明确写成“同 Endpoint 模型路由”。

不得保留“配置上允许跨 Provider，但运行时实际不支持”的状态。

---

## 1.3 传入真实路由信号

创建：

```typescript
RoutingSignalCollector
```

在每轮路由时收集：

* userGoal；
* repoFileCount；
* filesTouched；
* recentFailureCount；
* contextUsageRatio；
* budgetRemaining；
* task role；
* needsArchitecture；
* provider health；
* previous routing failures；
* expected tool requirement。

不得只传 `userGoal`。

`needsArchitecture` 可以使用规则作为一个信号，但不得完全依赖关键词。

应结合：

* 预估影响文件数；
* 是否涉及公共接口；
* 是否跨模块；
* 是否修改配置/架构；
* 是否要求根因定位；
* 任务图规模。

---

## 1.4 健康统计与 fallback

ModelGateway 每次调用完成后必须记录：

```typescript
modelRouter.recordCall(
  profileId,
  success,
  latencyMs,
  usage
)
```

实现真实 fallback：

```text
请求建立失败
429
Provider timeout
Provider unavailable
模型不支持 tool calling
→ 尝试 fallbackChain 下一项
```

要求：

* fallback 仅重试尚未产生工具副作用的模型请求；
* 已执行工具后不得重放整轮；
* 每次 fallback 产生结构化事件；
* 达到失败阈值后降低 profile 健康分；
* `failureEscalationThreshold` 必须真正参与决策；
* `/models` 显示真实健康数据；
* 所有 profile 不可用时返回明确错误。

---

# 四、Phase 2：CompletionContract 成为唯一真相

Coordinator 不得继续手写另一套 `completionBlockers` 判断。

唯一入口：

```typescript
const verdict = evaluateCompletion(input)
```

定义统一输入：

```typescript
interface CompletionInput {
  taskKind: "informational" | "analysis" | "mutation";
  modelStopped: boolean;
  acceptanceCriteria: AcceptanceCriterion[];
  verification: VerificationState;
  taskGraph: TaskGraphSnapshot;
  activeWorkers: WorkerSummary[];
  unresolvedBlockers: string[];
  changedFiles: string[];
  reviewerFindings: string[];
  budgetState: BudgetState;
}
```

输出：

```typescript
interface CompletionVerdict {
  status:
    | "completed"
    | "partial"
    | "blocked"
    | "failed"
    | "cancelled"
    | "exhausted";
  reasons: CompletionReason[];
  evidence: CompletionEvidence[];
  unsatisfiedCriteria: string[];
  requiredNextActions: string[];
}
```

## 要求

1. `stop_sequence` 只代表模型停止，不代表任务完成。
2. Coordinator、RunRegistry、TurnResult、Reviewer 和 Eval 全部使用同一个 verdict。
3. 不得出现 Run 为 blocked，但 Eval 通过 `reason === stop_sequence` 判成功。
4. 删除 `unsatisfiedAcceptance: 0` 等硬编码。
5. Reviewer 结果必须参与最终 verdict，而不只是打印 warning。
6. 失败验证必须阻止 completed。
7. 正在运行的关键 Worker 必须阻止 completed。
8. 未完成 TaskGraph 节点必须阻止 completed。
9. 已声明的 acceptance criteria 未满足必须阻止 completed。
10. max iterations 映射为 exhausted，不是 completed。
11. blocked、partial 和 exhausted 必须在 CLI 中明确显示。

## 区分任务类型

### informational

例如：

* 解释代码；
* 回答问题；
* 分析架构。

不要求文件修改，也不强制执行测试。

### mutation

例如：

* 修 bug；
* 增加功能；
* 重构；
* 修改配置。

至少需要：

* 变更证据；
* acceptance criteria；
* 合适的验证，或明确说明为什么不能验证。

### analysis

例如：

* 仓库审计；
* 风险分析；
* 设计方案。

需要输出对应分析证据，但不要求 patch。

不得为了兼容问答任务而整体绕过 CompletionContract。

---

# 五、Phase 3：TaskGraph 按 Run 隔离

TaskGraph 不得继续作为整个 ExecutionEngine 生命周期共享的全局任务图。

实现：

```typescript
TaskGraphStore {
  create(runId): TaskGraph
  get(runId): TaskGraph
  restore(runId): TaskGraph
  close(runId): void
}
```

Coordinator 每轮创建独立图，并把对应 graph 放入 ToolContext。

`TaskPlanTool` 必须依据当前 `execution.runId` 获取图，而不是持有构造时的永久全局实例。

## 完整状态机

```text
pending
→ ready
→ running
→ verifying
→ completed
```

异常路径：

```text
running → failed
running → blocked
running → cancelled
verifying → failed
failed → ready（满足 retry policy）
blocked → ready（阻塞解除）
```

增加 TaskPlan action：

* add；
* start；
* update；
* begin_verification；
* complete；
* fail；
* block；
* unblock；
* retry；
* cancel；
* attach_artifact；
* list。

要求：

1. pending 节点不得直接 completed，除非明确允许 atomic task。
2. acceptance criteria 未满足时，`complete` 返回 tool error。
3. 工具返回结果必须与节点实际状态一致。
4. blocked、failed、cancelled 是否属于终态必须统一定义。
5. `isDone()`、`hasUnfinished()`、snapshot summary 必须语义一致。
6. 未知 dependency 默认报错，不得永久挂起。
7. 父子路径和资源 claims 使用统一 ResourceScheduler 语义。
8. TaskGraph 操作产生事件。
9. 崩溃恢复后可从事件重建图。
10. `/tasks` 支持：

```text
/tasks
/tasks <runId>
/tasks history
```

---

# 六、Phase 4：完善 ProgressMonitor 和 Critic

## 4.1 数据接线

ProgressMonitor 必须接收：

* tool call；
* tool result；
* changed patch hash；
* verification result；
* TaskNode 状态变化；
* acceptance criteria 状态变化；
* Worker 结果；
* model fallback；
* replan；
* artifact。

确保真实调用：

```typescript
recordVerification()
setAcceptanceCriteria()
recordTaskProgress()
recordArtifact()
recordWorkerResult()
```

## 4.2 更可靠的停滞检测

不得只识别连续完全相同的工具调用。

增加滑动窗口 fingerprint，识别：

```text
A → B → A → B
Read X → Bash test → Read X → Bash test
同一个错误以不同参数反复出现
多个 Agent 给出同一失败结论
```

同一文件继续产生新的 patch hash，应被视为新进展。

只有重复读取且内容未变化，才不算进展。

## 4.3 Critic 单轨化

审计旧 `CriticModule` 与新 `CriticTrigger`。

不得同时存在：

```text
固定每 N 轮 Critic
+
风险触发 Critic
```

形成两套独立机制。

保留统一的：

```typescript
CriticController
```

触发条件：

* soft/hard stall；
* repeated error；
* 大范围 patch；
* 核心架构修改；
* completion candidate；
* Worker 结果冲突；
* acceptance criteria 未满足。

模型准备停止时，必须使用：

```typescript
modelClaimingCompletion: true
```

执行 completion-time critic。

Critic 的意见必须作为内部控制数据处理，不得伪装成用户消息，也不得永久污染用户会话。

---

# 七、Phase 5：内部控制消息

实现正式：

```typescript
InternalControlMessage
```

类型至少包括：

* continue_after_length；
* retry_empty_response；
* budget_warning；
* stall_replan；
* critic_feedback；
* tool_recovery；
* completion_rejected；
* provider_fallback。

要求：

* 与 `OpenAIMessage[]` 用户会话分离；
* 不进入长期记忆；
* 不显示为用户发言；
* ProviderAdapter 调用前临时渲染；
* 调用结束后不永久留在公开 history；
* Context compaction 能保存必要的控制状态，但不伪造角色；
* 会话导出中明确区分 runtime event 与 user message。

---

# 八、Phase 6：真正的事件可观测性

增加类型化事件：

```text
ROUTING_DECIDED
ROUTING_APPLIED
ROUTING_FALLBACK
MODEL_CALL_RECORDED

TASK_GRAPH_CREATED
TASK_NODE_ADDED
TASK_NODE_STARTED
TASK_NODE_VERIFYING
TASK_NODE_COMPLETED
TASK_NODE_FAILED
TASK_NODE_BLOCKED

PROGRESS_RECORDED
STALL_DETECTED
REPLAN_REQUESTED
CRITIC_INVOKED
CRITIC_COMPLETED

COMPLETION_EVALUATED
COMPLETION_REJECTED
REVIEW_COMPLETED
```

## `/trace`

不得再只是读取几个对象当前状态。

应当：

1. 获取当前或指定 runId；
2. 从 EventStore 读取有序事件；
3. 重建时间线；
4. 显示模型路由、工具、TaskGraph、Worker、验证、stall、fallback、completion；
5. 支持：

```text
/trace
/trace <runId>
/trace <runId> --json
```

## `/why`

必须读取结构化决策事件回答：

* 为什么选择这个模型；
* 为什么 fallback；
* 为什么创建 TaskGraph；
* 为什么调用 Critic；
* 为什么重新规划；
* 为什么完成；
* 为什么 blocked；
* 哪个验收标准未满足。

不得使用硬编码模板冒充真实证据。

## `/progress`

实现缺失的 `/progress`：

* 当前有意义进展；
* 距离上次进展时间；
* 验收标准；
* TaskGraph；
* 验证变化；
* stall 风险；
* 剩余预算。

同时审计 SlashCommand 注册表，检测重复 command name 和 alias。开发模式下重复注册必须直接报错，不能静默覆盖。

---

# 九、Phase 7：扩大确定性 Eval

现有 Eval 保留，但重新定义为：

```text
wiring-smoke
```

新增至少以下确定性 Eval：

1. 自动路由连续多轮，不产生 manual override；
2. 手工 model override 优先；
3. 跨 Provider 非法配置被拒绝；
4. Provider 429 后安全 fallback；
5. fallback 不重复工具副作用；
6. 第一轮 TaskGraph 不污染第二轮；
7. acceptance criteria 未满足时 false-success 被阻止；
8. verification failed 时 blocked；
9. informational Q&A 不因无文件修改失败；
10. mutation task 无验证时 partial 或 blocked；
11. A-B-A-B 工具循环触发 stall；
12. completion-time critic 被调用；
13. EventStore 能恢复 TaskGraph；
14. `/trace` 根据真实事件生成；
15. `/why` 不输出无证据结论。

Eval 不要预先完全脚本化正确工具轨迹。

可以分别设置：

```text
deterministic-runtime-eval
scripted-wiring-smoke
optional-real-model-eval
```

把 baseline 移至：

```text
evals/baselines/*.json
```

增加：

```json
{
  "eval:wiring": "...",
  "eval:deterministic": "...",
  "eval:real": "...",
  "check": "typecheck + lint + unit + integration + deterministic eval"
}
```

`eval:real` 默认不进入 CI，但命令必须存在，并输出可比较报告。

---

# 十、Phase 8：文档真实性

完成实现后更新：

```text
docs/V0_3_ADAPTIVE_RUNTIME.md
docs/V0_3_1_RUNTIME_TRUTH.md
docs/INTERVIEW_DEMO.md
README.md
```

逐项标记：

* Fully wired；
* Partially wired；
* Experimental；
* Planned。

不得继续声称尚未实现的：

* 跨 Provider fallback；
* TaskGraph 事件恢复；
* 完整 CompletionContract；
* 完整事件 Trace；
* 真实 Agent 能力 Eval。

`INTERVIEW_DEMO.md` 中每个能力声明都要附：

```text
入口文件
关键类
真实调用路径
对应测试
当前限制
```

同步修正 package metadata，使 package name、description、version 与项目真实定位一致，同时保持 CLI 命令兼容。

---

# 十一、最终验收

必须满足：

1. 自动路由不会创建 manual override；
2. 自动路由可连续多轮重新决策；
3. 用户显式选择仍具有最高优先级；
4. 跨 Provider profile 可以真实切换，或在配置阶段明确拒绝；
5. Router 接收真实运行信号；
6. 健康、延迟和失败数据真实更新；
7. fallback 可测试且不重复副作用；
8. Coordinator 真正调用 CompletionContract；
9. Run、TurnResult、Reviewer 和 Eval 使用同一个最终 verdict；
10. acceptance criteria 不再硬编码为零；
11. TaskGraph 按 runId 隔离；
12. TaskPlan 状态转换严格；
13. TaskGraph 可事件化恢复；
14. ProgressMonitor 接收验证和任务节点变化；
15. 能检测非连续重复循环；
16. completion-time critic 生效；
17. 不存在两套 Critic 调度；
18. 内部控制消息不污染用户历史；
19. `/trace` 基于事件回放；
20. `/why` 基于真实决策证据；
21. `/progress` 可用；
22. 重复 SlashCommand 注册会被检测；
23. 至少 15 个确定性 Runtime Eval；
24. 文档与真实能力一致；
25. typecheck、lint、unit、integration、deterministic eval 全部实际通过。

---

# 十二、执行优先级

```text
P0
自动路由 manual-override bug
Provider/model binding
CompletionContract 单一真相
TaskGraph 按 Run 隔离
false-success Eval

P1
真实路由信号
fallback
ProgressMonitor 数据接线
Critic 单轨化
InternalControlMessage

P2
事件 Trace
完整 Eval 矩阵
文档和 package metadata
```

不要先做 P2 的展示层，再留下 P0 的错误执行语义。

---

# 十三、最终报告格式

完成后输出：

## Baseline failures

修改前哪些测试能够复现问题。

## Root causes

每个问题的真实根因。

## Runtime changes

按模块和文件说明修改。

## New execution flow

给出用户输入到最终 CompletionVerdict 的真实调用图。

## Tests

列出实际执行的所有命令和结果。

## Eval comparison

列出修改前后：

* false-success；
* routing accuracy；
* fallback success；
* stall detection；
* TaskGraph isolation；
* verification enforcement。

## Compatibility

说明配置、CLI、事件格式和历史数据影响。

## Remaining limitations

明确列出未完成项。

不得只输出“全部完成”或笼统总结。
