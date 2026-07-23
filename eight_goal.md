你现在是 `ovolv999_coding_pro` 项目的高级架构师、Coding Agent 研究员和主要实现者。

仓库：

https://github.com/atreasureboy/ovolv999_coding_pro

本轮目标：

# v0.3 Adaptive Coding Runtime

本项目的定位不是单纯的通用 SDK，也不是只追求简化操作的个人脚本，而是：

> 一个面向个人长期使用，同时能够在技术面试中体现 Agent Runtime、模型调度、任务规划、长期执行、故障恢复和评测能力的超级 Coding Agent。

因此，本轮既要继续加固底层，也要增强上层智能能力。

不得以“个人工具不需要”为理由删除已有高级能力，也不得只堆叠新功能而绕过现有 Runtime。

---

# 一、执行原则

1. 首先完整读取当前仓库、README、架构文档、最近提交和测试。
2. 不要根据本 Prompt 假设代码现状，所有问题必须通过真实代码验证。
3. 已经正确实现的能力不要重复重构。
4. 不进行全面推倒重写。
5. 不删除现有功能；不成熟能力可以标记为 Experimental。
6. 每项新能力必须接入真实主执行链，不能只增加接口、类型和空壳。
7. 新增关键逻辑必须有单元测试和集成测试。
8. 每完成一个阶段立即运行对应测试。
9. 不要停留在审计和设计文档，审计后直接实施。
10. 不得伪造测试结果或声称未实际执行的命令已通过。
11. 如果一次无法完成全部阶段，按优先级完成真实闭环，不得用 TODO 冒充完成。
12. 保持现有 CLI、配置和 OpenAI-compatible 模型接入尽可能兼容。

---

# 二、Phase 0：重新审计真实执行链

创建：

```text
docs/V0_3_ADAPTIVE_RUNTIME.md
```

追踪以下真实调用链：

```text
用户输入
→ CLI / REPL
→ 请求分类
→ 模型选择
→ RuntimeCoordinator
→ ModelGateway
→ ProviderAdapter
→ ToolScheduler
→ ResourceScheduler
→ ToolExecutor
→ Worker / CommandRunner / Tool
→ Verification
→ Run terminal state
```

重点检查：

1. 哪些命令仍直接调用 `exec`、`execSync`、`spawn`；
2. 哪些 Runtime 控制消息仍以 `role: user` 写入历史；
3. Bash、Git、Worktree、Loop、后台任务是否共享同一取消机制；
4. ResourceScheduler 的 claims 是否覆盖主要修改型工具；
5. 子 Agent 的输出、patch、验证结果是否能够被父 Agent可靠收集；
6. 当前 AutoClassifier 是否只决定 effort，还是已经影响模型和执行策略；
7. 当前 Loop 是否能够识别“没有实际进展”；
8. 当前模型切换是否只支持人工切换；
9. 当前测试是否主要是模块测试，缺少真实 Coding Task Eval；
10. README 中的能力是否与实际主路径一致。

审计文档必须列出：

* 已完成能力；
* 部分完成能力；
* 未接入主路径的能力；
* 重复实现；
* 本轮真实修改项；
* 延后项及延后理由。

随后直接进入实现。

---

# 三、Phase 1：完成 Runtime Integrity 剩余闭环

这一阶段不是重新设计，而是补齐 v0.2 已经发现但尚未完成的路径。

## 1.1 统一外部命令执行

搜索仓库中所有：

```text
exec
execSync
spawn
fork
Bun.spawn
Deno.Command
```

业务模块原则上统一经过 `CommandRunner`。

优先迁移：

1. AgentTool 中的 Git 操作；
2. Worktree 创建、合并、清理；
3. Loop quality gates；
4. Bash 前台执行；
5. Bash 后台执行；
6. ShellSession；
7. TmuxSession；
8. BackgroundTask；
9. 配置、安装和诊断中需要取消或超时的命令。

允许保留少量确有必要的底层进程调用，但必须集中在明确的 infrastructure 层，并记录 allowlist 和理由。

CommandRunner 必须统一支持：

* timeout；
* AbortSignal；
* stdout/stderr 上限；
* 进程树终止；
* cwd 校验；
* 环境变量传递；
* 结构化执行结果；
* Run/Event 关联；
* Windows 和 Unix 差异。

Windows 下不要依赖负 PID 的 Unix 进程组语义。

至少测试：

* 普通命令成功；
* 非零退出；
* 超时；
* Abort；
* 创建子进程后取消；
* Windows 分支行为；
* 输出超限；
* ShellSession 清理。

## 1.2 InternalControlMessage

禁止 Runtime 将下列内容永久保存为真实用户消息：

* empty-response retry；
* continue after length limit；
* budget nudge；
* critic feedback；
* compaction continuation；
* snip boundary；
* tool recovery instruction；
* automatic replan instruction。

定义内部消息：

```typescript
type InternalControlMessage =
  | { type: "continue_after_length"; reason: string }
  | { type: "retry_empty_response"; attempt: number }
  | { type: "budget_warning"; remainingTokens: number }
  | { type: "critic_feedback"; content: string }
  | { type: "replan"; reason: string }
  | { type: "tool_recovery"; toolCallId: string; error: string };
```

要求：

* 与真实用户消息分开存储；
* 不出现在会话导出中的用户发言；
* ProviderAdapter 边界负责转换为供应商能够理解的消息形式；
* 不得污染长期记忆；
* 不得被统计为用户新增需求；
* 上下文压缩后仍保持语义。

## 1.3 资源 claims 完整性

审计所有工具。

没有资源声明的工具默认不得并发修改工作区。

至少规范：

* Read/Glob/Grep：文件或目录 read；
* Write/Edit/NotebookEdit：目标文件 write；
* Git merge/rebase/reset/checkout：repository exclusive；
* Bash：默认 workspace exclusive，可通过显式只读声明降级；
* Shell/Tmux：session exclusive；
* Agent 修改型任务：独立 worktree exclusive；
* Verification：workspace read，必要时 process exclusive；
* package manager install：workspace exclusive。

处理路径等价关系：

```text
src/a.ts
./src/a.ts
绝对路径/src/a.ts
src/../src/a.ts
```

处理父子路径冲突：

```text
src/ write
src/a.ts read
```

---

# 四、Phase 2：智能模型路由

实现真正对个人 Coding 工具有价值、同时具有面试展示价值的 Model Router。

不要只按照请求中的几个关键词选择模型。

新增统一概念：

```typescript
interface ModelProfile {
  id: string;
  provider: string;
  model: string;
  capabilities: {
    reasoning: number;
    coding: number;
    contextWindow: number;
    toolCalling: number;
    speed: number;
    cost: number;
  };
  roles: string[];
  available: boolean;
}
```

```typescript
interface RoutingDecision {
  selectedModel: string;
  selectedProfile: string;
  reasonCodes: string[];
  confidence: number;
  estimatedComplexity: number;
  fallbackChain: string[];
  budgetAllocation: {
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxCost?: number;
  };
}
```

路由输入至少包括：

* 用户目标；
* 仓库规模；
* 涉及文件数量；
* 任务类型；
* 是否需要架构决策；
* 是否需要大上下文；
* 是否需要工具调用；
* 历史失败次数；
* 当前预算；
* 模型健康状态；
* 子任务角色；
* 用户显式指定模型。

建议默认策略：

```text
高复杂度架构、根因分析、关键决策
→ 高智能主模型

普通编码、批量实现、测试补充
→ 高性价比 Coding 模型

搜索、整理、摘要、机械审计
→ 廉价模型或子 Agent

主模型连续失败
→ 升级模型或切换独立解题策略

上下文超限
→ 长上下文模型或先执行结构化压缩

Provider 限流或不可用
→ 自动 fallback
```

要求：

1. 人工 `--model` 或 `/model` 具有最高优先级；
2. 自动路由必须可以关闭；
3. 每次路由决策产生结构化事件；
4. `/route` 显示本次选择和原因；
5. `/models` 显示可用性、失败率和近期延迟；
6. 不要硬编码 GPT、M3、GLM 的名称到 Coordinator；
7. 具体模型映射放在配置中；
8. Provider 失败、429、超时、工具调用不兼容时可自动 fallback；
9. fallback 不能重复执行已经产生副作用的工具调用；
10. 模型切换后保持 WorkingState，但避免重复注入完整历史。

增加测试：

* 简单任务走廉价模型；
* 架构任务走强模型；
* 指定模型覆盖自动路由；
* Provider 429 自动 fallback；
* fallback 不重复执行工具；
* 长上下文路由；
* 路由配置缺失时安全降级。

---

# 五、Phase 3：任务图与分层编排

当前 Agent 不应只依赖一条线性“模型—工具—模型”循环。

增加轻量级 TaskGraph：

```typescript
interface TaskNode {
  id: string;
  title: string;
  description: string;
  status:
    | "pending"
    | "ready"
    | "running"
    | "blocked"
    | "verifying"
    | "completed"
    | "failed"
    | "cancelled";
  dependencies: string[];
  resourceClaims: ResourceClaim[];
  preferredRole?: string;
  preferredModelProfile?: string;
  acceptanceCriteria: string[];
  retryPolicy: RetryPolicy;
  artifacts: string[];
}
```

支持：

* 主任务分解为子任务；
* 依赖关系；
* 可并行节点；
* 阻塞节点；
* verification 节点；
* replan；
* 人工 steer；
* 子 Agent 委派；
* 失败节点局部重试；
* 最终结果聚合。

重点不是做复杂的通用工作流引擎，而是支持真实 Coding 任务：

```text
理解需求
→ 探索仓库
→ 制定修改方案
→ 并行实现独立模块
→ 汇总变更
→ 编译/测试
→ 定位失败
→ 局部修复
→ 最终审查
```

要求：

1. 简单任务不得强制创建复杂 TaskGraph；
2. 中大型任务才启用；
3. TaskGraph 状态写入 Run/Event 系统；
4. 父 Agent 能看到各节点状态；
5. `/tasks` 显示依赖、进度和阻塞原因；
6. 子任务不得在同一工作区发生未调度的冲突修改；
7. 修改型并行子任务优先使用独立 worktree；
8. 合并前必须验证；
9. 验证失败不得将节点标记为 completed；
10. TaskGraph 可以从事件日志恢复。

---

# 六、Phase 4：长期自主执行与停滞检测

这是本轮最重要的个人使用增强。

解决大模型长期执行时常见问题：

* 两小时后提前宣布完成；
* 反复搜索但没有修改；
* 重复执行相同失败命令；
* 测试失败后无限循环；
* 子 Agent 完成后主 Agent没有及时收集；
* 上下文压缩后忘记剩余任务；
* 只完成“大致目标”而不是验收标准。

新增 ProgressMonitor：

```typescript
interface ProgressSnapshot {
  iteration: number;
  completedTaskNodes: number;
  changedFiles: string[];
  verificationDelta: number;
  newArtifacts: string[];
  repeatedToolCalls: number;
  repeatedErrors: number;
  minutesSinceLastMeaningfulProgress: number;
  remainingAcceptanceCriteria: string[];
}
```

定义“有意义进展”：

* 新的任务节点完成；
* 新文件或有效 patch；
* 测试失败数减少；
* 编译错误数减少；
* 新根因得到证据支持；
* 阻塞条件被解除；
* 子 Agent 产物被成功合并；
* acceptance criteria 被满足。

不属于有意义进展：

* 重复读取同一文件；
* 重复运行相同失败命令；
* 只更新 Todo 文本；
* 只输出计划；
* 没有证据的“应该已经完成”。

增加 StallDetector：

```text
soft stall
→ 要求总结当前证据并更换策略

hard stall
→ 触发独立 critic / reviewer

repeated failure
→ 创建 root-cause 子任务

budget pressure
→ 缩小范围、优先验收标准

no progress after replan
→ 标记 blocked，说明真实阻塞，而不是假装成功
```

增加 CompletionContract：

任务只有在以下条件成立时才能完成：

1. acceptance criteria 全部满足或明确标记无法满足；
2. 需要的验证已经执行；
3. 没有关键子任务仍在 running；
4. 没有未处理的验证失败；
5. WorkingState 中没有高优先级未完成事项；
6. 最终结果列出修改、验证和残留风险。

不要简单依赖模型说“完成了”。

---

# 七、Phase 5：自适应 Critic 和 Reviewer

不要固定每 N 轮无条件调用 Critic，这会浪费 Token。

根据风险触发：

* 连续工具失败；
* 长时间无进展；
* 大范围修改；
* 涉及核心架构；
* 测试通过但 patch 异常庞大；
* 模型准备宣布完成；
* 多个子 Agent 结果冲突；
* 高风险 Git 操作；
* 用户要求严格审计。

Critic 输出必须结构化：

```typescript
interface CriticReport {
  verdict: "continue" | "replan" | "verify" | "block" | "complete";
  detectedProblems: string[];
  unsupportedClaims: string[];
  missingAcceptanceCriteria: string[];
  recommendedActions: string[];
  confidence: number;
}
```

Critic 不得直接修改真实用户目标，也不得通过伪造 user 消息注入。

增加最终 Reviewer：

* 查看 diff；
* 对照目标；
* 检查非必要改动；
* 检查测试；
* 检查残留 TODO；
* 检查异常吞错；
* 检查接口兼容性；
* 决定 completed / partial / blocked。

---

# 八、Phase 6：真实 Coding Agent Eval

建立可量化的评测，不再仅依赖大量单元测试。

新增：

```text
evals/
├── fixtures/
├── tasks/
├── scorers/
├── baselines/
├── reports/
└── runner/
```

至少建立 12 个确定性 Fixture：

1. TypeScript 单文件 bugfix；
2. TypeScript 多文件 feature；
3. 缺失测试补充；
4. Python bugfix；
5. Rust 编译错误；
6. 跨模块重构；
7. 需要先搜索后修改；
8. 测试存在误导信息；
9. 两个可并行子任务；
10. 两个会产生文件冲突的子任务；
11. 长上下文压缩后继续执行；
12. Provider 中断后恢复和 fallback。

至少增加 5 个个人真实任务模板：

* 审计一个 Coding Agent 仓库；
* 根据目标重构架构；
* 长时间 Loop 持续优化；
* 委派 M3/Claude Code 完成模块；
* 根据测试失败持续修复直到通过。

评分指标：

```text
任务完成率
验收标准满足率
编译/测试通过率
错误成功率（false success）
无意义工具调用次数
重复失败次数
人工接管次数
修改文件数量
非必要改动
Token
费用
耗时
上下文压缩次数
模型切换次数
子 Agent 利用率
停滞恢复率
崩溃恢复率
```

要求：

* 支持 Fake Provider 确定性评测；
* 支持真实模型可选评测；
* 生成 JSON 和 Markdown；
* 保存 baseline；
* 与 baseline 比较；
* 明显退化时非零退出；
* 不以单次随机真实模型结果作为唯一 CI 门禁。

新增命令：

```text
pnpm test:unit
pnpm test:integration
pnpm eval:deterministic
pnpm eval:real
pnpm check
```

---

# 九、Phase 7：可观测性和面试展示

为每个 Run 形成可解释记录。

增加：

```text
/trace
/route
/progress
/why
/eval
```

其中：

## `/trace`

显示：

* 用户目标；
* TaskGraph；
* 模型路由；
* 工具调用；
* Worker；
* 验证；
* 状态切换；
* fallback；
* replan；
* 最终状态。

## `/why`

可以回答：

* 为什么选择这个模型；
* 为什么启动子 Agent；
* 为什么并行或串行；
* 为什么重新规划；
* 为什么认为任务已完成；
* 为什么任务被 blocked。

输出应基于结构化事件，不要临时让模型编造解释。

增加 Run Summary：

```text
目标
最终状态
完成节点
修改文件
验证结果
使用模型
子 Agent
Token / Cost / Duration
恢复次数
重新规划次数
残留风险
```

增加一个可以用于面试演示的文档：

```text
docs/INTERVIEW_DEMO.md
```

内容包括：

1. 项目解决什么问题；
2. 为什么不是简单 API 套壳；
3. Runtime 架构；
4. ProviderAdapter；
5. ResourceScheduler；
6. Worker lifecycle；
7. TaskGraph；
8. 自动模型路由；
9. 停滞检测；
10. Event recovery；
11. Eval 结果；
12. 一次真实任务执行案例；
13. 关键技术取舍；
14. 当前限制；
15. 后续规划。

增加一个架构决策记录：

```text
docs/ADR/
```

至少写：

* 为什么选择事件驱动 Run；
* 为什么使用 claims 调度；
* 为什么区分内部控制消息；
* 为什么采用主模型与廉价 Worker 分工；
* 为什么 Completion 需要验证合同；
* 为什么保留 JSONL 或升级 SQLite。

---

# 十、Phase 8：EventStore 升级决策

先真实评估，不要为了“高级”盲目引入 SQLite。

如果当前 JSONL 已经不能可靠支持：

* TaskGraph 查询；
* Worker 恢复；
* Run 状态和事件原子提交；
* 大量历史 Run；
* 多条件查询；
* schema migration；

则实现 SQLite WAL EventStore。

要求：

* 保留 EventStore 接口；
* JSONL 可导入；
* schema version；
* migrations；
* run/events/workers/tasks/artifacts 分表；
* transaction；
* 单调 sequence；
* 幂等 eventId；
* 崩溃恢复；
* 不强制用户安装复杂原生依赖。

如果 SQLite 依赖显著影响跨平台安装，则可以保留 JSONL 为默认，SQLite 为可选 backend，但必须给出数据和测试证明，而不是凭感觉。

---

# 十一、最终验收标准

本轮至少必须满足：

1. 所有关键业务命令统一进入 CommandRunner 或明确基础设施 allowlist；
2. Windows 可以终止完整子进程树；
3. Runtime 控制消息不再冒充用户；
4. 资源 claims 覆盖主要工具，并处理路径规范化；
5. 自动模型路由可以基于任务复杂度、预算和失败状态决策；
6. 用户指定模型可以覆盖自动路由；
7. Provider 故障可 fallback，且不重复有副作用工具；
8. 中大型任务可以形成可恢复 TaskGraph；
9. 子任务支持依赖、并行、阻塞、验证和局部重试；
10. 长任务具备 progress monitor；
11. 能检测重复失败和无意义循环；
12. 模型不能仅凭自我声明将任务标记为完成；
13. Critic 按风险触发，而不是机械固定触发；
14. 至少一个确定性端到端 Coding Eval；
15. 有 baseline comparison；
16. 有结构化模型路由和 TaskGraph 事件；
17. `/trace` 和 `/why` 能根据真实事件解释执行；
18. 原有测试继续通过；
19. TypeScript、Lint、Build、Unit、Integration、Eval 全部实际执行；
20. README 和 `INTERVIEW_DEMO.md` 与真实实现一致。

---

# 十二、优先级

如果本轮时间或上下文不足，按以下顺序完成：

```text
P0
Phase 0 审计
Phase 1 Runtime 剩余闭环
Phase 2 智能模型路由
Phase 4 长期执行与停滞检测
Phase 6 Eval

P1
Phase 3 TaskGraph
Phase 5 Critic / Reviewer
Phase 7 可观测性与面试文档

P2
Phase 8 SQLite EventStore
```

不要为了完成 P2 而牺牲 P0。

---

# 十三、禁止事项

禁止：

* 删除已有功能以减少工作量；
* 将所有新逻辑塞进 ExecutionEngine；
* 新建第二套 Run 状态机；
* 新建第二套工具执行器；
* 新建第二套 Worker Registry；
* 在 Coordinator 中硬编码具体模型名；
* 用关键词 `if/else` 冒充完整模型路由；
* 只写类型和 TODO；
* 只增加 mock 测试；
* 仅凭模型输出判断完成；
* 把 blocked、exhausted、partial 标记为 completed；
* 为追求测试数量编写没有行为价值的测试；
* 在没有实际运行的情况下宣称测试通过；
* 无限制扩大 Prompt 和上下文；
* 让 Critic 修改用户原始目标；
* 让 fallback 重复执行已产生副作用的操作。

---

# 十四、最终输出

完成后输出：

## 1. 审计结果

* 修改前真实架构；
* 发现的问题；
* 哪些原判断成立；
* 哪些原判断不成立。

## 2. 实际修改

按文件和模块列出。

## 3. 新执行流程

给出从用户输入到任务完成的真实调用图。

## 4. 智能能力

说明：

* 模型如何选择；
* 子任务如何拆分；
* 如何判断停滞；
* 如何重新规划；
* 如何判断完成。

## 5. 测试与 Eval

列出实际执行命令和结果。

## 6. 性能变化

包括：

* 测试数量；
* Eval 得分；
* 平均工具调用；
* Token；
* 时间；
* false success；
* stall recovery。

## 7. 兼容性

列出 CLI、配置和数据格式变化。

## 8. 未解决问题

明确列出，不得掩盖。

## 9. 面试价值总结

用技术语言说明本轮体现了哪些 Agent 工程能力：

* Runtime orchestration；
* model routing；
* task graph；
* concurrency control；
* worker lifecycle；
* fault recovery；
* verification contract；
* agent evaluation；
* observability。
