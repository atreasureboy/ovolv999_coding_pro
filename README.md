# ovolv999 — Agent 基座

<div align="center">

**统一 Harness · 模块化能力 · 流式引擎 · 并发调度 · 配置驱动角色**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/Tests-337%20passed-brightgreen)]()

> `ovolv999 "任何你需要它完成的任务"`

</div>

## 简介

ovolv999 是一个**纯 Agent 基座框架**，仿 Claude Code，核心设计参考 AgentOS 架构。

**所有 Agent 共享同一套运行时（Harness），通过启用/禁用模块获得差异化能力。** 不存在 `agent_type` 枚举——角色是 `AgentConfig`（identity + modules + tools）的组合配置。

- **统一 Harness** — 所有 Agent 走同一套 Boot Sequence，按模块配置差异化执行
- **模块化能力** — memory / critic / workspace / reflection 四个可组合模块
- **配置驱动角色** — 探索者、规划者、审查者 = 不同 AgentConfig 配置实例，零代码新增角色
- **Memory 三原语** — `memory_write` / `memory_search` / `memory_recall`，Agent 主动操作长时记忆
- **来源归因 + 冲突解决** — `user_stated > agent_inferred > tool_observed` 优先级链
- **验证闸门** — 子 agent 完成代码修改后自动按项目 scripts / 语言工具验证（No Tuple, No Merge）
- **Session 整合** — REPL 退出时自动总结 episodic 经验写入 SemanticMemory（关闭学习闭环）
- **调用链追踪** — 子 agent spawn 深度追踪（max 5），防递归 + 审计
- **Skill 懒加载** — Boot 时注入技能索引，LLM 按需通过 `load_skill` 加载
- **外部 Worker** — `ClaudeCode` 工具和 `/workers` 命令通过 tmux 指挥本机 Claude Code CLI 执行窄任务
- **生命周期 Hooks** — 6 种：PreToolCall / PostToolCall / OnError / OnComplete / OnContextOverflow / UserPromptSubmit
- **工具元信息** — Tool 自声明 readOnly / concurrencySafe / mutatesState / longRunning / requiresNetwork，运行时据此过滤与调度
- **统一权限管理** — PermissionManager 接入 Engine 执行路径，`/permissions` 可查看、切换模式、添加 allow/deny 规则并持久化到 `.ovogo/settings.json`
- **并发调度** — 只读/安全工具并行 (Promise.all)，状态工具串行，支持 per-input `isConcurrencySafe`
- **后台任务生命周期** — Bash 后台任务统一进入 TaskCreate/TaskGet/TaskList/TaskStop 管理
- **流式引擎** — Streaming LLM API，tool_call 解析 → 分区调度 → 结果注入 → 循环
- **上下文预算** — 统一百分比阈值 (70% warn / 85% compact)，**含系统提示词 token**，tool_call 对保护
- **API 重试** — SDK 指数退避 5 次重试 (429/5xx/ECONNRESET)，120s 超时
- **零领域绑定** — 核心是 Agent 基础设施，业务逻辑通过 Module + Tool 插件注入

## 架构全景

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                        ovolv999 — 统一 Harness + 模块化 Agent 基座             ║
║               build OK · eslint OK · 20 test files · 337 tests passed        ║
║               Runtime deps: openai · glob · zod (仅 3 个)                     ║
║               API retry: 5x exponential backoff · 120s timeout                ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║  ┌─ AgentConfig ─────────────────────────────────────────────────────────┐   ║
║  │  identity(SOUL) + modules[] + tools[] + skills[] + limits             │   ║
║  │  ↓ preset (explore/plan/code-reviewer/general-purpose) 或 custom      │   ║
║  └───────────────────────────────────────────────────────────────────────┘   ║
║                                  │                                           ║
║  ┌───────────────────────────────▼───────────────────────────────────────┐   ║
║  │                    ExecutionEngine (统一 Harness)                       │   ║
║  │                                                                        │   ║
║  │  ┌─ Boot Sequence (7 steps) ───────────────────────────────────────┐  │   ║
║  │  │ 1. applyAgentToConfig  →  合并 agent 配置                         │  │   ║
║  │  │ 2. deriveEnabledModules → 自动推导或显式指定                      │  │   ║
║  │  │ 3. modules.boot()      → 并行启动，收集 prompt/tools/context      │  │   ║
║  │  │ 4. buildSystemPrompt   → 组装 identity + module sections          │  │   ║
║  │  │ 5. getToolDefinitions  → 白名单 + planMode 双重过滤               │  │   ║
║  │  │ 6. buildToolContext    → 基础 + module patches + toolNames        │  │   ║
║  │  │ 7. boot_context 轨迹   → EventLog 记录启动摘要                    │  │   ║
║  │  └──────────────────────────────────────────────────────────────────┘  │   ║
║  │                                                                        │   ║
║  │  ┌─ Engine Loop ────────────────────────────────────────────────────┐  │   ║
║  │  │  modules.onIteration()  ← CriticModule 每 N 轮纠错                │  │   ║
║  │  │  evaluateContextBudget() ← 统一百分比阈值 (70%/85%)               │  │   ║
║  │  │  callLLM() → streaming → consumeStream()                          │  │   ║
║  │  │  partitionToolCalls() → parallel(safe) / serial(stateful)         │  │   ║
║  │  │  executeToolCall() → 白名单硬执行 + planMode 硬执行                │  │   ║
║  │  │  modules.onToolCall()  ← MemoryModule 写 episodic (成功+失败)     │  │   ║
║  │  │  hooks: PreToolCall / PostToolCall                                │  │   ║
║  │  └──────────────────────────────────────────────────────────────────┘  │   ║
║  │                                                                        │   ║
║  │  ┌─ Post-Run ───────────────────────────────────────────────────────┐  │   ║
║  │  │  modules.onComplete()  ← ReflectionModule LLM 知识提取            │  │   ║
║  │  │  hooks: OnComplete / OnError / OnContextOverflow                  │  │   ║
║  │  └──────────────────────────────────────────────────────────────────┘  │   ║
║  │                                                                        │   ║
║  │  Abort: softAbort(ESC) / hardAbort(Ctrl+C)                            │   ║
║  └────────────────────────────────────────────────────────────────────────┘   ║
║                                                                              ║
║  ┌─ Modules (4) ──────┐  ┌─ Tools (26) ────────┐  ┌─ Memory ───────────┐    ║
║  │ memory             │  │ Bash / file tools     │  │ Semantic:          │    ║
║  │  ├ boot: 相关性检索│  │ Web / Agent / Skill   │  │  关键词去重 +       │    ║
║  │  ├ tools: write/   │  │ Task lifecycle tools  │  │  来源优先级冲突解决  │    ║
║  │  │   search/recall │  │ AskUser / Plan / Sleep│  │ Episodic:          │    ║
║  │  └ onToolCall:     │  │ Notebook/Tmux/Claude │  │  成功+失败工具轨迹  │    ║
║  │     episodic 写入  │  │ 3 Memory tools        │  │ Boot: 相关性 top-10│    ║
║  │ critic             │  │ metadata-driven       │  │ Exit: session 整合  │    ║
║  │  └ onIteration:    │  │ scheduling/filtering  │  └────────────────────┘    ║
║  │     每 N 轮纠错    │  │                       │                             ║
║  │ workspace          │  └──────────────────────┘  ┌─ Communication ─────┐   ║
║  │  └ boot: sessionDir│                              │ Agent (invoke):     │   ║
║  │ reflection         │  ┌─ Verification Gate ───┐   │  AgentConfig 驱动   │   ║
║  │  ├ dep: memory     │  │ verify:true           │   │  callDepth max 5   │   ║
║  │  └ onComplete:     │  │  → scripts/语言检查    │   │  verify 闸门       │   ║
║  │     LLM 知识提取   │  │  → 结果附带验证状态    │   │  EventLog 审计     │   ║
║  └────────────────────┘  └───────────────────────┘  └─────────────────────┘   ║
║                                                                              ║
║  输出: sessions/session_TIMESTAMP/ → 会话产物、EventLog、agent-logs          ║
╚══════════════════════════════════════════════════════════════════════════════╝
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

### Memory System — 来源归因 + 冲突解决 + 整合闭环

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
// 主 agent 派子 agent 实现代码后自动验证
Agent({
  description: "实现登录功能",
  prompt: "...",
  subagent_type: "general-purpose",
  verify: true   // ← 完成后自动跑 package scripts 或语言检查
})
// 结果包含:
// [验证闸门] ✓ build/lint/test — passed
// 或
// [验证闸门] ✗ lint — FAILED + 错误详情
```

验证命令优先读取 `package.json` scripts：`typecheck` 或 `build`、`lint`、`test`。没有 scripts 时按项目类型回退到 `npx tsc --noEmit`、`go vet ./...`、`cargo check` 或 `python -m compileall -q .`。

### Agent Communication — 调用链追踪

```
主 agent (depth=0)
  └─ spawn general-purpose (depth=1)
       └─ EventLog: invoke_sent {call_depth: 1}
       └─ 子 agent 执行...
       └─ EventLog: invoke_completed {call_depth: 1, duration_ms, output_preview}

调用深度 max 5 → 超限拒绝 (防递归)
```

## 并发分区调度

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

在 `.ovogo/skills/` 下创建 Markdown 文件:

```markdown
---
name: deploy
description: 部署到生产环境
tools: Bash, Read
---
检查 staging 环境，确认测试通过后部署到生产...
```

LLM 可通过 `load_skill("deploy")` 按需加载。

## 快速开始

### 安装

```bash
git clone https://github.com/atreasureboy/ovolv999_coding.git
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
```

## 项目结构

```
ovolv999/
├── bin/
│   └── ovogogogo.ts           # CLI + REPL + 模块注册 + session 整合
├── src/
│   ├── core/                           # 引擎核心
│   │   ├── engine.ts                   # 统一 Harness — Boot Sequence + Module 集成
│   │   ├── types.ts                    # EngineConfig / Tool metadata / IHookRunner
│   │   ├── module.ts                   # AgentModule 接口 (4 生命周期钩子)
│   │   ├── moduleRegistry.ts           # 工厂注册 + 依赖解析 + 环检测
│   │   ├── agentPresets.ts             # 4 preset + resolveAgentConfig + applyAgentToConfig
│   │   ├── compact.ts                  # 上下文压缩 + strategy + tool_call 对保护
│   │   ├── semanticMemory.ts           # 语义记忆 + 来源优先级 + hash 去重
│   │   ├── episodicMemory.ts           # 过程记忆 (成功+失败轨迹)
│   │   ├── permissionSystem.ts         # 权限模式 + allow/deny 规则
│   │   ├── claudeCodeWorkerManager.ts  # tmux 外部 Claude Code worker 管理
│   │   ├── backgroundTaskManager.ts    # 后台任务生命周期
│   │   ├── fileHistory.ts              # 文件编辑历史 / rewind
│   │   ├── queryStateMachine.ts        # 显式查询状态机
│   │   ├── costTracker.ts              # token/cost 统计
│   │   ├── eventLog.ts                 # 不可变审计流
│   │   └── strings.ts                  # str() 安全转换 helper
│   ├── modules/                        # 内置能力模块
│   │   ├── memory.ts                   # 相关性检索 + 3 memory tools + episodic 写入
│   │   ├── critic.ts                   # 每 N 轮 LLM 纠错
│   │   ├── workspace.ts                # sessionDir 注入
│   │   └── reflection.ts               # per-turn 知识提取 + session-level 整合
│   ├── tools/                          # 工具层
│   │   ├── agent.ts                    # AgentConfig 驱动 + 验证闸门 + 调用链追踪
│   │   ├── claudeCode.ts               # 外部 Claude Code worker 工具
│   │   ├── loadSkill.ts                # 技能懒加载 + 权限检查
│   │   ├── bash.ts                     # 跨平台 shell + 后台任务接入
│   │   ├── tasks.ts                    # TaskCreate/Get/List/Update/Stop
│   │   └── ...                         # Read/Write/Edit/Glob/Grep/Todo/Web/Session/Notebook
│   ├── prompts/                        # 提示词 (3 files)
│   │   ├── system.ts                   # 系统提示词组装 + skill 索引注入
│   │   ├── tools.ts                    # 工具描述常量
│   │   └── critic.ts                   # Critic 纠错提示词
│   ├── config/                         # 配置 (3 files)
│   │   ├── hooks.ts                    # 6 种 Hook + HookRunner + NoopHookRunner
│   │   ├── settings.ts                 # JSON 解析 + TaskContext + 权限持久化
│   │   └── ovogomd.ts                  # OVOGO.md 多级加载
│   ├── ui/                             # 终端 UI (3 files)
│   │   ├── renderer.ts                 # 流式输出 + 工具卡片 + spinner
│   │   ├── input.ts                    # readline + stdin pipe
│   │   └── tmuxLayout.ts               # 子 agent tmux 窗口管理
│   ├── skills/                         # 技能系统
│   │   └── loader.ts                   # frontmatter 解析 + formatSkillIndex
│   └── memory/                         # 记忆桥接
│       └── index.ts                    # SemanticMemory → 系统提示词注入
├── tests/                              # 20 test files · 337 tests
│   ├── engine.test.ts                  # partitionToolCalls + compact + critic
│   ├── presets.test.ts                 # AgentConfig + preset 解析 + applyAgent
│   ├── modules.test.ts                 # SemanticMemory + EpisodicMemory + ModuleRegistry
│   ├── permissionSystem.test.ts        # 权限模式 + 规则匹配
│   ├── backgroundTaskManager.test.ts   # 后台任务生命周期
│   └── ...                             # modes / cost / fileHistory / query state / tools
└── package.json                        # 3 runtime deps: openai / glob / zod
```

## AgentOS 概念对照

| AgentOS 概念 | ovolv999 实现 |
|---|---|
| 统一 Harness（无 agent_type） | `ExecutionEngine` + `AgentConfig` + 4 preset |
| 模块组合驱动 | `ModuleRegistry` + memory/critic/workspace/reflection |
| Boot Sequence | 7 步：identity → modules → boot → prompt → tools → context → trajectory |
| 来源归因 + 冲突解决 | `user_stated(3) > agent_inferred(2) > tool_observed(1)` |
| Memory Tool 三原语 | `memory_write` / `memory_search` / `memory_recall` |
| Boot 时相关性检索 | `extractKeywords` + `scoreRelevance` → top-10 |
| Memory 整合 | `consolidateSession` — REPL 退出时 LLM 总结 |
| Skill 懒加载 | `load_skill` + `formatSkillIndex` + 权限检查 |
| 验证闸门 (No Tuple No Merge) | `verify:true` → 自动 package scripts / 语言检查 |
| 调用链追踪 + 循环检测 | `_callDepth` max 5 + EventLog |
| 生命周期 Hooks | 6 种 Hook 类型 |
| Trajectory 捕获 | `boot_context` + `invoke_sent/completed` + EventLog |
| Context 压缩 + 策略 | 统一 70%/85% + **含系统提示词 token** + tool_call 对保护 |
| Tool metadata | `readOnly` / `concurrencySafe` / `mutatesState` / `longRunning` / `requiresNetwork` |
| 权限系统 | `PermissionManager` 接入 Engine + `/permissions` 持久化规则 |
| 后台任务 | `TaskCreate/Get/List/Update/Stop` + Bash background 统一接入 |
| API 重试 | SDK maxRetries=5 指数退避 (429/5xx/ECONNRESET) + 120s timeout |
| Module-driven Tools | MemoryModule 通过 `boot().tools` 提供 3 个工具 |

## 技术栈

| 组件 | 技术 |
|------|------|
| 语言 | TypeScript 5.7 (ESM) |
| 运行时 | Node.js ≥ 20 |
| LLM API | OpenAI SDK (兼容 Claude 等端点) |
| 测试 | Vitest |
| Lint | ESLint (typescript-eslint recommendedTypeChecked) |
| 依赖 | openai · glob · zod (仅 3 个 runtime deps) |

## 许可

MIT License
