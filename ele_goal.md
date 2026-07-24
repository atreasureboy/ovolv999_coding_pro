你现在是 `ovolv999_coding_pro` 项目的高级 Coding Agent Runtime 架构师和主要实现者。

仓库：

https://github.com/atreasureboy/ovolv999_coding_pro

本轮版本目标：

# v0.3.2 Runtime Object Identity & Semantic Truth

当前项目已经实现：

* ModelRouter；
* RoutingSignalCollector；
* Provider fallback；
* TaskGraph / TaskGraphStore；
* TaskPlanTool；
* CompletionContract；
* ProgressMonitor；
* InternalControlMessage；
* Critic / Reviewer；
* 类型化事件；
* 确定性 Eval。

本轮禁止继续横向增加大型功能。

目标是解决：

> 模块分别实现了正确能力，但不同模块可能引用不同的 Run、TaskGraph、模型调用结果和完成状态。

本轮完成后必须保证：

1. 一次 Run 中所有组件引用同一个 RunScopedContext；
2. TaskPlanTool 和 CompletionContract 操作同一张 TaskGraph；
3. 路由器消费的全部信号都来自真实 Runtime；
4. fallback 的失败、成功、Token、成本归属准确；
5. CompletionVerdict 成为 CLI、Hook、Module、RunRegistry 和 Eval 的唯一完成语义；
6. 事件发生顺序与真实生命周期一致；
7. 所有“Fully wired”声明都有真正端到端断言。

---

## 一、Phase 0：先建立失败测试

修改实现前，先增加以下能够暴露当前问题的测试。

### 1. TaskGraph identity test

通过真实：

```text
ExecutionEngine
→ RuntimeCoordinator
→ Fake Provider
→ TaskPlan tool call
```

执行：

```text
TaskPlan add
TaskPlan start
TaskPlan begin_verification
TaskPlan complete
```

断言：

* Tool 修改的是当前 `runId` 对应的图；
* `default` 图没有节点；
* CompletionContract 读取的是同一个图；
* 第二个 Run 不继承第一个 Run 的节点。

禁止直接调用 `store.create()` 冒充端到端测试。

### 2. Mutation false-success test

用户目标：

```text
Fix the bug in src/a.ts and add a test.
```

Fake Provider 不调用任何修改工具，直接返回 stop。

断言：

```text
taskKind === mutation
completion.status !== completed
RunStatus !== succeeded
```

### 3. Fallback attribution test

模拟：

```text
strong-model → 429
cheap-model → success + usage
```

断言：

* strong-model：一次失败；
* cheap-model：一次成功；
* usage 归 cheap-model；
* cost 归 cheap-model；
* 不得重复统计；
* 不得把 fallback 成功模型记录为失败。

### 4. Completion critic test

模拟模型：

```text
执行修改
→ 返回 stop_sequence
```

启用 CriticModule。

断言：

* `CRITIC_INVOKED` 一定发生；
* 发生在最终 `RUN_COMPLETED` 之前；
* Critic 拒绝时 Runtime 继续执行；
* Critic 通过后才允许完成。

### 5. Event order test

严格断言：

```text
RUN_STARTED
<
MODEL_REQUESTED
<
TOOL_COMPLETED
<
REVIEW_COMPLETED
<
COMPLETION_EVALUATED
<
REGISTRY_TRANSITIONED
<
RUN_COMPLETED
```

blocked 场景最终必须是 `RUN_BLOCKED`，不得仍发语义上的 `RUN_COMPLETED`。

### 6. Routing signal round-trip test

构造每一个 RoutingSignals 字段为非默认值。

断言经过：

```text
collectRoutingSignals
→ signalsToRoutingInput
→ ModelRouter.route
```

后字段没有丢失。

先确保以上测试在旧代码上失败，再开始实现。

---

# 二、Phase 1：引入 RunScopedRuntimeContext

新增：

```typescript
interface RunScopedRuntimeContext {
  runId: string;
  parentRunId?: string;
  taskKind: TaskKind;
  taskGraph: TaskGraph;
  progressMonitor: ProgressMonitor;
  controlMessages: ControlMessageLog;
  routingSignals: RoutingSignals;
  completionCandidate?: CompletionCandidate;
  completionVerdict?: CompletionVerdict;
  startedAt: number;
}
```

建立：

```typescript
RunScopedRuntimeContextStore {
  create(runId, options): RunScopedRuntimeContext
  get(runId): RunScopedRuntimeContext
  restore(runId): RunScopedRuntimeContext
  close(runId): void
}
```

要求：

1. 每次 Run 在 boot 前创建 Context；
2. Coordinator 不得通过修改共享的 `this.deps.taskGraph` 切换当前图；
3. ToolContext 中增加当前 RunScopedRuntimeContext 或 resolver；
4. Tool、CompletionContract、ProgressMonitor、Router 从同一个 Context 获取状态；
5. Run 完成后可关闭 Context；
6. 崩溃恢复时可以重新绑定 EventSink 和 ProgressMonitor；
7. 不得新增第二套 RunRegistry。

---

# 三、Phase 2：修复 TaskGraph 对象身份

## 2.1 TaskPlanTool 不得持有固定 TaskGraph

删除：

```typescript
constructor(private readonly taskGraph?: TaskGraph)
```

改为注入：

```typescript
interface TaskGraphResolver {
  resolve(runId: string): TaskGraph;
}
```

执行时：

```typescript
const runId = ctx.execution?.runId;
const graph = resolver.resolve(runId);
```

缺少 runId 时：

* 测试环境可以显式提供 fallback；
* 生产环境不得静默使用 `default`；
* 返回清晰 ToolError。

## 2.2 Store 创建时统一接线

TaskGraphStore 支持 graph initializer：

```typescript
setGraphInitializer(
  initializer: (graph: TaskGraph, runId: string) => void
): void
```

每次 `create()` 和 `restore()` 都必须：

* `setRunId(runId)`；
* 绑定 RunEventEmitter；
* 绑定 ProgressMonitor；
* 绑定持久化 sink；
* 校验 snapshot schema。

不得只给 default 图调用 `setNodeTransitionSink()`。

## 2.3 恢复语义

`restore()` 必须恢复：

* runId；
* nodes；
* attempts；
* artifacts；
* block/fail reason；
* acceptance evidence；
* event sequence；
* sinks。

恢复完成后新事件必须继续使用正确 runId。

## 2.4 状态机一致性

明确：

```text
pending → ready → running → verifying → completed
```

异常路径：

```text
running/verifying → failed
running → blocked
blocked → ready/pending
failed → pending（retry）
任意非终态 → cancelled
```

禁止：

* pending 直接 verifying；
* completed 再次 start；
* cancelled retry；
* 未运行节点直接 complete，除非显式 atomic node。

统一终态定义。

建议：

```text
completed / failed / cancelled = terminal
blocked = suspended，不属于 done
```

或者明确选择 blocked 为终态，但 `isDone()`、`hasUnfinished()`、`snapshot.done`、`pruneTerminal()` 必须完全一致。

新增事件：

```text
TASK_NODE_UNBLOCKED
TASK_NODE_RETRIED
TASK_NODE_CANCELLED
TASK_ARTIFACT_ATTACHED
```

不得使用：

```text
unblock → TASK_NODE_ADDED
cancel → TASK_NODE_FAILED
```

---

# 四、Phase 3：任务意图必须在执行前确定

新增：

```typescript
type TaskKind = "informational" | "analysis" | "mutation";
```

新增：

```typescript
interface TaskIntent {
  kind: TaskKind;
  requestedOutcomes: string[];
  explicitAcceptanceCriteria: AcceptanceCriterion[];
  requiresWorkspaceChange: boolean;
  expectedVerification: VerificationRequirement[];
  confidence: number;
}
```

TaskIntent 在 Run 开始时生成，来源包括：

* 用户原始目标；
* CLI 模式；
* `/goal` 元数据；
* 上层 Agent 委派参数；
* 明确的只读/计划模式；
* 可选分类模型。

不得根据执行后是否有 changedFiles 决定 taskKind。

最低规则：

```text
解释、总结、回答 → informational
审计、分析、设计方案 → analysis
修复、实现、修改、重构、删除、添加 → mutation
```

规则置信度不足时可以调用模型分类，但分类结果必须结构化并记录事件：

```text
TASK_INTENT_CLASSIFIED
```

Mutation 任务没有产生修改时不得 completed。

---

# 五、Phase 4：CompletionVerdict 成为唯一终态

修改 `TurnResult`。

建议：

```typescript
interface TurnOutcome {
  runId: string;
  stopReason:
    | "stop_sequence"
    | "length"
    | "max_iterations"
    | "interrupted"
    | "error";
  completion: CompletionVerdict;
  output: string;
  changedFiles: string[];
  verification: VerificationState;
  artifacts: string[];
}
```

要求：

1. `stop_sequence` 只表示模型停止生成；
2. CLI 显示 CompletionVerdict；
3. Hook 接收 TurnOutcome；
4. Module `runComplete()` 接收 TurnOutcome；
5. AgentTool 根据 `completion.status` 判断子 Agent 是否成功；
6. Eval 根据 CompletionVerdict 评分；
7. RunRegistry 状态由同一个 Verdict 映射；
8. 不得存在另外一套 `reason !== error` 成功判断。

状态映射：

```text
completed → succeeded
partial → blocked 或 partial 状态
incomplete → blocked
blocked → blocked
failed → failed
cancelled → cancelled
exhausted → exhausted/blocked，但必须保留原始语义
```

必要时扩展 RunStatus，避免将所有非成功状态都压缩成 blocked。

---

# 六、Phase 5：真实验收证据

当前不能只按：

```typescript
node.status === "completed"
```

将节点所有标准统一视为满足。

增加：

```typescript
interface CriterionEvidence {
  criterionId: string;
  status: "unknown" | "satisfied" | "failed";
  evidenceType:
    | "test"
    | "command"
    | "file-change"
    | "review"
    | "user-confirmation"
    | "manual";
  evidenceRef?: string;
  recordedAt: number;
}
```

TaskNode 单独保存每个 criterion 的状态和证据。

`TaskPlan complete` 必须提供：

```text
criterion id
evidence
artifact / verification reference
```

不得只回传与原字符串相同的 `satisfiedCriteria` 就视为真实满足。

Reviewer 必须统计真正未满足的标准，而不是所有标准总数。

Mutation 默认完成策略：

```text
有修改
+
验收标准满足
+
执行适合的验证
+
没有失败验证
```

确实无法验证时只能：

* partial；
* 或 completed-with-unverified，仅在配置明确允许时使用。

---

# 七、Phase 6：修复路由信号数据流

## 6.1 完整转换

`signalsToRoutingInput()` 必须传递：

* providerHealth；
* previousRoutingFailures；
* expectedToolRequirement；
* affectsPublicInterface；
* isCrossModule；
* isConfigChange；
* requiresRootCause；
* estimatedImpactFiles；
* taskGraphScale；
* 其他已经定义的字段。

增加类型级 exhaustiveness test，新增 RoutingSignals 字段而未映射时让测试或编译失败。

## 6.2 使用真实信号

替换占位数据：

```typescript
contextUsageRatio: 0
budgetRemaining: 1
previousRoutingFailures: 0
repoFileCount: filesTouched * 10
```

真实来源：

* ContextManager 当前 Token 估算；
* CostTracker/BudgetTracker；
* ModelRouter fallback history；
* 仓库索引或缓存文件计数；
* 当前 Run TaskGraph；
* TaskIntent；
* WorkingState。

## 6.3 调整执行顺序

正确顺序：

```text
创建 Run
→ 创建 RunScopedRuntimeContext
→ 创建本轮 TaskGraph
→ 识别 TaskIntent
→ 收集 RoutingSignals
→ 路由模型
→ boot
→ 首次 LLM call
```

不得在当前 Run TaskGraph 创建前收集 TaskGraph 信号。

## 6.4 同模型也应用预算

即使：

```text
decision.selectedModel === currentModel
```

仍然要应用：

* BudgetAllocation；
* route event；
* reasonCodes；
* fallback chain；
* context policy。

模型切换与路由决策应用不能等价。

建议拆分：

```typescript
applyRoutingDecision(decision: RoutingDecision)
```

内部再判断是否需要切换模型。

---

# 八、Phase 7：修复 fallback 统计

修改 ModelGateway 返回：

```typescript
interface ModelCallAttempt {
  model: string;
  startedAt: number;
  endedAt: number;
  success: boolean;
  error?: string;
  usage?: TokenUsage;
}

interface ModelCallOutcome {
  streamResult: StreamResult;
  finalModel: string;
  attempts: ModelCallAttempt[];
}
```

要求：

1. 初始模型失败记录一次失败；
2. fallback 成功模型记录一次成功；
3. Token/Cost 归实际产生 usage 的模型；
4. 不得同时在 `onUsage` 和 call 结束后重复 `recordCall()`；
5. 429、timeout、5xx 分开记录；
6. fallback chain 的每次尝试产生事件；
7. fallback 成功后健康分提高；
8. fallback 失败后继续下一项，直到配置上限；
9. 只允许在模型请求尚未产生工具副作用时 fallback；
10. `/models` 显示 calls、successes、failures、latency、lastError。

事件：

```text
MODEL_ATTEMPT_STARTED
MODEL_ATTEMPT_FAILED
MODEL_ATTEMPT_SUCCEEDED
ROUTING_FALLBACK_APPLIED
```

---

# 九、Phase 8：Completion Candidate 与 Critic

状态机增加：

```text
llm_call
→ completion_candidate
→ critic/reviewer
→ completion_evaluation
→ complete 或 continue
```

当 LLM 返回无工具的 stop 时：

1. 不立即终止 Run；
2. 形成 CompletionCandidate；
3. 执行 deterministic Reviewer；
4. 根据风险决定是否调用 Critic；
5. 调用 CompletionContract；
6. 如果 rejected，生成 InternalControlMessage；
7. 回到下一轮 LLM；
8. 只有 accepted 才发最终完成事件。

Critic 必须在同一轮 stop 之后立即运行，不得等待不存在的下一次 `module_iteration`。

CriticModule 未启用时：

* deterministic Reviewer 和 CompletionContract 仍必须工作；
* 不得伪造 `CRITIC_INVOKED`。

端到端测试必须真实断言：

```typescript
expect(events).toContain("CRITIC_INVOKED")
```

不能只订阅但不检查。

---

# 十、Phase 9：事件生命周期重排

禁止在 CompletionContract 前发送语义上的 `RUN_COMPLETED`。

建议事件顺序：

```text
RUN_STARTED
RUN_EXECUTION_STARTED
MODEL_REQUESTED
MODEL_COMPLETED
TOOL_STARTED
TOOL_COMPLETED
RUN_EXECUTION_STOPPED
REVIEW_COMPLETED
CRITIC_INVOKED（可选）
CRITIC_COMPLETED（可选）
COMPLETION_EVALUATED
RUN_STATUS_TRANSITIONED
RUN_COMPLETED / RUN_PARTIAL / RUN_BLOCKED / RUN_FAILED
```

要求：

* 每个事件带 runId；
* 有单调 sequence；
* 终态事件只允许一次；
* `/trace` 按事件顺序显示；
* EventStore 恢复后不重复终态事件；
* Hook 在终态事件确定后运行。

---

# 十一、Phase 10：强化端到端测试

现有单元测试保留。

新增真正穿过主链的测试：

1. TaskPlanTool 修改当前 run graph；
2. 两轮连续运行无 TaskGraph 污染；
3. TaskGraph restore 后继续产生正确 runId 事件；
4. mutation 无变更不得成功；
5. analysis 无 patch 可以成功；
6. informational 不要求验证；
7. acceptance evidence 缺失不得完成；
8. verification failed 不得完成；
9. fallback 统计正确；
10. fallback cost 归属正确；
11. 同模型路由预算仍应用；
12. 所有 RoutingSignals 完整到达 Router；
13. completion-time critic 真正调用；
14. critic 拒绝后继续运行；
15. TurnOutcome 与 RunRegistry 状态一致；
16. Hook 收到 CompletionVerdict；
17. AgentTool 使用 CompletionVerdict 判断子 Agent；
18. 事件顺序严格正确；
19. blocked graph 不被错误 prune；
20. restore 后 sinks 正常工作。

禁止以下弱断言：

```typescript
expect(health === undefined || health.calls >= 0).toBe(true)
expect(result.reason).toBeOneOf(["stop_sequence", "error"])
expect(events.includes(A) || events.includes(B)).toBe(true)
```

必须断言准确预期值。

---

# 十二、文档真实性

更新：

```text
docs/V0_3_2_RUNTIME_OBJECT_IDENTITY.md
docs/INTERVIEW_DEMO.md
docs/V0_3_1_RUNTIME_TRUTH.md
README.md
```

将以下能力在真正修复前标记为 Partially wired：

* TaskGraphStore per-run 主路径；
* TaskGraph event replay；
* TaskGraph → ProgressMonitor；
* RoutingSignalCollector 全信号消费；
* Provider fallback health attribution；
* Completion-time Critic；
* CompletionContract 上层传播。

每项 Fully wired 声明必须包含：

```text
入口
对象身份来源
真实调用链
端到端测试
失败测试
限制
```

---

# 十三、最终验收

必须满足：

1. TaskPlanTool 不再持有 default TaskGraph；
2. 所有 Run 组件通过 runId 解析同一个 Context；
3. 当前 Run 图在路由前创建；
4. create 和 restore 都自动绑定 sinks；
5. TaskGraph 状态与事件语义一致；
6. TaskIntent 在执行前确定；
7. mutation 无修改不得 completed；
8. CompletionVerdict 出现在 TurnOutcome；
9. Hook、Module、AgentTool、CLI、Eval 使用相同 Verdict；
10. 每个 acceptance criterion 有独立证据；
11. 所有路由信号完整传输；
12. 不再使用 context/budget/fallback 占位常量；
13. 同模型路由也能应用预算；
14. fallback 失败和成功统计正确；
15. fallback Token/Cost 归属正确；
16. completion-time critic 在 stop 后、终态前执行；
17. Critic 拒绝可恢复执行；
18. RUN_COMPLETED 在 CompletionContract 后发出；
19. 终态事件只出现一次；
20. 新增至少 20 个强端到端回归用例；
21. 删除弱断言；
22. typecheck、lint、unit、integration、deterministic eval 全部实际执行；
23. 文档 Fully wired 声明与代码一致。

---

# 十四、执行优先级

```text
P0
RunScopedRuntimeContext
TaskPlanTool 当前图解析
TaskIntent 前置分类
CompletionVerdict 上层传播
fallback 统计修复

P1
完整 RoutingSignals
Completion Candidate / Critic
事件顺序
TaskGraph 恢复与状态语义

P2
验收证据细化
文档与面试展示
扩大 Eval
```

不得先更新文档声明，再留下 P0 对象身份错误。

---

# 十五、最终输出

完成后必须输出：

## Baseline failures

列出修改前能够复现的失败测试。

## Object identity

说明每个组件如何获得当前 runId、TaskGraph 和 RunScopedContext。

## Completion semantics

说明用户意图如何转换为 TaskIntent，以及如何产生最终 CompletionVerdict。

## Routing and fallback

列出真实信号、模型尝试、健康与成本归属。

## Event timeline

给出成功、blocked、fallback 三种完整事件序列。

## Tests

列出实际执行命令和结果。

## Remaining limitations

明确列出仍未完成的事项。

不得仅输出“25/25 完成”或测试总数。

