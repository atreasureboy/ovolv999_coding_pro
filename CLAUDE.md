# CLAUDE.md — ovolv999_coding_pro 项目记忆

> 本文件是跨会话架构记忆。基于 v0.4.0(commit 2ebca70)全量精读,2026-07-28 核实。
> 代码风格约定见 AGENTS.md(strict TS / ESM / 无注释除非要求 / 测试镜像 src 结构)。

## 项目定位

ovolv999 —— **可观测、可控制、可恢复、可验证的多模型 Coding Agent Runtime**。
TypeScript 5.7 strict ESM,Node ≥ 20,~67k 行 src,测试套件全绿。运行时依赖 8 个:
openai / glob / zod / ink / react(零原生依赖是硬约束,保 `curl|sh` 安装,见 ADR-006)。
定位是 **Agent 基础设施**:统一 Harness + 配置驱动角色(无 agent_type)+ 模块注入,零领域绑定。

## 常用命令

```bash
npx tsc --noEmit          # 类型检查
npx vitest run            # 全部测试
npx vitest run tests/<f>  # 单文件
pnpm build             # tsc → dist/ + 复制 package.json
pnpm check             # typecheck + lint + unit + integration + eval:deterministic
pnpm dev               # tsx bin/ovogogogo.ts
```

## 工作约定(重要)

1. **验证哲学**:这是成熟产品。不要用跑测试作为行为正确性的最终证明——
   需要行为验证时**提醒用户手动用真实工具开发场景检验**。构建/类型检查可以跑。
2. **当前目标 = 架构与细节演进**,不是加功能。优先考虑:消除并行抽象、
   接线未接线的契约接口、收敛文档与实现漂移。
3. 改动前先看 `docs/ADR/` 与代码内 "runtime truth contract §" 注释——
   本项目是契约驱动开发,不变量都有明文。

## 架构速览

### 调用链

```
bin/ovogogogo.ts (Ink REPL / --pipe / --bg / ACP / --loop)
 → ExecutionEngine (engine.ts — 薄装配门面,runTurn 单 turn 互斥)
   → RuntimeCoordinator.run() (runtime/coordinator.ts — 真正的 loop driver)
     → boot(): moduleManager 拓扑并行 boot → ToolRegistry → system prompt(12 段)→ toolContext
     → queryStateMachine 纯 reducer 9 态循环:
        check_abort → budget_check(50% snip/70% warn/85% compact)
        → routing(11 信号收集 → route → applyRoutingDecision)
        → module_iteration(critic 风险门控)→ llm_call(熔断器+退避→Gateway→StreamConsumer)
        → control_messages(render-then-drain)→ parse → tool_execution(claim 分区调度)
     → evaluateCompletion(7 态契约)→ Reviewer 确定性复审 → TurnOutcome(对外 6 态)
```

### 子系统地图

| 目录 | 职责 | 关键文件 |
|---|---|---|
| `core/runtime/` | loop 驱动与运行时契约 | coordinator, queryStateMachine, completionContract, reviewer, taskGraph(+Store), progressMonitor, internalControlMessage, runScopedContext, criticTrigger, prematureHandoff, terminationPolicy, events |
| `core/model/` | 路由与调用 | modelRouter, modelGateway, providerAdapter(OpenAICompatibleAdapter), streamConsumer, routingSignalCollector, modelRuntimeManager |
| `core/toolRuntime/` | 工具运行时 | toolRegistry, toolPolicy(双层防御), toolExecutor, toolScheduler |
| `core/moduleRuntime/` | 模块生命周期 | moduleManager(拓扑 boot,critical/best_effort) |
| `core/context/` | 上下文预算 | contextManager, toolResultBudget |
| `tools/` | 34 个工具 | agent.ts(子引擎+验证闸门), claudeCode.ts(tmux worker), taskPlan.ts(13 action) |
| `modules/` | 5 个内置模块 | memory, critic, reflection, workspace, mcp |
| `ui/` | 三前端共享引擎 | ink/(UIStore 单向桥), vim.ts(纯状态机), statusLine |
| `commands/` | 89 个 slash 命令 | builtin.ts(3487 行单文件) |
| `integrations/` | 外部协议 | acp.ts(JSON-RPC stdio), pipeMode |

### 六大核心机制(详见 docs/ADR/001-007)

1. **事件驱动 Run 状态机**:RunStatus **12 态**,VALID_TRANSITIONS 强制;blocked 唯一可恢复非终态,lost 供恢复失败。事件双层:持久 `runs.jsonl`(8 种 run.*)+ 内存 ~45 种 RunEvent。注册表调用全 best-effort——"注册表 bug 不能破坏真实 turn"。
2. **Claim 并发调度**:工具 `metadata.claims(input)` 声明 R/W/X;`ResourceScheduler.acquire` 原子 all-or-nothing 是**唯一正确性闸门**,分区并行只是优化;无声明默认串行;git 强制 exclusive。
3. **模型路由**:纯函数打分,`(1-complexity)×cost×0.8` 使简单任务下沉廉价模型;manual override sticky 恒最高;决策带 reasonCodes 供 `/why`。Fallback **只在流建立边界、单次、复用传输**——绝不重放副作用 tool。三态 Provider 熔断器(5 次/30s/半开)。
4. **完成验证契约**:**模型说 stop ≠ 完成**。7 态:completed/partial/blocked/failed/cancelled/exhausted/incomplete(TurnOutcome 收敛为 6 态对外)。只在**正向失败证据**出现时阻塞;耗尽/部分完成映射 blocked 而非 failed。
5. **内部控制消息**:10 种类型化信号存 ControlMessageLog,llm_call 时 renderForProvider → **立即 clear**,永不进用户历史/导出。
6. **JSONL EventStore**:零依赖,appendBatch 原子,eventId 去重;EventStore 接口预留 SQLite。

### 反假成功纵深(项目灵魂)

stop_sequence 不算证据 → EvidenceStore 计算 criterion 满足度(**模型无法文本宣称达标**)→
prematureHandoff 中英正则拦甩锅 → ProgressMonitor 8 检测器(A→B→A→B 环/patchHash 去重/verificationDelta)→
Critic 风险门控(宣称完成+未达标→block)→ Loop 的 **Driver/Model 权限分离**(模型只能写 CANDIDATE_DONE.flag,六条件门核准才写 DONE.flag;**ADR-007**:DONE.flag 已 nonce + checkpoint 绑定校验,子串检查与旧版纯文本 flag 作废,Write/Edit 禁写 .loop/ 四个驱动文件)→ Worker 哨兵 UUID 绑定(P0-5 事故修复)。

### 数据目录双品牌(现状)

- `.ovogo` / `~/.ovogo`:现役 settings、skills、memory(episodes/semantic.jsonl)、modes
- `.ovolv999` / `~/.ovolv999`:config.ts、worktrees、knowledge、dream、team-memory、budgets、skill-usage
- 收敛方向已定(33 vs 108 处引用),迁移需带用户数据搬家方案。

## 文档 vs 现实台账(2026-07-28 核实,README 已按此修订)

**已修 README**:完成契约 7 态(非 6)、TaskPlan 13 action(非 12)、RunEvent 54 变体(非 19)、
引擎记忆实为 Semantic+Episodic(KnowledgeBase/TeamMemory 仅命令级)、Auto-Dream 是被动统计库(无 LLM)、
内置模块 5 个(含 mcp)、能力矩阵 §11 LongTermMemory 与 §12 ProviderAdapter 注册表标注"未接线"、
§5 路由信号标注部分为代理值。

**代码接线优先级(架构演进 backlog)**:
- ~~P0 DONE.flag 抗伪造~~ → **已完成(ADR-007,2026-07-28)**:nonce/checkpoint 双路绑定 + 工具写禁 + resume succeeded 短路;遗留:Bash 伪造 checkpoint.json 在 0.x 威胁模型外(沙箱负责)
- ~~P1 低成本收敛~~ → **已完成(2026-07-28)**:价格表单一真相源(costTracker.getModelPricing 委托 providers.ts MODELS[],null 语义保留驱动 hasUnknownModel;legacy/EOL 模型名刻意落空→"costs may be inaccurate"注记;MODELS[] 补 claude-sonnet-4-6/o1-pro);路由层 `ModelCapabilities`→`RoutingCapabilities`(与 provider 特性类型解歧);`buildFullSystemPrompt` 形参 `memorySection`→`modePrompt`;Loop 每轮对称重读 GOAL/ACCEPTANCE(prompt 正文用 `goalFresh`,三处 checkpoint 哈希现取现算,启动 `goal` 仅留存在性检查/taskId/run 标题);usage 缺失不再静默记 $0(warn 每 run 一次 + EventLog `llm_api_usage_missing` + `usageMissing` 落 TurnOutcome.modelAttempts,绝不伪造零成本调用);checkpoint load() 主文件缺失/损坏回退 checkpoint.previous.json
- P2 决策项(接线 or 删除):`permissionRules.ts` glob 引擎(未接线,内置 deny 规则浪费)、持久层 subsystem 事件(tool.*/artifact.* 零 emit 点,死接口)、LongTermMemory R1–R6 接入引擎、双 retryable 正则合并、死字段清理(writeTimeoutMs/consecutiveCommandFailures/lastCommit)
- P3 大迁移:品牌目录收敛、路由信号真实化(`repoFileCount=filesTouched×10` 代理、`budgetRemaining` 恒 undefined)、Windows 租约指纹降级补救(/proc-only)

**注意**:`ProviderId` 枚举 13 个是元数据层;运行时真正可服务仅 openai / minimax / openai-compatible,
全部走 OpenAICompatibleAdapter,引擎为单传输模式(跨 provider profile 在 validateProfiles 硬拒)。
