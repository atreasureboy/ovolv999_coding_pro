# ovolv999 — 可观测、可控制、可恢复、可验证的多模型 Coding Agent Runtime

<div align="center">

**统一 Harness · 执行 Run 状态机 · 结构化事件持久化 · 资源调度 · Worker Steering · 三层记忆 · 故障恢复**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js)](https://nodejs.org/)

> `ovolv999 "任何你需要它完成的任务"`

</div>

## 简介

ovolv999 是一个**多模型 Coding Agent Runtime**。所有 Agent 行为都走同一套可观测的执行 Run 状态机，状态变更通过结构化事件持久化，工具并发由资源冲突调度，子任务通过 Worker Steering 实时干预，故障后可从 JSONL 日志恢复。

> 项目定位：**可观测、可控制、可恢复、可验证的多模型 Coding Agent Runtime**（见 `fi_goal.md` §十四）

### Runtime 能力矩阵（fi_goal §十四 验收对照）

| § | 验收要点 | 实现位置 | 测试 |
|---|---------|---------|------|
| 1 | 所有执行行为都有统一 Run ID | `src/core/executionRun.ts` + `coordinator.ts:run()` 每轮 mint `kind='turn'` | `tests/gapCCoordinatorRunWiring.test.ts` |
| 2 | 所有子任务都有父子关系 | `AgentTool` / `ClaudeCodeTool` / `BackgroundTaskManager` 创建子 run 时携带 `parentRunId` | `tests/agentExecutionRun.test.ts` |
| 3 | 所有状态变化都有结构化事件 | `ExecutionRunEventBus` 持久化优先 + 关键/尽力两类订阅者 | `tests/executionRunEvents.test.ts` |
| 4 | 修改型 Agent 自动使用独立 worktree | `AgentTool` 检测 `modifies_state=true` → worktree + 自动合并 | `tests/agentWorktreeIsolation.test.ts` |
| 5 | 子 Agent 可以查询、steer、cancel 和 collect | `WorkerAdapter.steer(runId, instruction)`（ClaudeCodeTool + AgentTool） | `tests/gapKWorkerSteer.test.ts` |
| 6 | 任务完成必须通过 Verification Gate | `AgentTool` verify flag → `verifyPlanExecution` 工具 | `tests/agentFalseSuccess.test.ts` |
| 7 | 验证失败绝不标记成功 | `StructuredToolResult.status='failed'` → `isError=true`（Bash 非零 exit 同样） | `tests/structuredToolResult.test.ts` |
| 8 | Worker 崩溃或主进程重启后可恢复状态 | `JsonlEventStore` + `recoverRegistryFromStore` + 引擎启动时标记 in-flight → failed | `tests/gapGEngineRecovery.test.ts` |
| 9 | 工具并发由资源冲突决定 | `ResourceScheduler`（R/W/X 矩阵）+ 工具 `metadata.claims` 声明 | `tests/gapDToolClaims.test.ts`, `tests/resourceScheduler.test.ts` |
| 10 | 上下文压缩不丢失关键工作状态 | `WorkingState` + INV-1..INV-5 不变量 + `maybeCompactWithInvariants` | `tests/workingState.test.ts` |
| 11 | 长期记忆绑定来源和 commit | `LongTermMemory` R1-R6 闸门（验证 / 来源标记 / commit 绑定 / 过期 / 冲突合并） | `tests/longTermMemory.test.ts` |
| 12 | Provider 差异不泄漏到主 Runtime | `ModelCapabilities` + `ProviderAdapter` 注册表 + `toProviderRequest` / `fromProviderStreamChunk` | `tests/modelCapabilities.test.ts` |
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
- **模块化能力** — memory / critic / workspace / reflection 四个可组合模块
- **配置驱动角色** — 探索者、规划者、审查者 = 不同 AgentConfig 配置实例，零代码新增角色
- **三层记忆系统** — Semantic（语义知识）+ Episodic（过程轨迹）+ KnowledgeBase（结构化知识库）
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
- **Auto-Dream** — 空闲时后台知识整理与经验巩固
- **MagicDocs** — 自动从代码提取项目文档（7 种提取器：overview/api/models/config/decisions/patterns/dependencies）
- **遥测** — opt-in 本地分析，14 种事件类型，聚合统计
- **设置同步** — AES-256-GCM 加密，git/file 传输，跨机器配置同步
- **系统健康检查** — 13 项环境检测（Node/API/磁盘/Git/权限等）
- **自动更新** — semver 比较，npm dist-tag 检查，ignore-list
- **缓存统计** — prompt-cache hit/miss 追踪，per-model 分解，成本节约
- **IDE 检测** — 9 种编辑器检测（VSCode/IntelliJ/Vim/Emacs/...），路径转换，扩展推荐
- **生命周期 Hooks** — 6 种：PreToolCall / PostToolCall / OnError / OnComplete / OnContextOverflow / UserPromptSubmit
- **Skill 系统** — frontmatter 解析 + 懒加载 + 语义搜索 + auto-suggestion
- **Plugin 系统** — 动态加载 npm 包/本地路径插件
- **Permission 系统** — allow/deny 规则 + glob 匹配 + 持久化
- **命令历史 + 书签** — 跨 session 命令历史 + 位置书签
- **文件历史 / Rewind** — 每次编辑快照，可回滚
- **ACP 协议** — Agent Communication Protocol server
- **Vim 模式** — normal/insert/visual 模式，keybinding 可定制
- **Ink/React UI** — 可选的 `--ink` 富终端 UI
- **零领域绑定** — 核心是 Agent 基础设施，业务逻辑通过 Module + Tool 插件注入

## 架构全景

```
╔═══════════════════════════════════════════════════════════════════════════╗
║                   ovolv999 — 统一 Harness + 模块化 Agent 基座               ║
║              多模型 Worker · 结构化 Run 状态机 · 资源调度 · 验证闸门 · 恢复  ║
║              Runtime: openai · glob · zod · ink · react                     ║
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
║  │  │ moduleManager.runComplete() ← ReflectionModule LLM 知识提取    │  │   ║
║  │  │ RunEventEmitter.emit(RUN_COMPLETED / RUN_FAILED)              │  │   ║
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
║  │ reflection     │  │ Plan/Sleep/Snip      │  └──────────────────────┘  ║
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
    reflection: { enabled: true },  // Run 结束后知识提取 → SemanticMemory
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
| `reflection` | — | onComplete LLM 知识提取 | — |

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
| **系统** | `/init` `/version` `/copy` `/help` `/history` `/keybindings` `/workflow` `/onboard` `/daemon` `/schedule` `/timer` `/profile` `/notify` `/share` |

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

```bash
git clone https://github.com/atreasureboy/ovolv999_coding_pro.git
cd ovolv999_coding
pnpm install
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
npm run build
npm link
ovolv999 "任务描述"
```

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

```
ovolv999/
├── bin/
│   └── ovogogogo.ts                # CLI 入口 + REPL + session subcommands + --bg
├── src/
│   ├── core/                        # 引擎核心
│   │   ├── engine.ts                # 薄门面 — 组装子系统 + 委托 coordinator
│   │   ├── types.ts                 # EngineConfig / Tool metadata / ToolContext
│   │   ├── module.ts                # AgentModule 接口 (4 生命周期钩子)
│   │   ├── moduleRegistry.ts        # 工厂注册 + 依赖解析 + 环检测
│   │   ├── agentPresets.ts          # 4 preset + resolveAgentConfig
│   │   ├── agentToolFilter.ts       # Agent 工具白名单过滤
│   │   ├── compact.ts               # microCompact + strategy + tool_call 对保护
│   │   ├── snipCompact.ts           # 手术式裁剪 (head/tail 截断)
│   │   ├── semanticMemory.ts        # 语义记忆 + 来源优先级 + hash 去重
│   │   ├── episodicMemory.ts        # 过程记忆 (成功+失败轨迹)
│   │   ├── knowledgeBase.ts         # 结构化知识库
│   │   ├── permissionSystem.ts      # 权限模式 + allow/deny 规则
│   │   ├── permissionRules.ts       # glob 规则匹配
│   │   ├── pathSecurity.ts          # 路径安全检查
│   │   ├── sandbox.ts               # 3 级沙箱 (macOS/Linux)
│   │   ├── lspClient.ts             # 进程内 LSP 客户端
│   │   ├── sshRemote.ts             # SSH 远程会话
│   │   ├── backgroundSession.ts     # detached 会话管理
│   │   ├── backgroundTaskManager.ts # 后台任务生命周期
│   │   ├── oauth.ts                 # MCP OAuth2 PKCE
│   │   ├── mcpClient.ts             # MCP 客户端 (stdio + HTTP)
│   │   ├── magicDocs.ts             # 自动文档提取 (7 种提取器)
│   │   ├── telemetry.ts             # opt-in 本地遥测
│   │   ├── settingsSync.ts          # 加密设置同步
│   │   ├── autoClassifier.ts        # 请求自动分类
│   │   ├── autoDream.ts             # 空闲知识整理
│   │   ├── effort.ts                # effort 分级系统
│   │   ├── budget.ts                # token 预算控制
│   │   ├── modes.ts                 # 模式系统
│   │   ├── outputStyles.ts          # 输出风格
│   │   ├── hooks.ts                 # 6 种 Hook + HookRunner
│   │   ├── goals.ts                 # 目标管理
│   │   ├── diagnostics.ts           # LSP 诊断集成
│   │   ├── sessionManager.ts        # 会话管理
│   │   ├── sessionTranscript.ts     # 会话转录
│   │   ├── sessionStats.ts          # 会话统计
│   │   ├── profiles.ts              # 配置 profile
│   │   ├── snippets.ts              # 代码片段管理
│   │   ├── bookmarks.ts             # 位置书签
│   │   ├── commandHistory.ts        # 命令历史
│   │   ├── fileHistory.ts           # 文件编辑历史 / rewind
│   │   ├── fileDetection.ts         # 文件类型检测
│   │   ├── fileState.ts             # 文件状态追踪
│   │   ├── atomicWrite.ts           # 原子写入
│   │   ├── costTracker.ts           # token/cost 统计
│   │   ├── eventLog.ts              # 不可变审计流
│   │   ├── messageBus.ts            # 内部消息总线
│   │   ├── pluginManager.ts         # 插件管理
│   │   ├── plugins.ts               # 插件接口
│   │   ├── builtinPlugins.ts        # 内置插件
│   │   ├── daemon.ts                # 后台守护进程
│   │   ├── cron.ts                  # 定时任务
│   │   ├── workflow.ts              # 工作流
│   │   ├── loopEngine.ts            # 循环引擎
│   │   ├── teamMemory.ts            # 团队记忆共享
│   │   ├── skillSearch.ts           # 技能语义搜索
│   │   ├── riskClassifier.ts        # 风险分类
│   │   ├── thinkingTagFilter.ts     # thinking 标签过滤
│   │   ├── promptSuggestions.ts     # 提示建议
│   │   ├── suggestions.ts           # 自动建议
│   │   ├── onboarding.ts            # 首次引导
│   │   ├── migrations.ts            # 配置迁移
│   │   ├── systemPrompt.ts          # 系统提示词组装
│   │   ├── config.ts                # 配置管理
│   │   ├── providers.ts             # LLM provider 管理
│   │   ├── codeMetrics.ts           # 代码度量
│   │   ├── claudeCodeWorkerManager.ts # tmux Claude Code worker 管理
│   │   ├── queryStateMachine.ts     # 查询状态机 (loop reducer)
│   │   ├── runtime/                 # 运行时协调层
│   │   │   ├── coordinator.ts       # RuntimeCoordinator (主循环驱动)
│   │   │   ├── boot.ts              # 启动序列 (模块 boot + 工具注册 + prompt 构建)
│   │   │   ├── events.ts            # RunEvent 类型化协议 + RunEventEmitter
│   │   │   ├── sharedState.ts       # SharedRuntimeState (跨 turn 状态 + 活跃追踪)
│   │   │   └── terminationPolicy.ts # 终止决策 (纯函数)
│   │   ├── model/                   # 模型调用层
│   │   │   ├── modelGateway.ts      # LLM API 调用 + stream_options 兼容
│   │   │   └── streamConsumer.ts    # 流解析 + thinking + tool_call 累积
│   │   ├── context/                 # 上下文管理层
│   │   │   ├── contextManager.ts    # budget 评估 + compaction + snip
│   │   │   └── toolResultBudget.ts  # truncate + aggregate budget
│   │   ├── toolRuntime/             # 工具运行时层
│   │   │   ├── toolRegistry.ts      # 工具注册 + 查找 + 重名检测
│   │   │   ├── toolPolicy.ts        # 统一 exposure + execution policy
│   │   │   ├── toolExecutor.ts      # 单次 tool 执行 (hooks + 截断 + notify)
│   │   │   └── toolScheduler.ts     # partitionToolCalls + batch 调度
│   │   ├── moduleRuntime/           # 模块运行时层
│   │   │   └── moduleManager.ts     # 模块生命周期 (boot/iter/complete/dispose)
│   │   ├── taskTimer.ts             # 任务计时
│   │   ├── workspace.ts             # 工作区管理
│   │   └── strings.ts               # str() 安全转换 helper
│   ├── tools/                       # 工具层
│   │   ├── bash.ts                  # 跨平台 shell + 后台任务
│   │   ├── fileRead.ts / fileWrite.ts / fileEdit.ts
│   │   ├── glob.ts / grep.ts
│   │   ├── todo.ts / notebookEdit.ts
│   │   ├── webFetch.ts / webSearch.ts
│   │   ├── agent.ts                 # AgentConfig 驱动 + 验证闸门
│   │   ├── claudeCode.ts            # 外部 Claude Code worker
│   │   ├── enterPlanMode.ts / exitPlanMode.ts / verifyPlanExecution.ts
│   │   ├── tasks.ts                 # TaskCreate/Get/List/Update/Stop (5 工具)
│   │   ├── worktree.ts              # Git worktree (3 工具)
│   │   ├── mcpResources.ts          # MCP 资源 (2 工具)
│   │   ├── sleep.ts / snip.ts
│   │   ├── diagnostics.ts / goal.ts / askUser.ts
│   │   ├── loadSkill.ts / shellSession.ts / tmuxSession.ts
│   │   ├── mcpToolAdapter.ts
│   │   └── index.ts                 # 工具注册
│   ├── commands/                    # 斜杠命令
│   │   ├── builtin.ts               # 全部命令注册
│   │   ├── index.ts / mod.ts
│   ├── modules/                     # 内置能力模块
│   │   ├── memory.ts                # 相关性检索 + 3 memory tools + episodic
│   │   ├── critic.ts                # 每 N 轮 LLM 纠错
│   │   ├── workspace.ts             # sessionDir 注入
│   │   └── reflection.ts            # 知识提取 + session 整合
│   ├── prompts/                     # 提示词
│   │   ├── system.ts / tools.ts / critic.ts
│   ├── ui/                          # 终端 UI (15 文件)
│   │   ├── renderer.ts              # 流式输出 + 工具卡片 + spinner
│   │   ├── input.ts                 # readline + stdin pipe
│   │   ├── vim.ts                   # vim 模式 (normal/insert/visual)
│   │   ├── keybindings.ts           # 可定制键绑定
│   │   ├── theme.ts / markdown.ts / ansi.ts
│   │   ├── statusLine.ts / statusLineCustom.ts
│   │   ├── tmuxLayout.ts            # tmux 窗口管理
│   │   ├── slashSuggest.ts / thinkingDisplay.ts
│   │   ├── diffBrowser.ts / historyTrimmer.ts
│   │   └── turnDeadline.ts
│   ├── skills/                      # 技能系统
│   │   ├── loader.ts                # frontmatter 解析 + formatSkillIndex
│   │   └── extractor.ts             # 技能提取
│   ├── utils/                       # 工具函数 (19 文件)
│   │   ├── ide.ts                   # IDE 检测 (9 种编辑器)
│   │   ├── autoUpdater.ts           # 自动更新检查
│   │   ├── cacheStats.ts            # prompt cache 统计
│   │   ├── systemHealth.ts          # 13 项系统健康检查
│   │   ├── apiError.ts / cleanup.ts / clipboard.ts
│   │   ├── doctor.ts / editor.ts / globMatch.ts
│   │   ├── imageInput.ts / inputHistory.ts
│   │   ├── keychain.ts / notifier.ts
│   │   ├── secretScanner.ts / sessionExport.ts
│   │   ├── terminalTitle.ts / vcr.ts
│   │   └── ansi.ts
│   └── integrations/                # 外部协议集成
│       ├── acp.ts                   # Agent Communication Protocol server
│       └── pipeMode.ts              # 管道模式
├── tests/                           # vitest test suite
└── package.json                     # runtime: openai/glob/zod/ink/react
```

## AgentOS 概念对照

| AgentOS 概念 | ovolv999 实现 |
|---|---|
| 统一 Harness（无 agent_type） | `ExecutionEngine` + `AgentConfig` + 4 preset |
| 模块组合驱动 | `ModuleRegistry` + memory/critic/workspace/reflection |
| Boot Sequence | 7 步：identity → modules → boot → prompt → tools → context → trajectory |
| 来源归因 + 冲突解决 | `user_stated(3) > agent_inferred(2) > tool_observed(1)` |
| Memory 三原语 | `memory_write` / `memory_search` / `memory_recall` |
| 三层记忆 | Semantic + Episodic + KnowledgeBase |
| Boot 时相关性检索 | `extractKeywords` + `scoreRelevance` → top-10 |
| Memory 整合 | `consolidateSession` — REPL 退出时 LLM 总结 |
| Skill 系统 | frontmatter 解析 + 懒加载 + 语义搜索 + auto-suggest |
| 验证闸门 (No Tuple No Merge) | `verify:true` → 自动 package scripts / 语言检查 |
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
| 终端 UI | Ink + React（可选 `--ink`）/ readline REPL（默认） |
| 测试 | Vitest |
| Lint | ESLint (typescript-eslint recommendedTypeChecked) |
| 运行时依赖 | openai · glob · zod · ink · react |

## 构建

```bash
npm run build          # tsc → dist/
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run test           # vitest run
npm run test:watch     # vitest watch
```

## 许可

MIT License
