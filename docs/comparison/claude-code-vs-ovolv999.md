# claude-code vs ovolv999_coding_pro — 架构与功能对比报告

> **基线**
> - ovolv999:`v0.5.0`(`role-aware Multi-Agent Runtime`),~260 源文件 / 223 测试文件 / 5 个运行时依赖
> - claude-code-best:v2.8.4(`Reverse-engineered Anthropic Claude Code CLI`),**2369 源文件 + 852 packages 文件** = **3221+ 文件**,Bun 运行时 / Bun workspaces / 17+ workspace packages
>
> **重要**:claude-code-best 是 **decompiled / 反编译** 的 Anthropic 官方 Claude Code 的社区还原版,**不是官方源码**,因此 README/CLAUDE.md 自己声明"许多模块是 stub 或 feature-flagged off"。但它的 **架构设计**、**API surface** 与 **feature flag 系统** 完整保留了 Anthropic 官方对 Claude Code CLI 的设计哲学,因此对 ovolv999 而言仍是极佳的对照蓝本。

---

## 0. 数量级差距

| 维度 | ovolv999 | claude-code-best | 倍数 |
|---|---|---|---|
| 源文件 `.ts/.tsx` | ~260 | **3221** | **12.4×** |
| src 行数(`find … wc -l`) | ~67k | >200k(估算) | **3×** |
| Workspace packages | 0(单包) | **17+**(`packages/@ant/*` + `packages/builtin-tools` 等) | — |
| 工具数 | 34 | **60**(`packages/builtin-tools/src/tools/`) | 1.8× |
| 命令数(`/commands`) | 89(单文件) | **271**(目录) | 3× |
| React 组件 | ~few(ink 复用) | **149**(`src/components/`)+ 设计系统 | 巨大 |
| 运行时依赖 | **5**(`openai`/`glob`/`zod`/`ink`/`react`) | 多 100+(Anthropic SDK / MCP SDK / MCP Chrome Bridge / ws / highlight.js / ink-fork + 大量 transitive) | — |

**我们的根级约束**:`零原生依赖`、保持 `curl | sh` 安装(ADR-006)。这意味着数量级差距 **主要** 来自三块:Claude Code SDK 全家桶、原生 MCP 生态、Web/SSH 远端控制。**架构深度差异并不大**。

---

## 1. 核心架构对照

### 1.1 调用链对照

```
claude-code (v2.8.4):
  bin: dist/cli.js (Bun.build 产物, 600+ chunks)
  src/entrypoints/cli.tsx → src/main.tsx (5640 行 Commander.js)
    → src/QueryEngine.ts (1365 行) → src/query.ts (2057 行 — 主循环, async generator)
      → src/services/api/claude.ts (3574 行, 第一方 Anthropic SDK 流)
      → src/services/tools/StreamingToolExecutor.ts (并发+ siblingAbortController)
      → src/services/compact/* (4 种压缩:auto / reactive / snip / microcompact)
      → 60 个 tool → 271 个 slash command

ovolv999 (v0.5.0):
  bin: dist/bin/ovogogogo.js
  src/core/engine.ts (1118 行 — 装配门面)
    → src/core/runtime/coordinator.ts (1507 行 — 主循环, 9 态纯 reducer)
      → src/core/model/modelGateway.ts → OpenAICompatibleAdapter (单传输)
      → src/core/toolRuntime/toolScheduler.ts (claim R/W/X 并发)
      → src/core/context/contextManager.ts (50%/70%/85% 三段预算)
      → 34 个 tool → 89 个 slash command
```

### 1.2 主循环驱动的本质差异

| 维度 | claude-code | ovolv999 |
|---|---|---|
| 循环入口 | `async function* query()` 生成器 | `class RuntimeCoordinator` 9 态纯 reducer |
| 状态机风格 | **外部 transition 表**(`query/transitions.ts`) | 内部 `switch (state.kind)` + `transitionQueryState` 纯函数 |
| 取消模型 | `AbortController` + `childAbortController` 链路 | `AbortController` + `claimSoftAbort` 单例 ownership |
| 流式并发 | **StreamingToolExecutor** 入流即调度,并发 vs 独占二态 | ToolScheduler 在 `tool_execution` 态一次性调度,claim R/W/X |
| 重试/恢复 | 详细控制(`MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3`,reactiveCompact) | 重试 regex 合并(`\b(429\|5\d\d\|...)\b`)+ 熔断器三态 |

**深度差异点**:claude-code 用生成器 + 显式 transition 文件;ovolv999 用 reducer switch。**后者更易测试**(纯函数),**前者更易流式 yield**(中途可挂起、通知 SDK 调用方)。

---

## 2. 子系统能力矩阵

| # | 能力 | claude-code-best | ovolv999 | 评价 |
|---|---|---|---|---|
| 2.1 | **API providers** | 7 个(`firstParty` / `bedrock` / `vertex` / `foundry` / `openai` / `gemini` / `grok`),均为流适配器 | **1 传输**(`OpenAICompatibleAdapter`)+ 13 个 `ProviderId` 元数据 | **差距大** — 我们仅有 OpenAI 兼容协议,不能直连 Anthropic / Bedrock / Vertex |
| 2.2 | **模型路由** | 运行时模型切换 + mainLoopModel | 6 角色 × 2 tier × capability 评分 + sticky 手动 + 自动 fallback | **我们更细**:role-aware + tier 强制 + capability-first;claude-code 仅"主循环模型" |
| 2.3 | **Context 压缩** | **4 套**:`autoCompact`(80%)、`reactiveCompact`(prompt-too-long 回退)、`snipCompact`(`HISTORY_SNIP` flag)、`microcompact`(TTL 缓存) | **3 段预算**:50% snip / 70% warn / 85% compact + `reactiveCompact` 钩子 | **差距**:他们分得极细,我们合并 |
| 2.4 | **Tool 描述生成** | 每个 tool 自带 `description(input, ctx)` 动态生成 + `searchHint`(3–10 词,供 `SearchExtraTools` 检索) | 静态 `description` 字段,无语义检索 | **差距**:他们做了 **TF-IDF 工具检索**(延迟工具按需加载,context 节省显著) |
| 2.5 | **Tool 并发模型** | `StreamingToolExecutor`:`isConcurrencySafe` 二态,流式入队 | `claims(input): R/W/X` 三态,`ResourceScheduler.acquire` 原子 all-or-nothing | **我们的粒度更细**(读写分离);他们更简单(纯 boolean) |
| 2.6 | **Sandbox / Bubble** | `bubble` permission mode + `sandboxRuntime` 隔离 | 无原生 sandbox,依赖 OS / Docker | **差距大** — Claude Code sandbox 是产品级卖点 |
| 2.7 | **Permission Modes** | **7 种**:`default` / `acceptEdits` / `bypassPermissions` / `dontAsk` / `plan` / `auto`(分类器) / `bubble` | **2 种**:`plan` / `default` + `permissionRules.ts` glob(未接线) | **差距大** — 我们 P2 标记未接线,他们是产品核心 |
| 2.8 | **Hooks 系统** | 11 种 hook event(`PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `PreCompact` / `PostCompact` / `SessionStart` / `UserPromptSubmit` / `Stop` / `SubagentStop` / `Notification` / `PreCompact` …),含 `hookSpecificOutput`(JSON 决策回灌)+ `additionalContexts`(上下文注入) | 仅 `hookRunner.runOnError` / `runOnComplete` / `runOnCompleteWithOutcome` 三钩子 | **差距大** — 我们 hooks 是事后通知,他们是控制回路 |
| 2.9 | **Multi-agent 协调** | `COORDINATOR_MODE` + `WORKER` agent type(tools 减集:扣 TeamCreate/SendMessage) + 4 个内置 agent(`general-purpose` / `statusline-setup` / `explore` / `plan` / `verification`) | `agentFactory` 预设(`general-purpose` / `code-reviewer` / `explore` / `plan` / `coordinator`) + **6 角色 × 2 tier** | **我们更细**:tier + role 双轴 + capability-first;claude-code 是"coordinator/worker 二态" |
| 2.10 | **架构升级强制** | 无强制,worker agent 可被 coordinator spawn | **强约束**:`architect` 角色仅 root main agent 可请求,必须带 `escalation_reason` + 关键词正则命中(中英双语) | **我们更严**:把"架构决策"硬编码进权限层 |
| 2.11 | **完成契约** | 无显式契约;靠 `toolUseSummary` 生成文本总结 | **7 态**(completed/partial/blocked/failed/cancelled/exhausted/incomplete),`TaskGraph` + `Reviewer` 双重证据 | **差距大** — 我们有反假成功纵深,他们靠模型自律 |
| 2.12 | **DONE.flag 抗伪造** | 无;loop 是 `--loop` 子命令,模型自然结束 | **ADR-007**:`nonce + checkpoint binding`,JSON strict schema,旧明文 rename 为 `.rejected`,Write/Edit 4 个 driver-owned 文件硬拒 | **我们独有** — 这是反假成功纵深最硬的一块 |
| 2.13 | **Loop 协议** | 无内置 loop;模型自然迭代 | `--loop` + WAKE→SCAN→PLAN→DO→REVIEW→CHECK→ACT + `.loop/{GOAL,ACCEPTANCE,STATE,DONE}.flag` + 租约 + 调度检查点 + Driver/Model 权限分离 | **我们独有** — claude-code 没有等价物 |
| 2.14 | **Provider 熔断器** | 无显式;靠 `withRetry.ts` + Statsig 远端阈值 | **三态熔断器**(CLOSED→OPEN→HALF_OPEN,5 次/30s),per-coordinator 状态可序列化进 checkpoint 恢复 | **我们更细** |
| 2.15 | **内部控制消息** | 无;用文本 role:system 注入 | **10 类**:`stall_replan` / `retry_empty_response` / `continue_after_length` / `project_exploration_continue` / `task_completion_continue` / `budget_warning` / `context_compaction` / `tool_result_storage_truncated` / `permission_denied` / `critic_guidance`,`renderForProvider` 后立即 clear,永不进历史/导出 | **我们独有** |
| 2.16 | **JSONL EventStore** | 单 JSONL transcript(`getTranscriptPath()`) | 双层:持久 `runs.jsonl`(8 种 run.*) + 内存 ~45 种 RunEvent + `appendBatch` 原子 | **我们的分层更清晰** |
| 2.17 | **TF-IDF 技能/工具检索** | 有(`localSearch.ts` 的 `computeWeightedTf` / `computeIdf` / `cosineSimilarity`,工具索引 `toolIndex.ts`) | 无 | **差距**:技能按目录静态加载,我们没有语义检索 |
| 2.18 | **Defer 工具加载** | 有(`shouldDefer: true` + `searchExtraTools` 触发加载) | 无 | **差距**:长上下文场景下我们工具 schema 始终全量 |
| 2.19 | **ACP 协议** | `packages/acp-link/` WebSocket↔ACP 桥 + 完整权限管道 | `integrations/acp.ts`(JSON-RPC stdio,基础) | **差距大**:他们是完整 Web 桥,我们仅 stdio |
| 2.20 | **Remote Control / Bridge** | 完整自托管 RCS(`packages/remote-control-server/`,React 19 + Vite + Radix UI),`claude remote-control` 子命令,JWT 鉴权 | 无 | **差距**:无对应产品 |
| 2.21 | **MCP 生态** | 完整 OAuth + VSCode SDK + Claude-in-Chrome + 官方 registry | `src/integrations/mcp.ts` + 5 个内置模块之一(基础) | **差距大** |
| 2.22 | **Voice / Computer-Use** | 完整 push-to-talk + 截图/键鼠三平台(macOS FFI / Win32 / Linux) | 无 | **差距大** |
| 2.23 | **SSH / Remote session** | `src/ssh/` + `useSSHSession` hook | 无 | **差距**:无 |
| 2.24 | **Skills 系统** | 加载器 + 预取 + marketplace + 自动改进(`useSkillImprovementSurvey`) | 加载器 + extractor(简单) | **差距大** |
| 2.25 | **Plugins** | `src/plugins/` bundled + marketplace + enable/disable | 无 | **差距** |
| 2.26 | **MCP OAuth** | 完整授权流 + token 刷新 + 端口选择 | 无 | **差距** |
| 2.27 | **Cloud Artifacts** | `packages/cloud-artifacts/` Cloudflare Worker + R2 + 7d/30d TTL | 无 | **差距**:无对应产品 |
| 2.28 | **Build / Runtime** | Bun.build 代码分割(600+ chunks,RSS 1GB→35MB) | tsc 单文件产物 | **差距**:我们没代码分割,Bun vs Node 性能差 |
| 2.29 | **LSP** | `packages/builtin-tools/src/tools/LSPTool/` + 服务管理器 | 无 | **差距** |
| 2.30 | **Process / Background** | `daemon/` 长驻 supervisor + `BG_SESSIONS` + templates + `ps`/`logs`/`attach`/`kill` | `BackgroundTaskManager`(后台任务队列) | **差距**:daemon 缺失 |
| 2.31 | **Verifier agent** | `verificationAgent`(子代理做证据复核) | `Reviewer`(deterministic post-run verdict,纯函数) | **理念相近,实现不同**:他们靠 LLM,我们靠结构化证据 |
| 2.32 | **Plan mode** | `planMode` 模式 + `EnterPlanMode` / `ExitPlanModeV2` / `VerifyPlanExecution` | `planModeActive` + `EnterPlanModeTool` / `ExitPlanModeTool`(基础) | 接近 |
| 2.33 | **Slash menu categorization** | 271 个命令按分类组织 | 89 个命令(单文件) | **差距**:数量少,3× |
| 2.34 | **Cost / 预算** | `src/services/ultrareviewQuota.ts` + `providerUsage/balance/` | `costTracker` 单文件 + `usageMissing` 诚实标记 | **我们更诚实**:usage 缺失不再静默记 $0 |
| 2.35 | **Langfuse 可观测** | 完整 trace/spans + `tengu_compact` / `tengu_compact_failed` 事件 | EventLog JSONL 自家 | **差距**:无 SaaS trace |
| 2.36 | **设计系统** | 完整 Anthropic 视觉风格 + RCS Web UI(Mintlify 文档站) | 简单 Ink | **差距大** |
| 2.37 | **Telemetry / Analytics** | `analytics/index.ts` + Statsig GrowthBook 集成 + `tengu_*` 事件 | `EventLog`(本地 JSONL) | **理念不同**:我们不上报 |
| 2.38 | **Vim 模式** | `src/vim/` 完整 | `src/ui/vim.ts`(纯状态机) | 接近 |
| 2.39 | **IDE 桥接** | VSCode IDE Bridge | 无 | **差距** |
| 2.40 | **依赖反转原语** | `bun:bundle` + `MACRO` defines + feature flag 65+ | 无(全开) | **差距大**:他们是构建时/运行时双层,feature flag 65 个 |

---

## 3. 我们做得比 claude-code 好的地方(ovolv999 优势)

按"工程深度 × 实际意义"排:

### 3.1 反假成功纵深(DONE.flag + 7 态契约 + Reviewer)
- **ADR-007 抗伪造**:`nonce`(内存 UUID,绝不落盘,绝不进 prompt)+ `checkpoint phase='succeeded'` 双路径绑定;Driver 先写 checkpoint 再写 flag,崩溃窗口短路;**4 个 driver-owned 文件**(`DONE.flag` / `loop.lock` / `checkpoint.json` / `checkpoint.previous.json`)由 `isLoopDriverOwnedPath` 锁死
- claude-code **没有等价机制**:loop 是 `--loop` 子命令,模型自然结束;信任完全在模型自律

### 3.2 架构决策的硬权限(`architect` 升级)
- 中英双语关键词正则命中 → 必须 `model_role: "architect"` + `escalation_reason`
- 仅 **root main agent** 可请求;嵌套 agent 不可自提升
- 这是把"决策类型"硬编码进权限层的产品级约束

### 3.3 Capability-first 角色路由(`AgentModelPolicy`)
- 6 角色 × 2 tier × 6 能力分(reasoning / coding / toolCalling / speed / cost / contextWindow)
- 评分公式:`coding*3 + reasoning*2 + toolCalling`(builder) / `reasoning*3 + coding*2`(reviewer)
- cost 与 speed 仅作 tie-break(`speed*0.05 + cost*0.02`)
- 配置 tier 强制权威(`resolveModelTier`),角色不匹配 tier 直接拒绝 + `AgentModelAssignmentError` fail-closed
- claude-code 仅"主循环模型"概念

### 3.4 5 个运行时依赖 + 零原生约束
- ADR-006:`curl | sh` 安装,跨平台
- claude-code:多 100+ 依赖,Anthropic SDK 全家桶,平台特定 FFI(`audio-capture-napi` / `modifiers-napi`)

### 3.5 诚实的成本上报(`usageMissing` 不再伪造 $0)
- `recordGatewayAttempt`:`success && !usage` → 标记 `usageMissing`,EventLog 落 `llm_api_usage_missing`,warn 每 run 一次,`TurnOutcome.modelAttempts` 携带 `usageMissing` 字段
- claude-code:`withRetry.ts` 重试不区分 usage 缺失

### 3.6 9 态纯 reducer + run-scoped 上下文
- `transitionQueryState(state, action)` 纯函数,易测试
- `RunScopedRuntimeContext`(`runContextStore`)为每个 `runId` mint 独立 `taskGraph` / `progressMonitor` / `controlMessages` / `taskKind`,解决 v0.3.1 的多 turn 串味问题
- claude-code:`Message[]` 数组 + 单 store,无 run-scoped 隔离

### 3.7 4 种压缩 + 完整任务图 + Reviewer 7 态
- 我们的 `TaskGraph` 持久化,`Reviewer` 是 **deterministic post-run verdict**(**纯函数,不靠 LLM**)
- 他们的 `toolUseSummary` 是 **LLM 生成文本**,无法结构化验证

### 3.8 三态 Provider 熔断器 + 调度检查点恢复
- circuitState 可序列化进 checkpoint,跨进程 resume
- claude-code:无显式熔断器

### 3.9 内部控制消息隔离(10 类 + 立即 clear)
- `renderForProvider()` → 立即 `clear()`,永不进用户历史/导出
- claude-code:用文本 `role: system` 注入,会留在 transcript

### 3.10 Claim R/W/X 细粒度并发
- `metadata.claims(input)` 声明读/写/排他,git 强制 exclusive
- claude-code:`isConcurrencySafe: boolean`,无读/写分离

---

## 4. 我们欠缺的地方(ovolv999 差距清单)

按"产品级优先级"排序,**P0/P1 是先做的**。

### P0:核心产品能力

| 项 | claude-code | 我们的差距 | 建议路径 |
|---|---|---|---|
| **Anthropic 原生 API** | `firstParty` provider 直连,含 beta `task_budget-2026-03-13` | 仅 OpenAI 兼容协议,无法直连 Anthropic / Bedrock / Vertex | 新增 `AnthropicNativeAdapter`,复用 ModelGateway 抽象 |
| **Defer 工具 + TF-IDF 检索** | `shouldDefer: true` + `searchExtraTools`(`toolIndex.ts`)语义检索,大幅节省 context | 所有 tool schema 全量塞进 prompt,长上下文下成本高 | 引入 `SearchExtraTools` + 工具元数据 `searchHint` |
| **多 Permission Modes** | 7 种(`default` / `acceptEdits` / `bypassPermissions` / `dontAsk` / `plan` / `auto` / `bubble`) | 2 种 + `permissionRules.ts` 死代码 | 接通 `permissionRules.ts` glob 引擎,先实现 5 种 mode |

### P1:控制回路与隔离

| 项 | claude-code | 我们的差距 | 建议路径 |
|---|---|---|---|
| **Hooks 系统** | 11 种 event + `hookSpecificOutput`(JSON 决策回灌)+ `additionalContexts` | 仅 `runOnError` / `runOnComplete` 事后通知 | 引入 hook 协议,先实现 `PreToolUse` / `PostToolUse` |
| **Sandbox / Bubble** | `bubble` permission mode + `sandboxRuntime` 隔离 | 无原生 sandbox | 引入 `bubble` 概念或借 OS sandbox-exec |
| **ACP WebSocket 桥** | 完整 `acp-link/`(WebSocket ↔ ACP) | 仅 JSON-RPC stdio(基础) | 扩展 `integrations/acp.ts`,加 WebSocket server |
| **MCP OAuth** | 完整授权流 + token 刷新 + 端口选择 | 5 个内置模块之一(基础) | 引入 MCP OAuth 客户端 + token 持久化 |
| **Daemon / BG sessions** | `daemon/` 长驻 supervisor + `BG_SESSIONS` + `ps/logs/attach/kill` | `BackgroundTaskManager`(进程内队列) | 拆出 `daemon` 模块,加 IPC + 子进程管理 |

### P2:可观测与生态

| 项 | claude-code | 我们的差距 | 建议路径 |
|---|---|---|---|
| **Langfuse 集成** | 完整 trace/spans + `tengu_compact` 事件 | 仅本地 EventLog JSONL | 可选 Langfuse adapter,默认关闭 |
| **LSP 集成** | `LSPTool/` + 服务管理器 | 无 | 引入 LSP 客户端(language-server-protocol 包) |
| **Remote Control / Bridge** | 自托管 RCS + React Web UI | 无 | 暂缓,需要 SSH/网络层 |
| **Voice / Computer-Use** | 完整三平台 | 无 | 暂缓,与"零原生"约束冲突 |

### P3:产品外围

| 项 | claude-code | 我们的差距 |
|---|---|---|
| 设计系统 | Anthropic 视觉风格 + RCS Web UI + Mintlify | 简单 Ink |
| Marketplace / Plugins | 完整 | 无 |
| Skills 自动改进 | `useSkillImprovementSurvey` | 无 |
| IDE 桥接 | VSCode Bridge | 无 |
| Cloud Artifacts | Cloudflare Worker + R2 + TTL | 无 |
| SSH / 远端 session | `src/ssh/` | 无 |

---

## 5. 哲学差异(为什么我们不能直接抄)

### 5.1 上报 vs 不上报
claude-code 集成 Statsig GrowthBook + Langfuse + 全量 `tengu_*` 事件(线上产品级监控);
ovolv999 **坚持本地 JSONL**,无任何远程上报(CLAUDE.md 强调"运行时依赖仅 5 个")。

### 5.2 单传输 vs 流适配器
ovolv999:**单 OpenAI 兼容协议** + 13 个 `ProviderId` 元数据;`validateProfiles` 硬拒跨 provider profile — **少即是多**;
claude-code:**流适配器模式**(第三方 API 格式转 Anthropic 内部格式,下游完全不改) — **广度优先**。

### 5.3 信任模型
claude-code:模型自律 + Tool 主动 `description()` + 统计分类器 + Statsig 远程 gate(多 6 层防御);
ovolv999:**证据驱动反假** + DONE.flag 抗伪造 + Reviewer 纯函数 + 内部控制消息隔离(纵深防御,但**全部本地**)。

### 5.4 Loop 是产品
ovolv999:`--loop` 是 **一等公民**,WAKE→SCAN→PLAN→DO→REVIEW→CHECK→ACT + Driver/Model 权限分离;
claude-code:`--loop` 仅"让模型自然迭代",无显式状态机。

### 5.5 多代理协调
claude-code:coordinator/worker **二态** + 4 内置 agent 类型(`general-purpose` / `statusline-setup` / `explore` / `plan` / `verification`);
ovolv999:**6 角色 × 2 tier** + capability-first 评分 + architect 强升级 + `escalation_reason` 必填 + nested agent 防自提升。

---

## 6. 关键数据点(行数 / 文件数)

```
claude-code-best (v2.8.4):
  src/main.tsx            5640  (Commander.js CLI definition)
  src/screens/REPL.tsx    6684  (React/Ink REPL)
  src/query.ts            2057  (主循环 async generator)
  src/QueryEngine.ts      1365  (高层编排)
  src/services/api/claude.ts  3574  (Anthropic SDK 流)
  src/services/compact/compact.ts  1757  (压缩主逻辑)
  src/Tool.ts              802  (Tool 类型)
  packages/builtin-tools/src/tools/ 60 个工具
  packages/builtin-tools/src/tools/AgentTool/  多个 .tsx + UI
  src/components/        149 个组件
  src/hooks/             100+ hooks
  src/commands/          271 个命令
  packages/builtin-tools/ 60+ tools
  src/utils/claudemd.ts  1476 行 (CLAUDE.md discovery)
  packages/remote-control-server/ 自托管 RCS (React + Vite + Radix)
  packages/cloud-artifacts/   Cloudflare Worker + R2 + 7d/30d TTL
  packages/audio-capture-napi/  原生音频捕获

ovolv999 (v0.5.0):
  src/core/engine.ts                  1118  (装配门面)
  src/core/runtime/coordinator.ts     1507  (主循环 9 态 reducer)
  src/core/loopEngine.ts               896  (loop + DONE.flag ADR-007)
  src/core/loopSupervisor.ts           322  (租约 + 调度检查点)
  src/core/model/modelRouter.ts        572  (纯函数路由)
  src/core/model/modelGateway.ts       263  (单 OpenAI 兼容传输)
  src/core/model/agentModelPolicy.ts   208  (6 角色 × 2 tier 评分)
  src/core/runtime/completionContract  233  (7 态契约)
  src/core/workerAdapter.ts            228  (GAP-K 统一接口)
  src/tools/agent.ts                  1576  (子引擎 + 验证闸门)
  src/core/runtime/coordinator.ts     1507  (主循环)
  src/commands/builtin.ts             3487  (89 命令单文件)
  src/core/loopEngine.ts               896  (loop 协议)
```

**结论**:我们的核心循环深度 **不比他们浅**(coordinator.ts 1507 vs query.ts 2057,差 27%),但 **生态广度差 12.4×** — 主要在 product surface(组件 / hook / UI / 上报 / daemon)。

---

## 7. 立即可学的"低垂果实"

按 ROI 排序:

1. **TF-IDF 工具检索**(2–3 天):把 `shouldDefer` + `searchHint` + 语义索引搬过来,长上下文省 30%+ tool schema tokens
2. **Hook 协议最小集**(3–5 天):先 `PreToolUse` / `PostToolUse` 两种,JSON 决策回灌,够 80% 集成场景
3. **Anthropic 原生 SDK 适配器**(5–7 天):`firstParty` provider,beta `task_budget` 支持
4. **Defer 工具加载**(2–3 天):配合 #1,context 节省立竿见影
5. **Sandbox / bubble mode**(3–5 天):先 OS 层 sandbox-exec / Landlock,后续可上容器
6. **Permission modes 扩展**(2–3 天):接通 `permissionRules.ts`,先做 `acceptEdits` / `bypassPermissions` 两种

**不建议学的**:
- Langfuse / Statsig(违反"无远程上报"约束)
- Computer-Use / Voice(违反"零原生"约束)
- Cloud Artifacts / Marketplace(产品外围,投入产出比低)

---

## 8. 我们应该坚持不动的东西

1. **零原生 + 5 依赖**(ADR-006)
2. **单 OpenAI 兼容传输**(广度靠元数据,深度靠 capability)
3. **DONE.flag 抗伪造**(ADR-007)— 业界少有的硬约束,Claude Code 没有
4. **7 态完成契约 + 确定性 Reviewer** — 纵深反假成功是产品灵魂
5. **Driver/Model 权限分离** — Loop 一等公民
6. **Capability-first 角色路由** — 业界更细粒度的多代理协调
7. **本地 JSONL EventStore**(零依赖、原子、可外部审计)
8. **架构师角色强制升级**(`escalation_reason` 必填 + nested 防自提升)

---

## 9. 一句话总结

> claude-code 是 **产品广度** 的赢家(271 命令 / 60 工具 / 11 hooks / 7 permission modes / 7 providers / 多平台 daemon / Cloud Artifacts);
>
> ovolv999 是 **架构深度** 的赢家(DONE.flag 抗伪造 / 7 态完成契约 / 6 角色 × 2 tier capability 路由 / Driver-Model 权限分离 / 9 态纯 reducer / 单传输 + 5 依赖 / 零上报)。
>
> **相互学习的方向**:从 claude-code 搬 **TF-IDF 工具检索 / Defer 加载 / 多 Permission Modes / Hook 控制回路 / Anthropic 原生 SDK**,**不学**:Langfuse / Voice / Computer-Use / Marketplace / Cloud(违反我们"零原生 + 零远程上报 + 5 依赖"的根级约束)。

---

## 文件来源

- `/project/ovolv999_coding_pro/reference/claude-code/CLAUDE.md`(1500+ 行架构记忆)
- `/project/ovolv999_coding_pro/reference/claude-code/package.json`
- `/project/ovolv999_coding_pro/reference/claude-code/src/query.ts`(主循环)
- `/project/ovolv999_coding_pro/reference/claude-code/src/Tool.ts`(Tool 类型)
- `/project/ovolv999_coding_pro/reference/claude-code/src/services/compact/autoCompact.ts`(压缩)
- `/project/ovolv999_coding_pro/reference/claude-code/src/services/tools/StreamingToolExecutor.ts`(并发)
- `/project/ovolv999_coding_pro/reference/claude-code/src/coordinator/{coordinatorMode,workerAgent}.ts`(多代理协调)
- `/project/ovolv999_coding_pro/reference/claude-code/src/types/permissions.ts`(权限类型)
- `/project/ovolv999_coding_pro/reference/claude-code/src/utils/model/providers.ts`(provider 选择)
- `/project/ovolv999_coding_pro/reference/claude-code/packages/builtin-tools/src/tools/AgentTool/builtInAgents.ts`(内置 agent 列表)
