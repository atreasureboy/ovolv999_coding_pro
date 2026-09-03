# ovolv999 (v0.6.1) — 可观测、可控制、可恢复、可验证的多模型 Coding Agent Runtime

<div align="center">

**统一 Harness · 执行 Run 状态机 · 结构化事件持久化 · 资源调度 · Worker Steering · 三层记忆 · 故障恢复**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js)](https://nodejs.org/)
[![CI](https://github.com/atreasureboy/ovolv999_coding_pro/actions/workflows/ci.yml/badge.svg)](https://github.com/atreasureboy/ovolv999_coding_pro/actions/workflows/ci.yml)

> `ovolv999 "任何你需要它完成的任务"`

</div>

## 简介

ovolv999 是一个**多模型 Coding Agent Runtime**。所有 Agent 行为都走同一套可观测的执行 Run 状态机，状态变更通过结构化事件持久化，工具并发由资源冲突调度，子任务通过 Worker Steering 实时干预，故障后可从 JSONL 日志恢复。

项目定位：**可观测、可控制、可恢复、可验证的多模型 Coding Agent Runtime**。

### v0.4.2 Interaction Truth Closure

- 首次向导释放 readline，随后由唯一 UI 输入层接管 stdin。
- ESC 中断统一产出 `cancelled`，界面只承诺安全中断，不承诺暂停后恢复。
- `safe / standard / autonomous` 权限 Profile 统一所有入口；工具写权限同时受 TaskIntent 约束。
- informational 与默认 analysis 保持工作区只读；mutation 才开放写工具。
- `--pipe --format json` 的 stdout 只承载 JSON，诊断与交互信息进入 stderr。
- 当前模型来自 Runtime；自动路由或 fallback 后，状态栏、标题和结果卡同步成功模型。
- Session 加载错误按损坏、截断、schema、权限和消息格式分类，并保留上一版 `.bak`。
- 包管理、锁文件、CI、安装脚本和验收命令统一为 pnpm。

## v0.5.1 — 从 Claude Code 借鉴的能力（5 Round 收尾）

参照 `docs/comparison/claude-code-vs-ovolv999.md` 的差距分析，我们借鉴了 Claude Code 5 大能力。按"借鉴为主、创新为辅、保持我们更强项"原则实施：

| 借鉴 | Round | 文档 |
|---|---|---|
| **TF-IDF 工具检索 + Defer 加载** (`search_extra_tools`) | R1 | [ADR-008](docs/ADR/008-tfidf-tool-search.md) · [TOOL-SEARCH.md](docs/TOOL-SEARCH.md) |
| **Hook 协议** (PreToolUse / PostToolUse / UserPromptSubmit 等 6 种事件,JSON stdin/stdout) | R2 | [ADR-009](docs/ADR/009-hook-protocol.md) · [HOOKS.md](docs/HOOKS.md) |
| **7 种 Permission Modes** (default / acceptEdits / plan / auto / bypassPermissions / dontAsk / bubble) | R3 + R5 | [PERMISSION-MODES.md](docs/PERMISSION-MODES.md) |
| **Sandbox/Bubble 模式** (macOS sandbox-exec + Linux Landlock helper) | R3 + R4 + R5 | [SANDBOX.md](docs/SANDBOX.md) |
| **ACP WebSocket 传输** (`--acp-ws 8765`) + **MCP HTTP + OAuth PKCE** + **Daemon 长会话** | R4 + R5 + R6 | [ACP-WS.md](docs/ACP-WS.md) · [MCP-OAUTH.md](docs/MCP-OAUTH.md) · [DAEMON.md](docs/DAEMON.md) |
| **Anthropic 原生适配器** (zero-deps fetch + SSE,支持 thinking + cache beta headers) | R3 | [ADR-010](docs/ADR/010-anthropic-adapter.md) |
| **LSP 集成** (`lsp` tool: definition / references / hover / documentSymbol) | R3 + R5 | [LSP.md](docs/LSP.md) |

### 我们保持更强(借鉴原则中的"用我们自己的")

下列是 ovolv999 自有的反假成功纵深机制,**不替换**为 Claude Code 等价物:

- **DONE.flag 抗伪造**(ADR-007)— nonce + checkpoint 双路径绑定,Claude Code 没等价机制
- **7 态完成契约 + 确定性 Reviewer** — 比 Claude Code "模型说 done = done" 严格
- **Internal Control Messages(10+ 类)** — 与 ControlMessageLog 集成,绝不污染用户历史
- **Claim R/W/X 调度** — 比 `isConcurrencySafe: boolean` 粒度细
- **Capability-first Agent Tiers**(6 角色 × 2 tier)— Claude Code 是 2 态 coordinator/worker

### 审计记录(变更追溯)

每次借鉴都写 `docs/change/round-N-*.md`,记录新文件、修改文件、不在范围、风险、验证方式。

### 5 Round 收尾原则

- **不重复造轮子**:成熟的工具直接借用(`fs.watch` 应替换我们的 polling watcher,但我们没装,所以改注释)
- **借鉴为主,创新为辅**:借鉴 ~80%,创新 ~20%(指纹规避)
- **架构/UX/模块设计 直接抄**:协议、UX 模式可借鉴

测试通过 `pnpm check` 验证 (typecheck + lint + test + test:esm + eval:deterministic + verify:runtime-static + test:runtime-behavior)。`pnpm prepack` 在此基础上加 `build + package:verify`。

### v0.5 Role-aware Multi-Agent

主 Agent 可以保持顶级模型，现有 `AgentTool` 创建子 Agent 时按能力角色选择独立模型 Profile：

| 角色 | 默认用途 |
|---|---|
| `architect` | 全局架构、复杂决策、最终审查 |
| `builder` | 具体实现、测试与局部重构 |
| `reviewer` | 独立代码审查与风险检查 |
| `utility` | 探索、摘要和低成本辅助 |
| `planner` | 只读规划 |
| `embedding` | 预留给检索模块，不会被启动为 Agent |

多 Provider 与多 API Key 通过环境变量引用配置，真实 Key 不写入配置、事件或 Worker Result：

```json
{
  "models": {
    "profiles": [
      {
        "id": "architect",
        "tier": "top",
        "provider": "openai",
        "model": "frontier-model",
        "roles": ["main", "architect"]
      },
      {
        "id": "builder",
        "tier": "secondary",
        "provider": "minimax",
        "model": "coding-model",
        "baseURL": "https://example.com/v1",
        "apiKeyEnv": "OVOLV999_BUILDER_API_KEY",
        "roles": ["builder", "worker"]
      }
    ]
  }
}
```

主 Agent 通过 `model_role` 请求能力等级，通过 `delegation_context` 传递目标、约束、相关文件、架构决策和验收标准。子 Agent 返回结构化 Worker Result；最终完成权仍属于主 Agent。

模型层级由配置中的 `tier: "top" | "secondary"` 唯一决定，Runtime 不根据模型名称或价格猜测强弱。主 Agent 与 `architect` 只使用 `top`；所有普通子 Agent 只使用 `secondary`。只有根主 Agent 能显式申请 `architect`，且必须提供 `escalation_reason`；嵌套 Agent 的顶级模型申请会被 Runtime 拒绝。配置了次级 Profile 但凭据不可用时会直接返回诊断错误，不会静默跨层级回退。没有配置任何模型 Profile 的旧版单模型安装仍保持兼容；缺少 `tier` 的旧 Profile 暂按 `roles` 推导并输出迁移警告。

项目能力优先于 Token 节约。Runtime 鼓励主 Agent 将重复劳动、范围明确的底层实现、代码阅读与摘要、测试补充和独立复核交给次级子 Agent；架构设计、跨模块公共接口、迁移、安全边界和根因级决策会被强制升级为 `architect`。同一角色存在多个 Profile 时，代码、推理和工具能力优先，成本与速度只用于质量满足后的弱同级决胜。

当前版本接通的是生成模型的角色分工。`embedding` Profile 只会被隔离在 Agent 路由之外，内置向量生成与向量数据库适配尚未接通。

## 运行时核心能力

`ModelRouter`、`TaskGraph`、`ProgressMonitor` 和 `InternalControlMessage` 均接入主执行链，具备真实数据通路、fallback、结构化事件、事件回放和确定性测试覆盖。

### 能力矩阵

| § | 能力 | 入口 / 关键类 | 测试 |
|---|------|--------------|------|
| 1 | 自动路由不会创建 manual override | `ModelRouter.applyRoutingDecision` | `tests/modelRouterApiSplit.test.ts` |
| 2 | 自动路由可连续多轮重新决策 | `RuntimeCoordinator.collectRoutingSignals` 每轮调用 | 同上 |
| 3 | 用户显式选择仍具有最高优先级 | `setModelByUser` + `MODEL_OVERRIDE_SET` 事件 | 同上 |
| 4 | 主 Router 拒绝跨 Provider 绑定；跨 Provider Worker 仅在 Agent 边界解析 | `validateProfiles` + `resolveAgentModelAssignment` | `tests/modelRuntimeManager.test.ts`、`tests/agentModelPolicy.test.ts` |
| 5 | Router 接收真实运行信号（11 项¹） | `RoutingSignalCollector` | `tests/routingSignalCollector.test.ts` |
| 6 | 健康、延迟和失败数据真实更新 | `ModelRouter.recordCall` 在 `callLLM` 真实调用 | `tests/providerFallback.test.ts` |
| 7 | fallback 可测试且不重复副作用 | `ModelGateway.isRetryableProviderError` + `onProviderError` | 同上 |
| 8 | Coordinator 真正调用 CompletionContract | `evaluateCompletion` 在 stop_sequence 后调用 | `tests/completionContractStatus.test.ts` |
| 9 | 同一个最终 verdict | 契约层 7 态（completed / partial / blocked / failed / cancelled / exhausted / incomplete）；TurnOutcome 对外收敛为 6 态，incomplete = 继续执行而非终裁 | 同上 |
| 10 | acceptance criteria 不再硬编码为零 | `TaskNode.acceptanceCriteria` + Reviewer 真实传递 | 同上 |
| 11 | TaskGraph 按 runId 隔离 | `TaskGraphStore` + per-runId 注入 coordinator | `tests/taskGraphStore.test.ts` |
| 12 | TaskPlan 状态转换严格（13 个 action） | `TaskPlanTool` 完整动作集 | `tests/taskPlanAuditFixes.test.ts` |
| 13 | TaskGraph 可事件化恢复 | `TaskGraph.serialize/restore` + 事件 emit | `tests/runEventTypes.test.ts` |
| 14 | ProgressMonitor 接收任务节点变化 | `recordTaskNodeTransition` | `tests/taskPlanAuditFixes.test.ts` |
| 15 | 能检测非连续重复循环（A→B→A→B） | `ProgressMonitor.detectABABPattern` | `tests/progressMonitorSliding.test.ts` |
| 16 | completion-time critic 生效 | `modelClaimingCompletion: true` 真实传递 | `tests/completionContractStatus.test.ts` |
| 17 | 不存在两套 Critic 调度 | `shouldInvokeCritic` 单一入口 | `tests/criticReviewer.test.ts` |
| 18 | 内部控制消息不污染用户历史 | `ControlMessageLog` 临时渲染给 provider 后 `clear()` | `tests/internalControlMessage.test.ts` |
| 19 | `/trace` 基于事件回放 | RunEvent 54 种类型化变体（内存层）+ run.* 持久事件 | `tests/runEventTypes.test.ts` |
| 20 | `/why` 基于真实决策证据 | `Router.getLastDecision()` + `RouterEventListener` | `tests/slashCommandRealTrace.test.ts` |
| 21 | `/progress` 可用 | `getContextManager / getTaskGraph / getProgressMonitor / getCostTracker` | 同上 |
| 22 | 重复 SlashCommand 注册会被检测 | dev 模式 throw | 同上 |
| 23 | 至少 15 个确定性 Runtime Eval | **18 个 deterministic + 10 个 wiring** | `evals/deterministic-runtime` + `evals/wiring-smoke` |
| 24 | 文档与真实能力一致 | `README.md` + `docs/ADR/` | — |
| 25 | typecheck / lint / unit / integration / deterministic 全部通过 | 完整测试套件通过 | `pnpm test` |

> ¹ 信号 schema 完整（11 项契约 + 6 项次级），但部分运行期为代理/中性值：`repoFileCount = filesTouched×10` 廉价代理（`routingSignalCollector.ts:137`），`budgetRemaining` 尚未从 budget 模块接线（`coordinator.ts:404` 显式 undefined）。信号真实化列入演进 backlog。

### 新增模块文件

```
src/core/model/
  ├─ routingSignalCollector.ts   (11-signal schema collector)
  ├─ providerRuntimeBinding.ts   (Profile + Adapter + capabilities)
  └─ modelRuntimeManager.ts      (validateProfiles + BindingRegistry)
src/core/runtime/
  ├─ taskGraphStore.ts           (per-runId TaskGraph isolation)
  └─ internalControlMessage.ts   (8-kind typed control channel)
evals/
  ├─ wiring-smoke/               (10 source-of-truth checks)
  ├─ deterministic-runtime/      (18 runtime contract cases)
  └─ baselines/                  (tsBugfix.json baseline)
```

### 真实调用链（v0.3.1）

```
user input → CLI/REPL (bin/ovogogogo.ts)
  → resolveApiEnvironment() picks provider
  → if --model: engine.setModelByUser(config.model) [sticky override]
  → ExecutionEngine → RuntimeCoordinator.run()
    → boot() (modules + system prompt + ExecutionContext + toolContext)
    → [loop]
       → check_abort → budget_check
       → collectRoutingSignals(11) → router.route → router.applyRoutingDecision
         (real fallback, real health attribution, real budget allocation)
       → module_iteration (single-track Critic, modelClaimingCompletion-aware)
       → llm_call
         → ModelGateway.call() [isRetryableProviderError → onProviderError → Router.nextFallback]
         → StreamConsumer.consume()
         → recordUsage → costTracker + modelRouter.recordCall(profileId, ok, latencyMs, usage)
       → control_messages (ControlMessageLog → renderForProvider → clear)
       → parse_response → tool_execution
    → completion: stop_sequence → evaluateCompletion
      → 6-state verdict (completed/partial/blocked/failed/cancelled/exhausted)
      → RegistryRun transitions to succeeded|blocked|cancelled|failed
      → COMPLETION_EVALUATED / COMPLETION_REJECTED 事件
```

### Runtime 验收矩阵

| § | 验收要点 | 实现位置 | 测试 |
|---|---------|---------|------|
| 1 | 所有执行行为都有统一 Run ID | `src/core/executionRun.ts` + `coordinator.ts:run()` 每轮 mint `kind='turn'` | `tests/gapCCoordinatorRunWiring.test.ts` |
| 2 | 所有子任务都有父子关系 | `AgentTool` / `ClaudeCodeTool` / `BackgroundTaskManager` 创建子 run 时携带 `parentRunId` | `tests/agentExecutionRun.test.ts` |
| 3 | 所有状态变化都有结构化事件 | `ExecutionRunEventBus` 持久化优先（JSONL），in-process `.on()` 订阅为扩展点 | `tests/executionRunEvents.test.ts` |
| 4 | 修改型 Agent 自动使用独立 worktree | `AgentTool` 检测 `modifies_state=true` → worktree + 自动合并 | `tests/agentWorktreeIsolation.test.ts` |
| 5 | 子 Agent 可以查询、steer、cancel 和 collect | `WorkerAdapter` 全生命周期（ClaudeCodeTool 完整实现 start/status/steer/cancel/collect/wait/reattach）；`/workers` 交互命令直连 Manager | `tests/gapKWorkerSteer.test.ts`, `tests/phase3WorkerLifecycle.test.ts` |
| 6 | 任务完成必须通过 Verification Gate | `AgentTool` verify flag → `verifyPlanExecution` 工具 | `tests/agentFalseSuccess.test.ts` |
| 7 | 验证失败绝不标记成功 | `StructuredToolResult.status='failed'` → `isError=true`（Bash 非零 exit 同样） | `tests/structuredToolResult.test.ts` |
| 8 | Worker 崩溃或主进程重启后可恢复状态 | `JsonlEventStore` + `recoverRegistryFromStore` + 引擎启动时标记 in-flight → failed | `tests/gapGEngineRecovery.test.ts` |
| 9 | 工具并发由资源冲突决定 | `ResourceScheduler`（R/W/X 矩阵）+ 工具 `metadata.claims` 声明 | `tests/gapDToolClaims.test.ts`, `tests/resourceScheduler.test.ts` |
| 10 | 上下文压缩不丢失关键工作状态 | `WorkingState` + INV-1..INV-5 不变量 + `maybeCompactWithInvariants` | `tests/workingState.test.ts` |
| 11 | 长期记忆绑定来源和 commit | `LongTermMemory` R1-R6 闸门（验证 / 来源标记 / commit 绑定 / 过期 / 冲突合并）——**✅ 已接入引擎主循环**（MemoryModule 通过 LTM 提供 boot relevance + `memory_search` + 持久化） | `tests/longTermMemory.test.ts` |
| 12 | Provider 差异不泄漏到主 Runtime | 运行时路径：`OpenAICompatibleAdapter`（anthropic / openai / minimax / openai-compatible，4 可服务）；`ModelCapabilities` + `ProviderAdapter` 注册表 + `toProviderRequest` / `fromProviderStreamChunk` —— **✅ 已接线**：ModelGateway 通过 `ProviderAdapter.stream()` 调用 | `tests/modelCapabilities.test.ts` |
| 13 | README 展示 Runtime 能力（非工具数量） | 本节 | — |

### 故障注入覆盖（§十二）

`tests/gapLFaultInjection.test.ts` 强制触发 9 类失败场景，验证系统优雅降级：

- JSONL 半写 / 损坏行 → readAll 跳过、recover 重建
- Provider 流缺 `choices` / 中途抛错 → reason='error'、不泄漏 in-flight 标记
- ResourceScheduler 超时 / abort → 干净清理等待队列
- Compaction 不变量违反 → 抛 `CompactionInvariantError`，不静默丢失
- Registry 非法 transition → 抛 `InvalidRunTransition`，状态保持规范
- AgentTool.steer() 终态 run → 拒绝排队
- JsonlEventStore.append() 磁盘满 → 抛错（写侧非 best-effort）

### 其它特性

- **统一 Harness** — 所有 Agent 走同一套 Boot Sequence，按模块配置差异化执行
- **模块化能力** — memory / critic / workspace / workspace_watcher / mcp 五个生产模块（reflection 已移至 experimental/）
- **配置驱动角色** — 探索者、规划者、审查者 = 不同 AgentConfig 配置实例，零代码新增角色
- **记忆系统** — 引擎层：Semantic（语义知识，来源优先级 user_stated > agent_inferred > tool_observed）+ Episodic（工具轨迹，被动写入）；命令/契约层：KnowledgeBase、TeamMemory、LongTermMemory（R1–R6，尚未接入引擎循环）
- **来源归因 + 冲突解决** — `user_stated > agent_inferred > tool_observed` 优先级链
- **验证闸门** — 子 agent 完成代码修改后自动按项目 scripts / 语言工具验证（No Tuple, No Merge）
- **并发调度** — 只读/安全工具并行 (Promise.all)，状态工具串行
- **流式引擎** — Streaming LLM API，tool_call 解析 → 分区调度 → 结果注入 → 循环
- **Plan 模式** — `EnterPlanMode` / `ExitPlanMode` / `VerifyPlanExecution` 闭环
- **MCP 客户端** — stdio + HTTP transport，OAuth2 PKCE 授权，工具以 `mcp__<server>__<tool>` 注入
- **沙箱执行** — 3 级安全策略（permissive/standard/strict），macOS sandbox-exec + Linux bubblewrap
- **进程内 LSP** — tsserver / pylsp / rust-analyzer / gopls，JSON-RPC 2.0，诊断 + 符号搜索
- **SSH 远程** — SshProfile 管理，rsync 同步，远程 agent 执行
- **后台会话** — `--bg` 启动 detached 会话，`ps/attach/logs/stop/rm/clean` CLI 管理
- **上下文管理** — microCompact + snipCompact + autoCompact 三级策略，含系统提示词 token
- **Budget + Effort** — token 预算控制 + 自动 effort 分级
- **Auto-Classifier** — 自动将用户请求分类为 code/search/debug/general，选择最优 effort
- **Auto-Dream** — 被动模式统计库（patterns.json 触发→动作成功计数、dream-log.json；无离线 LLM 整理过程）
- **MagicDocs** — 自动从代码提取项目文档（7 种提取器：overview/api/models/config/decisions/patterns/dependencies）
- **遥测** — opt-in 本地分析，14 种事件类型，聚合统计
- **设置同步** — AES-256-GCM 加密，git/file 传输，跨机器配置同步
- **系统健康检查** — 13 项环境检测（Node/API/磁盘/Git/权限等）
- **自动更新** — semver 比较，npm dist-tag 检查，ignore-list
- **缓存统计** — prompt-cache hit/miss 追踪，per-model 分解，成本节约
- **IDE 检测** — 9 种编辑器检测（VSCode/IntelliJ/Vim/Emacs/...），路径转换，扩展推荐
- **生命周期 Hooks** — 6 种：PreToolUse / PostToolUse / UserPromptSubmit / SessionStart / SessionEnd / Notification
- **Skill 系统** — frontmatter 解析 + 懒加载 + 语义搜索 + auto-suggestion
- **Plugin 系统** — 动态加载 npm 包/本地路径插件
- **Permission 系统** — allow/deny 规则 + glob 匹配 + 持久化
- **命令历史 + 书签** — 跨 session 命令历史 + 位置书签
- **文件历史 / Rewind** — 每次编辑快照，可回滚
- **ACP 协议** — Agent Communication Protocol server
- **Vim 模式** — normal/insert/visual 模式，keybinding 可定制
- **Ink/React UI** — 默认富终端 UI，实时多行输入、补全与交互式面板
- **零领域绑定** — 核心是 Agent 基础设施，业务逻辑通过 Module + Tool 插件注入

## 架构全景

```
╔═══════════════════════════════════════════════════════════════════════════╗
║                   ovolv999 — 统一 Harness + 模块化 Agent 基座               ║
║              多模型 Worker · 结构化 Run 状态机 · 资源调度 · 验证闸门 · 恢复  ║
║              Runtime: openai · glob · zod · ink · react · @anthropic-ai/sdk · chokidar · vscode-jsonrpc           ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║  ┌─ AgentConfig ──────────────────────────────────────────────────────┐   ║
║  │  identity(SOUL) + modules[] + tools[] + skills[] + limits           │   ║
║  │  ↓ preset (explore/plan/code-reviewer/general-purpose) 或 custom     │   ║
║  └────────────────────────────────────────────────────────────────────┘   ║
║                                  │                                        ║
║  ┌───────────────────────────────▼────────────────────────────────────┐   ║
║  │              ExecutionEngine (thin facade + assembly root)          │   ║
║  │  wires subsystems → delegates runTurn() to RuntimeCoordinator       │   ║
║  │  public API: abort/softAbort/dispose/planMode/getters               │   ║
║  └───────────────────────────────┬────────────────────────────────────┘   ║
║                                  │                                        ║
║  ┌───────────────────────────────▼────────────────────────────────────┐   ║
║  │                    RuntimeCoordinator (loop driver)                 │   ║
║  │                                                                     │   ║
║  │  ┌─ Boot (boot.ts) ─────────────────────────────────────────────┐  │   ║
║  │  │ moduleManager.boot() → ToolRegistry.reset(base+module)        │  │   ║
║  │  │ buildSystemPrompt()  → identity + module sections             │  │   ║
║  │  │ toolPolicy.getExposedDefinitions() → planMode + agent filter  │  │   ║
║  │  │ buildToolContext()   → base + module patches                  │  │   ║
║  │  │ RunEventEmitter.emit(BOOT_COMPLETED)                          │  │   ║
║  │  └───────────────────────────────────────────────────────────────┘  │   ║
║  │                                                                     │   ║
║  │  ┌─ State Machine Loop (queryStateMachine.ts) ─────────────────┐   │   ║
║  │  │ check_abort → TerminationPolicy (hard/soft/maxIter/continue) │   │   ║
║  │  │ budget_check → ContextManager.evaluateBudget                 │   │   ║
║  │  │   ├─ 50%: snipCompact  ├─ 70%: warn  ├─ 85%: autoCompact     │   │   ║
║  │  │ module_iteration → moduleManager.runIteration (critic loop)   │   │   ║
║  │  │ llm_call → ModelGateway.call → StreamConsumer                 │   │   ║
║  │  │   └─ reactive compact on context_overflow                     │   │   ║
║  │  │ parse_response → JSON validation + malformed-args handling    │   │   ║
║  │  │ tool_execution → ToolScheduler                                │   │   ║
║  │  │   ├─ partitionToolCalls → parallel(safe) / serial(stateful)   │   │   ║
║  │  │   ├─ ToolExecutor → registry + policy + permission + hooks    │   │   ║
║  │  │   │    + truncate + module notify + RunEvent emit             │   │   ║
║  │  │   └─ enforceAggregateBudget (truncate oversized results)      │   │   ║
║  │  │ SharedRuntimeState.activeToolCalls ← track per call            │   │   ║
║  │  │ RunEventEmitter ← emit at every transition                    │   │   ║
║  │  └──────────────────────────────────────────────────────────────┘   │   ║
║  │                                                                     │   ║
║  │  ┌─ Post-Run ────────────────────────────────────────────────────┐  │   ║
║  │  │ MemoryModule.onComplete → decidePromotion()                   │  │   ║
║  │  │   (candidate → verified=true for completed runs;                │  │   ║
║  │  │    kind='failure' for partial/blocked/cancelled runs)         │  │   ║
║  │  │ RunEventEmitter.emit(RUN_TERMINATED { status })               │  │   ║
║  │  └────────────────────────────────────────────────────────────────┘  │   ║
║  │                                                                     │   ║
║  │  Shared state: SharedRuntimeState (planMode, abort, allTools,      │   ║
║  │    activeToolCalls, activeSubtasks)                                 │   ║
║  │  Events: RunEventEmitter (16 typed event variants, pub/sub)        │   ║
║  │  Abort: softAbort(ESC) / hardAbort(Ctrl+C)                        │   ║
║  └─────────────────────────────────────────────────────────────────────┘   ║
║                                                                           ║
║  ┌─ Modules ──────┐  ┌─ Tools ─────────────┐  ┌─ Memory (3 层) ──────┐  ║
║  │ memory         │  │ Bash/Read/Write/Edit │  │ Semantic: 关键词检索  │  ║
║  │ critic         │  │ Glob/Grep/Todo       │  │ Episodic: 工具轨迹    │  ║
║  │ workspace      │  │ Web* /Agent/Skill    │  │ KnowledgeBase: 结构化 │  ║
║  │ (experimental) │  │                       │  └──────────────────────┘  ║
║  └────────────────┘  │ Worktree/Goal        │                             ║
║                      │ Task*/Notebook       │  ┌─ Integration ─────────┐  ║
║  ┌─ MCP Client ───┐  │ ClaudeCode/Diag      │  │ LSP (in-process)      │  ║
║  │ stdio + HTTP   │  │ MCP Resources        │  │ SSH Remote            │  ║
║  │ OAuth2 PKCE    │  │ Tmux/Shell Session   │  │ Sandbox (3 levels)    │  ║
║  │ Resources      │  └──────────────────────┘  │ Background Sessions   │  ║
║  └────────────────┘                            │ MagicDocs             │  ║
║  ┌─ Commands ────┐                            │ Telemetry             │  ║
║  │ slash builtin │                            │ Settings Sync         │  ║
║  └───────────────┘                            └──────────────────────┘  ║
║                                                                           ║
║  输出: sessions/session_TIMESTAMP/ → 会话产物、EventLog、agent-logs       ║
╚═══════════════════════════════════════════════════════════════════════════╝
```

## 核心概念

### Module System — 模块化能力

所有 Agent 共享同一套 Harness，通过启用/禁用模块获得差异化能力：

```typescript
const agentConfig: AgentConfig = {
  identity: { systemPrompt: (cwd) => `你是运维员...` },
  modules: {
    memory: { enabled: true },      // 记忆检索 + memory_write/search/recall 工具
    critic: { enabled: true },      // 每 N 轮 LLM 纠错
    workspace: { enabled: true },   // sessionDir 产物目录
    // reflection: experimental/ 中保留（disabled by default）
  },
  tools: ['Bash', 'Read', 'Grep'],
  maxIterations: 50,
}
```

| 模块 | Boot 行为 | 循环行为 | 提供的工具 |
|------|----------|---------|-----------|
| `memory` | 关键词相关性检索注入 top-10 | onToolCall 写 episodic | memory_write / memory_search / memory_recall |
| `critic` | — | onIteration 每 5 轮纠错 | — |
| `workspace` | 注入 sessionDir 到 ToolContext | — | — |
| `reflection` (experimental/) | — | onComplete LLM 知识提取 | 默认不启用 |
| `mcp` | 连接 stdio MCP 服务器并注入工具 | dispose 关闭进程 | `mcp__<server>__<tool>`（动态注入） |

### AgentConfig — 配置驱动角色（无 agent_type）

4 个内置 preset + 无限自定义组合：

| 预设 | modules | tools | 场景 |
|------|---------|-------|------|
| `explore` | `{}` | Read/Glob/Grep/Web* (planMode) | 代码探索 |
| `plan` | `{}` | Read/Glob/Grep/Web* (planMode) | 实现规划 |
| `code-reviewer` | `{}` | Read/Glob/Grep (planMode) | 代码审查 |
| `general-purpose` | `{memory,workspace}` | 全工具（排除 Agent 防递归） | 通用子任务 |
| 自定义 | 任意组合 | 任意子集 | 零代码新增角色 |

### Memory System — 三层记忆 + 来源归因 + 整合闭环

```
写入 (memory_write):
  source: user_stated(3) > agent_inferred(2) > tool_observed(1)
  → 同内容冲突: 低优先级不能覆盖高优先级

Boot 时检索:
  userMessage → extractKeywords → scoreRelevance → top-10 注入

Session 整合 (REPL 退出):
  episodic 全量 → LLM 总结 → 高置信度知识 → SemanticMemory (source: consolidation)

跨 Session:
  下次 Boot → 相关性检索 → 自动注入
```

### Verification Gate — 验证闸门 (No Tuple, No Merge)

```typescript
Agent({
  description: "实现登录功能",
  prompt: "...",
  subagent_type: "general-purpose",
  verify: true   // ← 完成后自动跑 package scripts 或语言检查
})
```

验证命令优先读取 `package.json` scripts：`typecheck` 或 `build`、`lint`、`test`。没有 scripts 时按项目类型回退到 `npx tsc --noEmit`、`go vet ./...`、`cargo check` 或 `python -m compileall -q .`。

### 并发分区调度

```
tool_calls [A, B, C, D, E, F]
     │
     ├─ partitionToolCalls()
     │
     ├─ Batch 1 (并行): [A=Read, B=Glob, C=WebSearch]
     │     → Promise.all([A, B, C]) → 同时执行
     │
     ├─ Batch 2 (串行): [D=Write]
     │     → 等 Batch 1 完成 → 执行 D
     │
     └─ Batch 3 (并行): [E=Bash, F=Agent]
           → Promise.all([E, F]) → 同时执行
```

## 工具参考

| 类别 | 工具 | 说明 |
|------|------|------|
| **文件** | Read, Write, Edit, NotebookEdit | 文件读写编辑 + Jupyter notebook |
| **搜索** | Glob, Grep | 文件名匹配 + 内容正则搜索 |
| **执行** | Bash, ShellSession, TmuxSession | 跨平台 shell + 持久会话 |
| **Web** | WebFetch, WebSearch | URL 抓取 + 搜索 |
| **Agent** | Agent, ClaudeCode | 子 agent 调用 + 外部 Claude Code worker |
| **Plan** | EnterPlanMode, ExitPlanMode, VerifyPlanExecution | 计划模式闭环 |
| **Task** | TaskCreate, TaskGet, TaskList, TaskUpdate, TaskStop | 后台任务生命周期 |
| **Memory** | memory_write, memory_search, memory_recall | 三原语（MemoryModule 提供） |
| **Worktree** | EnterWorktree, ExitWorktree, ListWorktrees | Git worktree 管理 |
| **Skill** | load_skill, Snip | 技能懒加载 + 上下文裁剪 |
| **诊断** | Diagnostics, Goal, Sleep | LSP 诊断 + 目标 + 延时 |
| **MCP** | ListMcpResources, ReadMcpResource | MCP 资源读取 |
| **其他** | AskUser, TodoWrite | 用户交互 + 任务清单 |

## 斜杠命令

| 类别 | 命令 |
|------|------|
| **会话** | `/exit` `/clear` `/reset` `/resume` `/sessions` `/status` `/context` `/cost` |
| **上下文** | `/compact` `/snip` `/rewind` `/undo` `/retry` `/export` `/audit` `/snapshot` |
| **模式** | `/mode` `/poor` `/vim` `/style` `/effort` `/budget` `/model` `/models` |
| **工具/权限** | `/permissions` `/config` `/files` `/cwd` `/tasks` `/workers` `/plugins` |
| **搜索/知识** | `/search` `/knowledge` `/skill-save` `/skills` `/suggest` `/cmd-history` `/bookmark` `/snippet` |
| **代码/Git** | `/diff` `/commit` `/git` `/branch` `/metrics` `/diff-browser` `/review` `/security-review` |
| **诊断** | `/doctor` `/health` `/diagnostics` `/hooks` `/goal` `/transcript` `/scan` `/debug-tool-call` |
| **安全/沙箱** | `/sandbox` `/vault` `/permissions` |
| **远程/同步** | `/sync` `/ssh` `/lsp` `/update` `/cache` `/ide` |
| **团队/记忆** | `/team-memory` `/dream` `/messages` `/telemetry` `/magic-docs` |
| **系统** | `/init` `/version` `/copy` `/help` `/history` `/keybindings` `/workflow` `/onboard` `/daemon` `/schedule` `/timer` `/profile` `/notify` `/share` `/title` `/fork` `/serve` `/gc` |

## 如何扩展

### 方式 1: 编写自定义 Tool

```typescript
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'

export class MyCustomTool implements Tool {
  name = 'MyCustom'
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'MyCustom',
      description: '...',
      parameters: { type: 'object', properties: { /* ... */ }, required: ['input'] },
    },
  }
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    return { content: 'done', isError: false }
  }
}
```

注册到 `src/tools/index.ts` 或通过 `EngineConfig.extraTools` 注入。

### 方式 2: 编写自定义 Module

```typescript
import type { AgentModule, ModuleBootContext, ModuleBootResult } from '../core/module.js'

export class MyModule implements AgentModule {
  readonly name = 'my-module'
  readonly dependencies = ['memory']

  boot(ctx: ModuleBootContext): ModuleBootResult {
    return {
      systemPromptSections: ['## Custom Knowledge\n...'],
      tools: [myCustomTool],
    }
  }

  onToolCall(toolName: string, input: Record<string, unknown>, result: { content: string; isError: boolean }): void {
    // 每次工具调用后的副作用
  }
}
```

注册: `globalModuleRegistry.register('my-module', (ctx) => new MyModule())`

### 方式 3: 自定义 Agent 角色

```typescript
const config: AgentConfig = {
  identity: {
    systemPrompt: (cwd: string) => `Working directory: ${cwd}\n\n你是安全审计员...`,
  },
  modules: { memory: { enabled: true }, workspace: { enabled: true } },
  tools: ['Read', 'Glob', 'Grep', 'Bash'],
  maxIterations: 50,
}

// 通过 Agent 工具的 agent_config 参数使用
Agent({ description: '审计认证模块', prompt: '...', agent_config: config })
```

### 方式 4: 添加自定义 Skill

在 `.opencode/skills/` 下创建 Markdown 文件:

```markdown
---
name: deploy
description: 部署到生产环境
tools: Bash, Read
---
检查 staging 环境，确认测试通过后部署到生产...
```

LLM 可通过 `load_skill("deploy")` 按需加载。支持语义搜索匹配最相关技能。

### 方式 5: 编写 Plugin

```typescript
// my-plugin/index.ts
import type { Plugin } from '../core/plugins.js'

export const plugin: Plugin = {
  name: 'my-plugin',
  version: '1.0.0',
  tools: [myCustomTool],
  modules: [myModule],
  setup(ctx) { /* 初始化 */ },
}
```

通过 `.ovogo/settings.json` 的 `plugins` 字段或 `/plugins` 命令注册。

## 快速开始

### 安装

macOS / Linux 一键安装：

```bash
curl -fsSL https://raw.githubusercontent.com/atreasureboy/ovolv999_coding_pro/main/install.sh | bash
```

Windows PowerShell 一键安装：

```powershell
irm https://raw.githubusercontent.com/atreasureboy/ovolv999_coding_pro/main/install.ps1 | iex
```

安装器会在隔离目录中完成锁定依赖安装、构建和命令冒烟测试，全部成功后才替换现有版本；升级失败会保留原安装。生产环境可通过 `--version <tag>` 固定到明确版本。

从源码运行：

```bash
git clone https://github.com/atreasureboy/ovolv999_coding_pro.git
cd ovolv999_coding_pro
pnpm install --frozen-lockfile
pnpm build
```

### 配置

```bash
export OPENAI_API_KEY="your-key"
# export OPENAI_BASE_URL="https://your-proxy.com/v1"
# export OVOGO_MODEL="claude-sonnet-4-6-20250514"
```

### 使用

```bash
# 交互模式 — REPL
npx tsx bin/ovogogogo.ts

# 单任务模式
npx tsx bin/ovogogogo.ts "修复 src/core 的类型错误"

# 指定模型和工作目录
npx tsx bin/ovogogogo.ts -m claude-sonnet-4-6 --cwd /my/project

# 后台会话模式
npx tsx bin/ovogogogo.ts "长任务" --bg

# 后台会话管理
ovolv999 ps           # 列出所有后台会话
ovolv999 attach <id>  # 附加到后台会话
ovolv999 logs <id>    # 查看日志
ovolv999 stop <id>    # 停止会话
ovolv999 clean        # 清理已终止会话

# 构建后使用全局命令
pnpm build
pnpm link --global
ovolv999 "任务描述"
```

### Loop 自主执行模式

Loop 模式按照 `PLAN → DO → REVIEW → CHECK → ACT` 周期持续推进任务，并通过独立验收命令、质量门禁、租约、心跳和 checkpoint 决定继续、恢复或完成。v0.3.6 将 heartbeat 的存活信号与真实 progress 证据分离；连续心跳写入失败或连续三轮没有代码、验证、TaskGraph、Worker 等可核验证据时会进入 PARKED。

在交互界面中可以像使用 `/goal` 一样直接启动：

```text
/loop 全面审计并修复当前项目
/loop continue
/loop restart
/loop status
/loop init 只创建契约但暂不执行
```

```bash
# 1. 在目标项目中生成 .loop/ 契约；已有文件不会被覆盖
ovolv999 --cwd /my/project --loop-init "完成迁移并通过全部验证"

# 2. 检查并按需编辑目标与验收条件
$EDITOR /my/project/.loop/GOAL.md
$EDITOR /my/project/.loop/ACCEPTANCE.md

# 3. 启动；默认最多 12 轮，意外退出后自动从 checkpoint 恢复
ovolv999 --cwd /my/project --loop

# 调整轮数或放弃旧 checkpoint 重新执行
ovolv999 --cwd /my/project --loop --loop-max-iters 20
ovolv999 --cwd /my/project --loop --loop-restart
```

运行中可在另一个终端执行 `ovolv999 --cwd /my/project`，再使用 `/loop-status` 查看租约、心跳、轮次、checkpoint 和完成标记。Loop 只接受形如 ``- [ ] A1: 描述 `验证命令` `` 的验收项。`CANDIDATE_DONE.flag` 必须是绑定当前 `runId`、`completionStatus`、goal/acceptance hash 与 checkpoint sequence 的 JSON；只有正式 TurnOutcome 为 completed、TaskGraph 与 Worker 均完成、Driver 独立验收以及 fast/full 项目门禁全部成功后才会写入 `DONE.flag`。

Provider fallback 会把每次尝试作为独立 attempt 返回并记录模型、Provider、结果、错误、延迟、usage 与估算成本。失败、partial、blocked、验证失败或合并冲突的子 Agent worktree 会保留给父 Agent 检查；只有 completed 且 verified 的产物允许自动合并和清理。每个 turn 只发送一次 `RUN_TERMINATED { status }` 终态事件。

### 配置文件

ovolv999 读取多级配置（优先级从高到低）：

1. **`.opencode/opencode.json`** — 项目级配置
2. **`~/.config/opencode/opencode.json`** — 用户级配置
3. **环境变量** — `OPENAI_API_KEY` / `OVOGO_MODEL` / `OPENAI_BASE_URL`

```jsonc
// .opencode/opencode.json 示例
{
  "model": "claude-sonnet-4-6-20250514",
  "effort": "high",
  "permissions": {
    "mode": "default",
    "allow": ["Read", "Glob", "Grep"],
    "deny": []
  },
  "mcp": {
    "servers": {
      "my-server": { "command": "npx", "args": ["my-mcp-server"] }
    }
  },
  "sandbox": { "level": "standard" },
  "telemetry": { "enabled": false }
}
```

## 项目结构

以下目录树由真实文件扫描生成（夜间审计 2026-08-28），与代码保持一致。
核心子系统的职责说明见「架构全景」一节。

```
ovolv999/
├── bin/
│   └── ovogogogo.ts
├── src/
│   ├── cli/
│   │   ├── acpServer.ts
│   │   └── engineAssembly.ts
│   ├── commands/
│   │   ├── builtin.ts
│   │   ├── cmd/
│   │   │   ├── common.ts
│   │   │   ├── group01.ts
│   │   │   ├── group02.ts
│   │   │   ├── group03.ts
│   │   │   ├── group04.ts
│   │   │   ├── group05.ts
│   │   │   ├── group06.ts
│   │   │   └── group07.ts
│   │   ├── doctor.ts
│   │   ├── index.ts
│   │   └── shared.ts
│   ├── config/
│   │   ├── diagnostics.ts
│   │   ├── ovogomd.ts
│   │   ├── projectConfig.ts
│   │   ├── projectContext.ts
│   │   ├── providerProbe.ts
│   │   ├── settings.ts
│   │   └── wizard.ts
│   ├── core/
│   │   ├── agentPresets.ts
│   │   ├── agentToolFilter.ts
│   │   ├── atomicTransaction.ts
│   │   ├── atomicWrite.ts
│   │   ├── backgroundSession.ts
│   │   ├── backgroundTaskManager.ts
│   │   ├── bashMutation.ts
│   │   ├── bookmarks.ts
│   │   ├── budget.ts
│   │   ├── builtinPlugins.ts
│   │   ├── claudeCodeWorkerManager.ts
│   │   ├── codeMetrics.ts
│   │   ├── codeReview.ts
│   │   ├── codeStructure.ts
│   │   ├── commandHistory.ts
│   │   ├── commandRunner.ts
│   │   ├── compact.ts
│   │   ├── context/
│   │   │   ├── contextManager.ts
│   │   │   └── toolResultBudget.ts
│   │   ├── conversationCheckpoints.ts
│   │   ├── costTracker.ts
│   │   ├── cron.ts
│   │   ├── customAgents.ts
│   │   ├── daemon.ts
│   │   ├── diagnostics.ts
│   │   ├── effort.ts
│   │   ├── engine.ts
│   │   ├── episodicMemory.ts
│   │   ├── eventLog.ts
│   │   ├── executionContext.ts
│   │   ├── executionRun.ts
│   │   ├── executionRunEvents.ts
│   │   ├── fileHistory.ts
│   │   ├── fileState.ts
│   │   ├── gitMutex.ts
│   │   ├── goals.ts
│   │   ├── hooks/
│   │   │   ├── defaultRunner.ts
│   │   │   ├── hookExecutor.ts
│   │   │   ├── hookProtocol.ts
│   │   │   └── hooksConfig.ts
│   │   ├── knowledgeBase.ts
│   │   ├── lazyTool.ts
│   │   ├── localSearch.ts
│   │   ├── longTermMemory.ts
│   │   ├── loopEngine.ts
│   │   ├── loopScaffold.ts
│   │   ├── loopSupervisor.ts
│   │   ├── lsp/
│   │   │   ├── client.ts
│   │   │   └── protocol.ts
│   │   ├── magicDocs.ts
│   │   ├── mcpClient.ts
│   │   ├── mcpHttpClient.ts
│   │   ├── memoryCandidate.ts
│   │   ├── messageBus.ts
│   │   ├── model/
│   │   │   ├── agentModelPolicy.ts
│   │   │   ├── anthropicAdapter.ts
│   │   │   ├── anthropicSse.ts
│   │   │   ├── modelGateway.ts
│   │   │   ├── modelRouter.ts
│   │   │   ├── modelRuntimeManager.ts
│   │   │   ├── modelTier.ts
│   │   │   ├── providerAdapter.ts
│   │   │   ├── providerRuntimeBinding.ts
│   │   │   ├── reasoningTransform.ts
│   │   │   ├── routingErrors.ts
│   │   │   ├── routingSignalCollector.ts
│   │   │   └── streamConsumer.ts
│   │   ├── modelCapabilities.ts
│   │   ├── modes.ts
│   │   ├── module.ts
│   │   ├── moduleRegistry.ts
│   │   ├── moduleRuntime/
│   │   │   └── moduleManager.ts
│   │   ├── onboarding.ts
│   │   ├── pathSecurity.ts
│   │   ├── permissionRules.ts
│   │   ├── permissionSystem.ts
│   │   ├── plugins.ts
│   │   ├── profiles.ts
│   │   ├── projectExplorer.ts
│   │   ├── projectIdentity.ts
│   │   ├── providers.ts
│   │   ├── queryStateMachine.ts
│   │   ├── repoStats.ts
│   │   ├── resourceScheduler.ts
│   │   ├── retryManager.ts
│   │   ├── revisionBinding.ts
│   │   ├── riskClassifier.ts
│   │   ├── runtime/
│   │   │   ├── boot.ts
│   │   │   ├── completionContract.ts
│   │   │   ├── coordinator.ts
│   │   │   ├── criticTrigger.ts
│   │   │   ├── deferredToolsReminder.ts
│   │   │   ├── events.ts
│   │   │   ├── evidence.ts
│   │   │   ├── internalControlMessage.ts
│   │   │   ├── prematureHandoff.ts
│   │   │   ├── progressMonitor.ts
│   │   │   ├── projectExploration.ts
│   │   │   ├── reviewer.ts
│   │   │   ├── runScopedContext.ts
│   │   │   ├── sharedState.ts
│   │   │   ├── taskGraph.ts
│   │   │   ├── taskGraphStore.ts
│   │   │   ├── taskIntent.ts
│   │   │   ├── terminationPolicy.ts
│   │   │   └── turnOutcome.ts
│   │   ├── sandbox.ts
│   │   ├── semanticMemory.ts
│   │   ├── sessionManager.ts
│   │   ├── sessionParts.ts
│   │   ├── sessionStats.ts
│   │   ├── sessionTitle.ts
│   │   ├── sessionTranscript.ts
│   │   ├── settingsSync.ts
│   │   ├── snippets.ts
│   │   ├── sshRemote.ts
│   │   ├── strings.ts
│   │   ├── structuredToolResult.ts
│   │   ├── suggestions.ts
│   │   ├── symbolIndex.ts
│   │   ├── taskImpact.ts
│   │   ├── taskTimer.ts
│   │   ├── teamMemory.ts
│   │   ├── telemetry.ts
│   │   ├── thinkingTagFilter.ts
│   │   ├── tmuxLayout.ts
│   │   ├── todoStore.ts
│   │   ├── toolRuntime/
│   │   │   ├── permissionModeGate.ts
│   │   │   ├── toolExecutor.ts
│   │   │   ├── toolPolicy.ts
│   │   │   ├── toolRegistry.ts
│   │   │   └── toolScheduler.ts
│   │   ├── toolSearch.ts
│   │   ├── types.ts
│   │   ├── workerAdapter.ts
│   │   ├── workflow.ts
│   │   ├── workingState.ts
│   │   ├── workspace.ts
│   │   └── workspaceWatcher.ts
│   ├── integrations/
│   │   ├── acp.ts
│   │   ├── acpTransport.ts
│   │   ├── acpWebSocket.ts
│   │   ├── mcpOAuth.ts
│   │   └── pipeMode.ts
│   ├── memory/
│   │   └── index.ts
│   ├── modules/
│   │   ├── critic.ts
│   │   ├── mcp.ts
│   │   ├── memory.ts
│   │   ├── plugins.ts
│   │   ├── workspace.ts
│   │   └── workspaceWatcher.ts
│   ├── prompts/
│   │   ├── critic.ts
│   │   ├── system.ts
│   │   └── tools.ts
│   ├── server/
│   │   └── httpServer.ts
│   ├── skills/
│   │   ├── extractor.ts
│   │   └── loader.ts
│   ├── tools/
│   │   ├── agent.ts
│   │   ├── applyPatch.ts
│   │   ├── askUser.ts
│   │   ├── bash.ts
│   │   ├── claudeCode.ts
│   │   ├── codeQuality.ts
│   │   ├── codeReview.ts
│   │   ├── codeStructure.ts
│   │   ├── diagnostics.ts
│   │   ├── enterPlanMode.ts
│   │   ├── exitPlanMode.ts
│   │   ├── fileEdit.ts
│   │   ├── fileRead.ts
│   │   ├── fileWrite.ts
│   │   ├── findTool.ts
│   │   ├── glob.ts
│   │   ├── goal.ts
│   │   ├── grep.ts
│   │   ├── index.ts
│   │   ├── loadSkill.ts
│   │   ├── lspTool.ts
│   │   ├── mcpResources.ts
│   │   ├── mcpToolAdapter.ts
│   │   ├── multiEdit.ts
│   │   ├── notebookEdit.ts
│   │   ├── projectExplorer.ts
│   │   ├── searchExtraTools.ts
│   │   ├── shellSession.ts
│   │   ├── sleep.ts
│   │   ├── snip.ts
│   │   ├── symbolIndex.ts
│   │   ├── taskGraphResolver.ts
│   │   ├── taskPlan.ts
│   │   ├── tasks.ts
│   │   ├── tmuxSession.ts
│   │   ├── todo.ts
│   │   ├── verifyPlanExecution.ts
│   │   ├── webFetch.ts
│   │   ├── webSearch.ts
│   │   └── worktree.ts
│   ├── ui/
│   │   ├── brand.ts
│   │   ├── diffBrowser.ts
│   │   ├── historyTrimmer.ts
│   │   ├── ink/
│   │   │   ├── App.tsx
│   │   │   ├── Banner.tsx
│   │   │   ├── Spinner.tsx
│   │   │   ├── ToolCallView.tsx
│   │   │   ├── components/
│   │   │   ├── expandAtMentions.ts
│   │   │   ├── fileSuggest.ts
│   │   │   ├── gitInfo.ts
│   │   │   ├── highlight.ts
│   │   │   ├── inkRenderer.ts
│   │   │   ├── modelBridge.ts
│   │   │   ├── pasteStore.ts
│   │   │   ├── runInkRepl.ts
│   │   │   └── store.ts
│   │   ├── input.ts
│   │   ├── keybindings.ts
│   │   ├── pipeRenderer.ts
│   │   ├── renderer.ts
│   │   ├── slashSuggest.ts
│   │   ├── theme.ts
│   │   ├── turnDeadline.ts
│   │   └── turnOutcomeCard.ts
│   └── utils/
│       ├── apiError.ts
│       ├── autoUpdater.ts
│       ├── cacheStats.ts
│       ├── cleanup.ts
│       ├── clipboard.ts
│       ├── editor.ts
│       ├── gitignore.ts
│       ├── globMatch.ts
│       ├── ide.ts
│       ├── inputHistory.ts
│       ├── jsonc.ts
│       ├── keychain.ts
│       ├── notifier.ts
│       ├── rateLimit.ts
│       ├── secretScanner.ts
│       ├── sessionExport.ts
│       ├── systemHealth.ts
│       ├── terminalTitle.ts
│       ├── tty.ts
│       └── warnOnce.ts
├── package.json
└── tsconfig.json
```
## AgentOS 概念对照

| AgentOS 概念 | ovolv999 实现 |
|---|---|
| 统一 Harness（无 agent_type） | `ExecutionEngine` + `AgentConfig` + 4 preset |
| 模块组合驱动 | `ModuleRegistry` + memory/critic/workspace (production) |
| Boot Sequence | 7 步：identity → modules → boot → prompt → tools → context → trajectory |
| 来源归因 + 冲突解决 | `user_stated` 必须带 `source_quote` 证明(长度 ≥ 12 + content-token 覆盖 ≥ 60%) |
| Memory 三原语 | `memory_write` / `memory_search` / `memory_recall` |
| 长时记忆唯一入口 | Candidate → Promotion (CompletionContract + Reviewer + Verification) |
| Memory 冲突 resolution | contentKey = sha256(repo + branch + baseCommit + dirty + diffHash + workspaceHash + kind + content) |
| Boot 时相关性检索 | `extractKeywords` + `scoreRelevance` → top-10, repo-filtered |
| Skill 系统 | frontmatter 解析 + 懒加载 + 语义搜索 + auto-suggest |
| 验证闸门 (No Tuple No Merge) | `verify:true` → 自动 package scripts / 语言检查 |
| Probe lease | per-profile `tryAcquireProbe` / `finishProbe` 接 Coordinator (finally 释放) |
| 调用链追踪 + 循环检测 | `_callDepth` max 5 + EventLog |
| 生命周期 Hooks | 6 种 Hook 类型 |
| Context 压缩 + 策略 | microCompact + snipCompact + autoCompact（含系统提示词 token） |
| Tool metadata | `readOnly` / `concurrencySafe` / `mutatesState` / `longRunning` / `requiresNetwork` |
| 权限系统 | `PermissionManager` + glob 规则 + `/permissions` 持久化 |
| 沙箱执行 | 3 级策略：permissive / standard / strict (macOS sandbox-exec + Linux bwrap) |
| 后台任务 | `TaskCreate/Get/List/Update/Stop` + Bash background |
| 后台会话 | `--bg` + `ps/attach/logs/stop/rm/clean` CLI |
| MCP 客户端 | stdio + HTTP + OAuth2 PKCE + Resources |
| 进程内 LSP | tsserver/pylsp/rust-analyzer/gopls JSON-RPC 2.0 |
| SSH 远程 | SshProfile + rsync 同步 + remote agent |
| API 重试 | SDK maxRetries=5 指数退避 + 120s timeout |
| 模块化插件 | Plugin 接口 + `/plugins` 动态加载 |

## 技术栈

| 组件 | 技术 |
|------|------|
| 语言 | TypeScript 5.7 (ESM, strict) |
| 运行时 | Node.js ≥ 20 |
| LLM API | OpenAI SDK (兼容 Claude/GPT/本地端点) |
| 终端 UI | Ink + React（默认）/ readline REPL（`--classic` 回退） |
| 测试 | Vitest |
| Lint | ESLint (typescript-eslint recommendedTypeChecked) |
| 运行时依赖 | openai · glob · zod · ink · react · @anthropic-ai/sdk · chokidar · vscode-jsonrpc |

## 构建

```bash
pnpm build              # tsc → dist/
pnpm typecheck          # tsc --noEmit
pnpm lint               # eslint
pnpm test               # vitest run
pnpm test:watch         # vitest watch
pnpm eval:wiring        # wiring-smoke source-of-truth checks
pnpm eval:deterministic # deterministic runtime contract cases
pnpm eval:real          # opt-in real-LLM evals (not in CI by default)
pnpm check              # typecheck + lint + unit + integration + eval:deterministic
```

原生 OpenAI Responses 传输可通过 `OVOGO_OPENAI_API_MODE=responses` 启用。真实模型评测要求同时设置 `OVOGO_REAL_EVAL=1`、`OPENAI_API_KEY` 和 `OVOGO_REAL_EVAL_MODEL`，未配置时 `pnpm eval:real` 会明确失败，不会产生空测试假绿。

## 许可

MIT License
