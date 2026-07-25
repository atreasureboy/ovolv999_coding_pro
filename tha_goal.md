你现在是 `ovolv999_coding_pro` 项目的高级 Coding Agent Runtime 架构师、测试负责人和无人值守运行维护者。

本轮版本目标：

# v0.3.3 Unattended Autonomy & Background Safety

本项目是面向个人长期使用和技术面试展示的超级 Coding Agent。

本轮将在无人值守模式下持续执行。不要询问用户，不要等待人工确认。遇到不确定问题时，优先：

1. 阅读真实代码；
2. 编写能够复现问题的测试；
3. 选择兼容性最好的实现；
4. 在无法安全继续时写入 PARKED 状态和完整原因；
5. 不得通过降低测试或验收标准假装完成。

本轮不以增加大量新功能为目标，而是让现有 Runtime 能够安全、稳定、可恢复地长期后台运行。

---

# 一、无人值守执行规则

## 1. Git 安全规则

必须在独立 Worktree 和独立分支工作。

禁止：

* 直接修改 main；
* force push；
* 自动 push；
* 自动合并到 main；
* reset --hard 用户已有工作；
* 删除用户未提交文件；
* 修改 Git remote；
* 重写历史；
* 使用 `git clean -fdx`。

每完成一个可以独立验证的阶段，创建一次小型提交。

提交信息格式：

```text
runtime(v0.3.3): <phase and change>
```

提交前必须运行该阶段相关测试。

## 2. 验收文件不可篡改

`.loop/ACCEPTANCE.md` 是外部验收合同。

禁止为了让任务通过而：

* 删除验收项；
* 修改验收命令；
* 将失败命令替换成更宽松命令；
* 给命令添加 `|| true`；
* 跳过测试；
* 删除失败测试；
* 降低断言强度；
* 将真实集成测试改为只测试 Mock。

发现验收配置本身错误时：

1. 不直接修改；
2. 在 `.loop/STATE.md` 中记录；
3. 写入 `.loop/PARKED.flag`；
4. 输出证据和建议修正方式。

## 3. 完成标志所有权

模型不得主动创建：

```text
.loop/DONE.flag
```

模型完成实现后只能创建：

```text
.loop/CANDIDATE_DONE.flag
```

真正的 `DONE.flag` 只能由外部 Loop Driver 在所有验收命令通过后创建。

如果当前 Driver 仍允许模型写 DONE，修复 Driver，使其只信任自己执行的验收结果。

## 4. 每轮工作规模

每轮只完成一个可验证工作包：

```text
审计
→ 复现测试
→ 最小实现
→ 相关测试
→ 更新状态
→ 提交
```

不得在一个提交里同时完成大量无关重构。

## 5. 停滞规则

以下情况视为停滞：

* 连续两轮没有有效代码变更；
* 连续两轮测试结果没有改善；
* 同一个错误重复出现三次；
* A → B → A → B 工具循环；
* 重复读取同一批文件而没有新结论；
* 连续启动多个子 Agent 得到相同失败结果；
* Provider 连续失败；
* 同一补丁被反复写入和撤销。

第一次停滞：

```text
总结证据
→ 更换策略
→ 创建根因子任务
```

第二次停滞：

```text
调用独立 Reviewer/Critic
→ 缩小修改范围
```

第三次仍无法推进：

```text
写入 PARKED.flag
→ 保存完整状态
→ 停止消耗 Token
```

---

# 二、Phase 0：真实基线与失败测试

首先读取：

* 当前提交；
* package.json；
* Runtime 架构文档；
* Loop Engine；
* loop-kit；
* Coordinator；
* RunScopedRuntimeContext；
* TaskGraph；
* TaskPlanTool；
* TaskIntent；
* ModelRouter；
* ModelGateway；
* CompletionContract；
* Hook 与 Module 生命周期；
* 当前 Eval。

创建：

```text
docs/V0_3_3_BACKGROUND_AUTONOMY.md
```

记录：

* 当前真实主执行链；
* 当前后台循环调用链；
* Run 状态所有者；
* TaskGraph 所有者；
* CompletionVerdict 消费者；
* Provider attempt 统计路径；
* DONE/PARKED 标志所有者；
* 恢复路径；
* 超时和取消路径；
* 当前失败测试。

先编写以下回归测试，确认旧行为能够暴露问题：

1. 中文 mutation 任务不得被识别为 informational；
2. 每个 Run 使用独立 ProgressMonitor；
3. 每个 Run 使用独立 ControlMessageLog；
4. TaskPlanTool 修改的图必须向当前 Run 的 ProgressMonitor 发事件；
5. CompletionVerdict 必须返回给 Loop；
6. blocked Run 不得被 Loop 当成完成；
7. 初始 Provider 失败、fallback 成功时统计归属正确；
8. 空 Acceptance 不得产生 DONE；
9. 模型创建 DONE.flag 不得绕过 Driver 验收；
10. 验收文件在循环过程中修改后应重新读取；
11. 挂起命令能够被 watchdog 终止；
12. Coordinator 异常后 Run Context 必须释放；
13. 连续 Run 不得累计旧 model call attempts；
14. 进程崩溃后可恢复 Loop 状态；
15. stale DONE/PARKED/lock 文件能够正确识别。

先看到旧实现测试失败，再修改代码。

---

# 三、Phase 1：RunScopedRuntimeContext 成为唯一状态源

每个 Run 必须只拥有一份：

* TaskIntent；
* TaskGraph；
* ProgressMonitor；
* ControlMessageLog；
* RoutingSignals；
* Model attempts；
* CompletionCandidate；
* CompletionVerdict；
* Worker references；
* Verification state。

Coordinator 不得再创建独立局部 ControlMessageLog。

Coordinator 不得使用 Engine 级全局 ProgressMonitor 处理 Run 数据。

禁止通过以下方式切换当前图：

```typescript
this.deps.taskGraph = currentGraph;
```

改为所有组件根据 runId 获取：

```typescript
const runtime = runContextStore.get(runId);
```

## TaskGraph 初始化器

每次创建或恢复 Run Context 时，都必须自动为 TaskGraph 绑定：

* runId；
* EventSink；
* ProgressMonitor Sink；
* persistence sink；
* ResourceScheduler；
* schema version。

不得只给 legacy/default TaskGraph 接线。

逐步删除生产路径中的 default TaskGraph。

如果为了兼容测试保留 default graph，必须：

* 仅在测试环境允许；
* 生产缺少 runId 时直接报错；
* 不得静默 fallback。

## 生命周期清理

所有 Run Context 清理必须放入可靠的 `try/finally`。

即使以下阶段抛出异常，也必须释放：

* Reviewer；
* Critic；
* CompletionContract；
* Hook；
* Module；
* EventStore；
* final output rendering。

关闭前先持久化最终状态。

`modelCallsThisRun`、fallback attempts 和临时控制消息必须在每次 Run 开始时清空。

---

# 四、Phase 2：CompletionVerdict 全链统一

定义最终返回类型：

```typescript
interface TurnOutcome {
  runId: string;
  stopReason:
    | "stop_sequence"
    | "length"
    | "max_iterations"
    | "cancelled"
    | "error";

  completion: CompletionVerdict;
  output: string;
  changedFiles: string[];
  verification: VerificationState;
  artifacts: string[];
  modelAttempts: ModelCallAttempt[];
}
```

以下组件必须只依据 `completion.status` 判断任务结果：

* CLI；
* Native Loop；
* External Loop Adapter；
* RunRegistry；
* Hook；
* Module；
* AgentTool；
* WorkerRuntime；
* Eval；
* Trace；
* Final Summary。

禁止继续使用以下逻辑判断成功：

```text
reason === stop_sequence
reason !== error
模型说已经完成
有 assistant 输出
没有抛异常
```

状态至少区分：

```text
completed
partial
blocked
failed
cancelled
exhausted
```

映射必须保持原始语义，不得把 partial、blocked、exhausted 全部压缩成成功。

Mutation 任务只有满足以下条件才能 completed：

1. 产生真实修改；
2. 验收条件有证据；
3. 执行适合的验证；
4. 没有失败验证；
5. 没有运行中的关键 Worker；
6. TaskGraph 没有未完成关键节点；
7. Reviewer 没有阻断问题。

---

# 五、Phase 3：中英文 TaskIntent

重构 TaskIntentClassifier。

至少支持中文和英文：

## Mutation

```text
修复
修改
实现
增加
新增
删除
重构
迁移
替换
优化代码
补充测试
改造
接入
完善
```

以及对应英文表达。

## Analysis

```text
审计
分析
检查
评估
设计
给出方案
研究
对比
解释架构
```

## Informational

```text
解释
说明
回答
总结
翻译
查询
```

不得仅依赖关键词。

综合使用：

* 用户原始目标；
* `/goal` 元数据；
* 任务来源；
* 是否要求修改仓库；
* 是否包含验收命令；
* 上层 Worker 的任务类型；
* 可选模型分类结果。

规则置信度低于阈值时，调用结构化分类模型。

分类失败时采用 fail-closed：

* 存在修改倾向时优先 mutation；
* 不得因为低置信度默认 informational。

增加中英文、混合语言和模糊表达测试。

---

# 六、Phase 4：Provider attempt 与 fallback 真相

ModelGateway 返回完整 attempt chain：

```typescript
interface ModelCallAttempt {
  profileId: string;
  provider: string;
  model: string;
  startedAt: number;
  endedAt: number;
  success: boolean;
  errorType?: string;
  statusCode?: number;
  usage?: TokenUsage;
  estimatedCost?: number;
}

interface ModelCallOutcome {
  finalProfileId: string;
  attempts: ModelCallAttempt[];
  streamResult: StreamResult;
}
```

要求：

1. 每次尝试有独立开始和结束时间；
2. 初始模型失败只记录一次失败；
3. fallback 模型成功只记录一次成功；
4. Token 和成本归实际产生 usage 的模型；
5. 不得在 `onUsage` 与结束处理里重复统计；
6. fallback 成功不得被 `providerFailed` 标记成失败；
7. fallback 失败后记录该失败；
8. 根据配置继续尝试后续模型；
9. 所有模型不可用时明确终止；
10. 不得重放已产生副作用的工具调用。

支持：

* 429；
* timeout；
* 5xx；
* connection reset；
* tool-calling unsupported；
* context limit；
* invalid model。

Provider 连续失败时使用指数退避和 circuit breaker，避免后台持续烧 Token 和请求额度。

---

# 七、Phase 5：Background Loop Supervisor

将 Native Loop 与 loop-kit 的通用控制能力收敛为一个 LoopSupervisor。

不要创建第三套循环实现。

## 5.1 每轮重新读取配置

每轮开始时重新读取：

* GOAL；
* ACCEPTANCE；
* COMMANDS；
* STATE；
* Trigger；
* Budget；
* Driver config。

Acceptance 为空时必须：

```text
blocked
```

不得默认通过。

## 5.2 独立完成门

正确流程：

```text
Agent 产生 CANDIDATE_DONE
→ Driver 重新读取 Acceptance
→ Driver 独立运行全部命令
→ Driver 检查 CompletionVerdict
→ Driver 检查 Git 状态
→ Driver 检查未完成节点
→ 全部通过
→ Driver 创建 DONE.flag
```

模型生成的 DONE.flag 必须：

* 被忽略；
* 记录安全事件；
* 删除或重命名；
* 不得直接停止循环。

## 5.3 项目感知质量门

不要硬编码只有 TypeScript 和 ESLint。

从以下位置确定质量门：

1. `.loop/ACCEPTANCE.md`；
2. package.json scripts；
3. 用户定义 COMMANDS；
4. 仓库语言和构建系统；
5. 当前 TaskIntent。

本项目最终至少执行：

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm eval:deterministic
pnpm build
```

允许拆分测试，但不得跳过。

## 5.4 超时和 Watchdog

增加：

* 单命令 timeout；
* 单轮 wall-clock timeout；
* Worker heartbeat；
* Supervisor heartbeat；
* 进程树终止；
* Windows/Linux 兼容；
* stale PID 检测；
* stale lock 恢复；
* 子进程清理；
* Ctrl+C 优雅保存；
* 系统关机信号处理。

超时必须可配置。

完整测试可能较慢，不得固定死为 60 秒。

## 5.5 失败预算

记录：

```text
consecutiveProviderFailures
consecutiveCommandFailures
consecutiveNoProgress
repeatedErrorFingerprint
totalReplans
totalFallbacks
```

超过阈值时：

* 保存 STATE；
* 保存 Trace；
* 写 PARKED；
* 停止运行。

不得无限重试。

## 5.6 状态恢复

持久化：

* 当前 phase；
* 当前 iteration；
* 当前 runId；
* TaskGraph；
* changed files；
* 最近测试；
* 当前失败；
* fallback 状态；
* 未完成验收；
* 最近 commit；
* Worker handles。

重启时从 checkpoint 恢复，不得从头重新执行已经完成的修改。

---

# 八、Phase 6：TaskGraph 状态与事件一致

统一 blocked 的语义。

建议：

```text
completed / failed / cancelled = terminal
blocked = suspended，不属于 done
```

确保以下方法完全一致：

* isDone；
* hasUnfinished；
* snapshot.summary.done；
* pruneTerminal；
* CompletionContract；
* Trace；
* recovery。

增加准确事件：

```text
TASK_NODE_UNBLOCKED
TASK_NODE_RETRIED
TASK_NODE_CANCELLED
TASK_NODE_VERIFICATION_STARTED
TASK_CRITERION_EVIDENCE_RECORDED
```

禁止继续使用：

```text
unblock → TASK_NODE_ADDED
cancel → TASK_NODE_FAILED
```

状态转换必须校验。

`complete()` 必须要求：

* 节点处于 running 或 verifying；
* 验收条件存在证据；
* 需要的验证已经完成。

---

# 九、Phase 7：长期运行 Eval

新增确定性后台运行评测：

1. 中文 mutation 分类；
2. 中文 analysis 分类；
3. 模糊中文任务 fail-closed；
4. 两个并行 Run 状态隔离；
5. 连续 20 个 Run 无 Context 泄漏；
6. model attempts 每 Run 重置；
7. fallback 统计准确；
8. fallback 成本准确；
9. 空 Acceptance 不完成；
10. 模型伪造 DONE 不完成；
11. Acceptance 运行中更新后重新读取；
12. 挂起命令被 watchdog 终止；
13. 子进程树被完整终止；
14. Provider 连续失败触发 circuit breaker；
15. 无进展触发 replan；
16. 重复失败触发 PARKED；
17. 崩溃后恢复 TaskGraph；
18. 崩溃后恢复 iteration；
19. blocked CompletionVerdict 不被 Loop 当成功；
20. Driver 通过全部验收后唯一创建 DONE；
21. stale lock 可恢复；
22. stale DONE 不污染新 Task；
23. Hook 异常后 Context 仍释放；
24. EventStore 异常后生成明确失败；
25. 长循环结束后无残留子进程。

禁止弱断言。

例如禁止：

```typescript
expect(a || b).toBe(true)
expect(value).toBeDefined()
expect(calls).toBeGreaterThanOrEqual(0)
```

应断言准确状态、次数、事件顺序和归属。

---

# 十、Phase 8：文档与面试展示

更新：

```text
docs/V0_3_3_BACKGROUND_AUTONOMY.md
docs/INTERVIEW_DEMO.md
README.md
```

新增一节：

# Unattended Coding Runtime

说明：

* 为什么普通 Agent 长任务容易提前停止；
* 如何检测有意义进展；
* 如何避免 false success；
* 如何进行独立验收；
* 如何处理 Provider 故障；
* 如何恢复崩溃任务；
* 如何终止完整进程树；
* 如何保证 Run 之间状态隔离；
* 为什么 Driver 拥有 DONE.flag；
* 为什么模型只能提出 Completion Candidate。

每个能力声明必须包含：

```text
入口文件
核心类
调用路径
端到端测试
当前限制
```

不得把 Partially wired 写成 Fully wired。

---

# 十一、每轮状态文件

每轮结束前更新：

```text
.loop/STATE.md
```

格式：

```text
# Current phase

# Completed this iteration

# Evidence

# Tests executed

# Test results

# Files changed

# Commit

# Current blocker

# Next action

# Remaining acceptance criteria

# Progress fingerprint
```

同时追加：

```text
.loop/DEVLOG.md
```

只记录事实，不记录未经验证的“应该已经完成”。

---

# 十二、最终验收

本轮只有全部满足以下条件才能提出完成：

1. 中文 mutation 不再误判；
2. Run Context 是唯一状态源；
3. 每 Run 使用独立 TaskGraph、ProgressMonitor、ControlMessageLog；
4. TaskGraph create/restore 自动绑定全部 sinks；
5. Context 在异常路径也会关闭；
6. model attempts 每 Run 清空；
7. CompletionVerdict 返回给 CLI、Hook、Module、Loop、AgentTool 和 Eval；
8. blocked/partial/exhausted 不再被当成成功；
9. fallback 成败、Token 和成本归属正确；
10. Loop 不信任模型创建的 DONE；
11. Acceptance 为空不得完成；
12. Acceptance 每轮重新读取；
13. 完整 test/build/eval 进入质量门；
14. 命令和迭代均有可配置 timeout；
15. Supervisor 有 heartbeat 和 stale lock 恢复；
16. Provider 连续失败会退避并 PARKED；
17. 崩溃后可以恢复任务；
18. TaskGraph 状态和事件一致；
19. 至少新增 25 个强后台运行回归测试；
20. `pnpm typecheck` 通过；
21. `pnpm lint` 通过；
22. `pnpm test` 通过；
23. `pnpm eval:deterministic` 通过；
24. `pnpm build` 通过；
25. 文档与真实实现一致。

---

# 十三、停止条件

只有三种合法停止方式。

## DONE

所有验收命令由 Driver 独立执行并通过。

模型只创建：

```text
CANDIDATE_DONE.flag
```

Driver 创建：

```text
DONE.flag
```

## PARKED

满足以下任一条件：

* 同一阻塞连续三轮无法解决；
* Provider 长时间不可用；
* 验收配置错误；
* 需要用户决策；
* 发现可能破坏用户代码的风险；
* 无法安全迁移历史数据；
* 剩余问题需要外部凭据或环境。

PARKED 时必须记录：

* 根因；
* 已尝试方案；
* 当前分支和 commit；
* 失败命令；
* 恢复步骤；
* 建议用户选择。

## MAX ITERATIONS

达到最大轮数时：

* 不得创建 DONE；
* 保存 STATE；
* 保存 Trace；
* 总结已完成与未完成事项；
* 安全终止所有子进程。

现在开始真实审计和实现，不等待人工确认。
