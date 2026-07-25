你现在是 `ovolv999_coding_pro` 项目的高级 Agent Runtime 架构师、可靠性工程师和无人值守运行负责人。

本轮版本目标：

# v0.3.4 Durable Loop Supervisor & Outcome Unification

项目当前已经具备：

* RuntimeCoordinator；
* CompletionContract；
* CompletionVerdict；
* RunScopedRuntimeContext；
* TaskGraph；
* ModelRouter；
* Provider fallback；
* Native Loop；
* 外部 loop-kit；
* 独立验收；
* stale lock 检测；
* 基础 circuit breaker；
* 确定性 Eval。

本轮禁止继续增加新的大型 Agent 功能。

本轮只解决一个目标：

> 使任务完成状态、子 Agent 状态、Loop 状态和 Driver 验收保持一致，并让后台循环具备可靠锁、Heartbeat、Checkpoint、崩溃恢复、退避和安全停止能力。

不要询问用户，不等待人工确认。必须先写失败测试，再修改实现。

---

# 一、无人值守安全约束

必须在当前独立 Worktree 和独立分支中工作。

禁止：

* 修改或合并 main；
* force push；
* 自动 push；
* 修改 Git remote；
* reset --hard 用户工作；
* 删除未提交用户文件；
* 使用 `git clean -fdx`；
* 降低测试强度；
* 删除失败测试；
* 修改 Acceptance 来让任务通过；
* 给失败命令添加 `|| true`；
* 使用模型自我声明作为完成证据。

每完成一个可独立验证的阶段，创建一个小提交：

```text
runtime(v0.3.4): <phase summary>
```

模型只能创建：

```text
.loop/CANDIDATE_DONE.flag
```

只有 Supervisor 在完成全部验收后才能创建：

```text
.loop/DONE.flag
```

---

# 二、Phase 0：建立失败基线

创建：

```text
docs/V0_3_4_DURABLE_SUPERVISOR.md
```

先读取并追踪以下真实调用链：

```text
ExecutionEngine.runTurn
→ RuntimeCoordinator
→ CompletionContract
→ TurnResult
→ Hook / Module
→ AgentTool / WorkerRuntime
→ LoopEngine
→ LoopSupervisor
→ Acceptance
→ DONE / PARKED
```

同时追踪：

```text
ModelGateway
→ initial attempt
→ fallback attempt
→ usage/cost attribution
→ ModelRouter health
```

在修改代码前增加能够暴露以下问题的失败测试。

## 必须先失败的测试

1. 子 Agent 返回 `completionStatus=blocked` 时不得被视为成功；
2. 子 Agent 返回 `partial` 时不得自动合并 Worktree；
3. Loop 收到 `blocked` 时，即使测试通过也不得创建 DONE；
4. Loop 收到 `partial` 时只能继续或 PARKED；
5. Loop Prompt 不得要求模型创建 DONE；
6. 模型自行创建 DONE 必须被忽略并记录安全事件；
7. 缺失 GOAL 后退出不得遗留 lock；
8. Acceptance 抛异常后不得遗留 lock；
9. Loop 主体抛异常后不得遗留 lock；
10. Heartbeat 停止后锁可以被安全接管；
11. PID 被复用时不得把新进程误认为旧 Supervisor；
12. 崩溃恢复后从上一次 iteration 继续；
13. 崩溃恢复后保留连续失败计数；
14. 崩溃恢复后不重复执行已经完成的阶段；
15. Agent Prompt 与 Driver 使用相同 Acceptance hash；
16. Acceptance 更新后下一轮 Prompt 必须看到新内容；
17. 60 秒以上的合法测试不会被默认错误终止；
18. Provider 连续失败时执行退避，而不是高速循环；
19. 达到 Provider 失败预算后进入 PARKED；
20. Run Context 在 Hook 完成后才关闭。

禁止仅测试单独 helper。关键测试必须穿过真实 LoopEngine 或 AgentTool 主路径。

---

# 三、Phase 1：建立强类型 TurnOutcome

当前不得继续使用可选字符串字段作为完成状态的主要接口。

在真实公共类型中定义：

```typescript
export type CompletionStatus =
  | "completed"
  | "partial"
  | "blocked"
  | "failed"
  | "cancelled"
  | "exhausted";

export interface TurnOutcome {
  runId: string;

  stopReason:
    | "stop_sequence"
    | "length"
    | "max_iterations"
    | "cancelled"
    | "error";

  completion: {
    status: CompletionStatus;
    reasons: string[];
    evidence: CompletionEvidence[];
    requiredNextActions: string[];
  };

  output: string;
  changedFiles: string[];
  artifacts: string[];
  verification: VerificationState;
  modelAttempts: ModelCallAttempt[];
}
```

要求：

1. `ExecutionEngine.runTurn()` 返回 `TurnOutcome`；
2. `RuntimeCoordinator` 返回 `TurnOutcome`；
3. `ChildEngineLike` 返回 `TurnOutcome`；
4. `AgentTool` 使用 `completion.status`；
5. `WorkerRuntime.collect()` 返回 `TurnOutcome`；
6. Hook 接收 `TurnOutcome`；
7. Module 完成阶段接收 `TurnOutcome`；
8. Native Loop 使用 `TurnOutcome`；
9. 外部 Loop Adapter 使用 `TurnOutcome`；
10. Eval 使用 `TurnOutcome`；
11. CLI 显示 `completion.status`；
12. `/trace` 保存同一个状态；
13. RunRegistry 从同一个状态映射；
14. 不得继续通过 `reason !== "error"` 判断任务成功。

允许暂时保留兼容字段，但必须：

* 由 TurnOutcome 单向派生；
* 标记 deprecated；
* 不允许新代码读取旧字段；
* 增加 ESLint 或静态测试阻止新增读取。

---

# 四、Phase 2：统一子 Agent 完成语义

修改 `AgentTool`、进程内 Worker、Claude Worker 和其他子 Agent Adapter。

## 子 Agent 成功条件

只有：

```text
completion.status === completed
```

才允许进入自动验证与合并候选阶段。

## partial

行为：

* 保存输出；
* 保存 patch；
* 保存 Worktree；
* 返回父 Agent；
* 不自动合并；
* 父 Agent决定继续、补充任务或人工检查。

## blocked

行为：

* 保留完整阻塞原因；
* 保留 Worktree；
* 不自动合并；
* 父 Agent可以创建解除阻塞子任务；
* 不得转换成普通成功。

## failed / cancelled / exhausted

不得自动合并。

## 合并条件

```text
child completed
+
child acceptance satisfied
+
verification passed
+
no unresolved reviewer blocker
+
parent ResourceScheduler grants merge lock
```

增加：

```text
AGENT_COMPLETION_ACCEPTED
AGENT_COMPLETION_REJECTED
AGENT_MERGE_STARTED
AGENT_MERGE_COMPLETED
AGENT_WORKTREE_PRESERVED
```

---

# 五、Phase 3：Loop 联合完成门

Native Loop 的最终完成条件必须同时满足：

```text
TurnOutcome.completion.status === completed
+
CANDIDATE_DONE exists
+
Acceptance contract non-empty
+
all Acceptance commands pass
+
all quality gates pass
+
no active critical workers
+
no unfinished critical TaskGraph nodes
+
working tree state is understood
```

任何一项不满足都不得创建 DONE。

## 状态处理

### completed + gates passed

创建 DONE。

### completed + gates failed

继续修复，不得 DONE。

### partial

继续下一轮；达到停滞预算后 PARKED。

### blocked

检查是否存在自动可解除条件。

无法自动解除时 PARKED。

### exhausted

保存状态并 PARKED，不得伪装 completed。

### failed

依据错误类型重试或 PARKED。

### cancelled

安全清理后退出，不得 DONE。

## 修正 Prompt

Loop Prompt 必须明确写：

```text
你不得创建 .loop/DONE.flag。
完成候选只能创建 .loop/CANDIDATE_DONE.flag。
最终完成由外部 Supervisor 独立判断。
```

删除所有要求模型写入 DONE 的旧文本。

模型自行创建 DONE 时：

1. 不接受；
2. 重命名为安全审计文件或删除；
3. 发出 `UNTRUSTED_DONE_FLAG_DETECTED`；
4. 不因此消耗一次完整迭代；
5. 不将其视为模型恶意，只视为协议违规。

---

# 六、Phase 4：Durable Lease Lock

将简单 PID 锁升级为租约锁。

锁内容至少包括：

```typescript
interface LoopLease {
  schemaVersion: number;
  ownerToken: string;
  pid: number;
  hostname: string;
  cwd: string;
  taskId: string;
  createdAt: string;
  heartbeatAt: string;
  processStartFingerprint: string;
}
```

## 创建锁

使用原子方式：

```text
open with exclusive create / wx
```

不得：

```text
existsSync → writeFileSync
```

因为这存在竞争窗口。

## 接管规则

只有同时满足以下条件才能接管：

* heartbeat 超过阈值；
* 原 PID 不存在，或 process fingerprint 不匹配；
* owner token 不属于当前实例；
* checkpoint 可读取；
* 没有活跃 Worker 仍持有该租约。

## 释放规则

整个 LoopSupervisor 必须使用最外层：

```typescript
acquireLease();

try {
  await runSupervisor();
} finally {
  await terminateOwnedWorkers();
  await persistFinalCheckpoint();
  releaseLeaseIfOwnerTokenMatches();
}
```

任何提前 return、异常、Ctrl+C、SIGTERM、GOAL 缺失、Acceptance 错误都必须进入 finally。

不得删除不属于当前 owner token 的锁。

---

# 七、Phase 5：Supervisor Heartbeat

实现 Supervisor 自身 Heartbeat，而不仅是子 Agent Heartbeat。

配置：

```typescript
interface HeartbeatConfig {
  intervalMs: number;
  staleAfterMs: number;
  writeTimeoutMs: number;
}
```

Heartbeat 内容：

* 当前 iteration；
* 当前 runId；
* 当前 phase；
* 最近有意义进展时间；
* 当前命令；
* 当前 Worker 数量；
* Provider circuit 状态；
* 最近 checkpoint sequence。

使用原子临时文件替换。

Heartbeat 写入失败连续达到阈值时：

* 记录错误；
* 停止启动新任务；
* 尝试最终 checkpoint；
* PARKED。

增加命令：

```text
/loop-status
```

显示：

* owner；
* heartbeat age；
* iteration；
* phase；
* last progress；
* last outcome；
* current command；
* failure budgets。

---

# 八、Phase 6：Checkpoint 与恢复

新增：

```text
.loop/checkpoint.json
```

结构至少包含：

```typescript
interface LoopCheckpoint {
  schemaVersion: number;
  sequence: number;
  taskId: string;
  branch: string;
  worktree: string;

  iteration: number;
  phase: string;
  runId?: string;

  goalHash: string;
  acceptanceHash: string;
  commandsHash?: string;

  lastOutcome?: SerializedTurnOutcome;
  lastCommit?: string;
  changedFiles: string[];

  consecutiveNoProgress: number;
  consecutiveProviderFailures: number;
  consecutiveCommandFailures: number;
  repeatedErrorFingerprints: Record<string, number>;

  activeWorkers: RecoverableWorkerReference[];
  unfinishedTaskNodes: SerializedTaskNode[];

  createdAt: string;
  updatedAt: string;
}
```

## 持久化时机

至少在以下节点写 checkpoint：

* 每轮开始；
* 模型调用结束；
* 工具批次结束；
* 子 Agent完成；
* 测试结束；
* Git commit 后；
* CompletionVerdict 产生后；
* 进入 PARKED 前；
* 正常退出前。

采用：

```text
write temp
→ flush
→ rename
```

不得直接覆盖唯一 checkpoint。

保留最近一个备份：

```text
checkpoint.previous.json
```

## 恢复规则

重启后：

1. 校验 schema；
2. 校验 Task ID；
3. 校验 Worktree；
4. 校验 branch；
5. 校验 goalHash；
6. 校验 acceptanceHash；
7. 校验 Git HEAD；
8. 恢复失败预算；
9. 恢复 TaskGraph；
10. 尝试 reattach 可恢复 Worker；
11. 无法恢复的 Worker 标记 lost；
12. 不重复执行已有证据证明完成的阶段。

外部合同发生变化时不得静默沿用旧状态。

提供：

```text
--resume
--restart
--discard-checkpoint
```

---

# 九、Phase 7：动态合同和配置

每轮在构建 Agent Prompt 前重新读取：

* GOAL；
* ACCEPTANCE；
* COMMANDS；
* PITFALLS；
* Budget；
* Supervisor config。

必须使用同一份内容：

```text
read contract
→ hash contract
→ place exact content in prompt
→ execute turn
→ before final verification, confirm hash
```

不得：

```text
Prompt 使用旧 Acceptance
Driver 验证新 Acceptance
```

## 合同变更

默认行为：

* 用户在外部修改合同：下一轮接受新合同并记录 `CONTRACT_UPDATED`；
* Agent 在工作区修改合同：记录风险并 PARKED，除非配置显式允许；
* 合同为空：blocked；
* 合同解析失败：PARKED；
* 不得默认全部通过。

---

# 十、Phase 8：项目感知质量门

将质量门分为：

```text
fast gates
full gates
release gates
```

## fast gates

每轮执行，示例：

```text
typecheck
lint
targeted tests
```

## full gates

Completion Candidate 时执行：

```text
pnpm test
pnpm eval:deterministic
pnpm build
```

## release gates

仅发布或用户明确要求时执行。

质量门来源优先级：

1. `.loop/ACCEPTANCE.md`；
2. `.loop/COMMANDS.md`；
3. package scripts；
4. 仓库语言和构建系统；
5. 显式 Supervisor config。

不要重复执行相同命令。

## 可配置超时

支持每条命令单独设置：

```text
timeout: 10m
```

默认值不得固定为 60 秒。

示例：

```text
typecheck: 5m
lint: 5m
unit tests: 15m
full tests: 30m
eval: 30m
build: 15m
```

超时不是普通测试失败，应返回：

```text
timed_out
```

并保留 stdout/stderr、运行时间和进程树终止结果。

---

# 十一、Phase 9：Provider 后台容错

将模型调用结果正式表示为 attempt chain：

```typescript
interface ModelCallAttempt {
  profileId: string;
  provider: string;
  model: string;
  startedAt: number;
  endedAt: number;
  status:
    | "succeeded"
    | "rate_limited"
    | "timed_out"
    | "unavailable"
    | "invalid_request"
    | "context_limit"
    | "unsupported"
    | "failed";
  usage?: TokenUsage;
  estimatedCost?: number;
  error?: SerializedError;
}
```

要求：

1. 初始失败模型只记录一次失败；
2. fallback 成功模型只记录一次成功；
3. Usage 归实际响应模型；
4. Cost 归实际响应模型；
5. 不得按 `modelAtStart` 统一记账；
6. 不得在两个回调中重复统计；
7. 返回完整 attempt chain；
8. Router 健康度由 attempt 更新；
9. 跨 Provider 与同 Endpoint fallback 明确区分；
10. 不能执行的 fallback profile 在请求前剔除。

## Supervisor 退避

Provider 连续失败时：

```text
1 次 → 普通 fallback
2 次 → 短退避
3 次 → 指数退避 + jitter
达到预算 → PARKED
```

最高退避时间可配置。

退避期间：

* 写 Heartbeat；
* 保持租约；
* 不高速创建新 Run；
* 可以执行不依赖模型的本地验证；
* 不烧 Token。

Circuit breaker 半开时只允许一个探测请求。

---

# 十二、Phase 10：修正 Run Context 生命周期

当前 RunScopedRuntimeContext 必须覆盖完整 Run 生命周期：

```text
boot
→ routing
→ model/tool execution
→ reviewer
→ critic
→ completion evaluation
→ registry transition
→ module completion
→ hook completion
→ event persistence
→ final outcome serialization
→ close context
```

不得在 Reviewer、CompletionContract、Module 或 Hook 前关闭 Context。

使用整个 `runTurn()` 外层的 try/finally：

```typescript
const context = createContext();

try {
  return await executeFullRun(context);
} finally {
  await persistContextSnapshot(context);
  await stopRunWorkers(context);
  runContextStore.close(context.runId);
}
```

如果 Hook 失败：

* CompletionVerdict 不丢失；
* Run 状态明确记录 Hook failure；
* Context 最终释放；
* 不得将已成功任务无条件改成失败；
* 根据 Hook criticality 处理。

---

# 十三、Phase 11：终态事件语义

停止无条件发送含义模糊的 `RUN_COMPLETED`。

建议事件：

```text
RUN_SUCCEEDED
RUN_PARTIAL
RUN_BLOCKED
RUN_FAILED
RUN_CANCELLED
RUN_EXHAUSTED
```

或者统一：

```text
RUN_TERMINATED { status }
```

但不得让 `RUN_COMPLETED` 同时表示“执行循环结束”和“任务成功完成”。

严格顺序：

```text
RUN_STARTED
→ RUN_EXECUTION_STARTED
→ MODEL/TOOL/WORKER EVENTS
→ RUN_EXECUTION_STOPPED
→ REVIEW_COMPLETED
→ CRITIC_COMPLETED（可选）
→ COMPLETION_EVALUATED
→ RUN_STATUS_TRANSITIONED
→ MODULE_COMPLETED
→ HOOK_COMPLETED
→ RUN_TERMINATED
→ CONTEXT_CLOSED
```

终态事件只能出现一次。

---

# 十四、Phase 12：强端到端测试

至少增加以下进程级或真实主链测试：

1. completed + gates pass → DONE；
2. completed + gates fail → continue；
3. blocked + gates pass → no DONE；
4. partial + gates pass → no DONE；
5. exhausted → PARKED；
6. child blocked → no merge；
7. child partial → preserve Worktree；
8. model-created DONE rejected；
9. missing GOAL releases lock；
10. acceptance parse error releases lock；
11. thrown engine error releases lock；
12. stale heartbeat allows takeover；
13. live heartbeat prevents takeover；
14. PID reuse does not prevent takeover；
15. wrong owner token cannot remove lock；
16. checkpoint survives forced process termination；
17. resume starts from saved iteration；
18. resume preserves failure budgets；
19. resume does not repeat completed command；
20. invalid checkpoint uses previous backup；
21. updated Acceptance reaches Prompt and Driver；
22. empty Acceptance blocks；
23. long command uses configured timeout；
24. timed-out command kills full process tree；
25. Provider failures use exponential backoff；
26. circuit breaker half-open permits one probe；
27. Provider budget exceeded creates PARKED；
28. fallback usage attributed to final model；
29. Run Context available during Hook；
30. Context closes after Hook；
31. terminal event matches CompletionStatus；
32. terminal event emitted once；
33. Ctrl+C writes final checkpoint；
34. SIGTERM releases owned lease；
35. 50 sequential runs leave no child processes or Run Contexts。

禁止弱断言和允许多个互斥结果的模糊断言。

---

# 十五、验收命令

最终必须实际执行：

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm eval:deterministic
pnpm build
```

另外执行新增的进程级 Supervisor 测试。

不得声称未运行的命令通过。

如果完整测试因环境或外部依赖不能运行：

* 记录准确失败命令；
* 保存 stdout/stderr；
* 写 PARKED；
* 不得创建 CANDIDATE_DONE。

---

# 十六、停止条件

## DONE 候选

只有实现完成并且所有验收通过后，模型创建：

```text
.loop/CANDIDATE_DONE.flag
```

Supervisor 二次验证后创建 DONE。

## PARKED

以下情况进入 PARKED：

* 同一根因连续三轮无法解决；
* Provider 失败预算耗尽；
* 合同损坏或被非授权修改；
* 需要用户决定兼容性方案；
* 需要外部凭据；
* 发现会破坏用户代码的迁移风险；
* 测试环境无法完成关键验收。

PARKED 必须包含：

```text
根因
当前 phase
已完成工作
失败测试
最后 commit
恢复命令
建议选择
```

## MAX ITERATIONS

达到上限时：

* 写最终 checkpoint；
* 释放 Worker；
* 释放 lease；
* 不创建 DONE；
* 输出未完成验收项。

---

# 十七、最终报告

完成后输出：

## Baseline failures

修改前哪些测试失败，以及对应根因。

## Outcome unification

说明 TurnOutcome 如何传播到 CLI、Agent、Loop、Hook、Module 和 Eval。

## Supervisor durability

说明 Lease、Heartbeat、Checkpoint 和恢复过程。

## Completion gate

说明模型候选、CompletionVerdict 和外部 Acceptance 如何联合决定 DONE。

## Provider resilience

说明 attempt、fallback、退避、circuit breaker 和成本归属。

## Event timeline

分别给出：

* 成功；
* blocked；
* Provider 故障；
* 崩溃恢复；

四种事件时间线。

## Tests

列出全部实际执行命令和结果。

## Remaining limitations

只列真实限制，不得输出笼统的“全部完成”。

现在开始执行，不等待人工确认。

