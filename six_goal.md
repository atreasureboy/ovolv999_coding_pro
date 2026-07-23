你现在是本项目的高级 Agent Runtime 架构师和主要实现者。

项目仓库：

https://github.com/atreasureboy/ovolv999_coding_pro

本轮任务不是继续横向增加功能，也不是重写整个项目，而是完成一次以“Runtime Integrity”为目标的架构收敛，使仓库中已经存在的高级能力真正接入统一的主执行链。

## 一、总目标

将当前项目升级为：

**v0.2 Runtime Integrity**

核心目标：

1. ProviderAdapter 真正接管模型请求；
2. 所有外部命令统一经过 CommandRunner；
3. ResourceScheduler 成为唯一工具资源调度器；
4. Agent/Worker 具备完整且一致的生命周期；
5. Run、Event、Worker 和 Artifact 可以可靠持久化与恢复；
6. 建立真实 Coding Agent Eval 和回归基线；
7. 修复当前运行状态与消息角色的语义问题；
8. 保持现有 CLI 和主要 API 尽量兼容。

不要只增加接口、类型、空实现或 TODO。每项设计必须接入真实运行路径，并由测试证明。

---

## 二、强制约束

1. 先阅读代码和测试，再修改。
2. 不得根据 README 猜测架构，必须追踪真实调用链。
3. 不得大规模推倒重写。
4. 不得删除现有能力来规避问题。
5. 不得用 mock 通过本应验证真实路径的集成测试。
6. 不得只修改类型而不修改 Runtime 调用关系。
7. 不得降低已有测试覆盖。
8. 保持 TypeScript strict。
9. 新增代码必须有错误处理、取消传播和结构化日志。
10. 避免新增重量级依赖；确有必要时说明理由。
11. 每完成一个 Phase，立即运行相关测试，不要等所有修改结束后才测试。
12. 发现现有设计与本 Prompt 冲突时，以“统一真实执行路径、减少双轨实现”为最高原则。

---

## 三、Phase 0：真实架构审计

先不要修改功能。

追踪并记录以下完整调用链：

### 模型调用链

```text
CLI
→ ExecutionEngine
→ ExecutionCoordinator
→ ModelGateway
→ SDK / Provider
```

### 工具调用链

```text
Model tool call
→ ToolScheduler
→ ResourceScheduler
→ ToolExecutor
→ Tool implementation
→ Command execution
```

### 子 Agent 调用链

```text
AgentTool
→ WorkerAdapter
→ Child engine / Claude Code / external worker
→ Run Registry
→ Event Bus
→ Result collection
```

### 恢复调用链

```text
Process restart
→ Registry load
→ Run recovery
→ Worker reattach
→ Terminal-state decision
```

创建：

```text
docs/V0_2_RUNTIME_INTEGRITY.md
```

内容至少包含：

* 当前真实调用图；
* 名义架构与真实执行路径的差异；
* 重复或平行实现；
* 绕过 ToolExecutor、权限系统或 ResourceScheduler 的代码；
* 直接调用 exec、execSync、spawn 的位置；
* Provider-specific 逻辑的位置；
* 生命周期不完整的 Worker；
* 可能被吞掉的持久化错误；
* 本轮修改计划；
* 兼容性风险。

审计结束后直接继续实现，不等待人工确认。

---

## 四、Phase 1：Provider Runtime 统一

目标：让 ProviderAdapter 真正进入模型请求主链。

### 要求

1. ModelGateway 不再直接依赖具体 Provider SDK 语义。
2. 定义统一请求和响应：

```typescript
interface ModelRequest {
  model: string;
  messages: NormalizedMessage[];
  tools?: NormalizedToolDefinition[];
  toolChoice?: NormalizedToolChoice;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

interface ModelResponse {
  message: NormalizedAssistantMessage;
  finishReason: NormalizedFinishReason;
  usage?: NormalizedUsage;
  providerMetadata?: Record<string, unknown>;
}
```

3. ProviderAdapter 至少统一处理：

* 普通响应；
* streaming；
* tool calls；
* finish reason；
* usage；
* reasoning content；
* provider error；
* retry-after；
* AbortSignal；
* unsupported capability。

4. 首先保证 OpenAI Compatible Adapter 完整可用，不要求一次性实现所有 Provider。
5. Provider Registry 必须真正参与：

* Adapter 选择；
* Client 创建；
* capability 查询；
* model normalization。

6. ExecutionCoordinator 中不得存在：

```text
if provider === ...
switch provider ...
```

7. 保留现有 OpenAI Compatible 配置和 CLI 行为。
8. 增加单元测试和至少一个从 Coordinator 到 Fake ProviderAdapter 的集成测试。

---

## 五、Phase 2：统一 CommandRunner

新增统一的命令执行抽象，禁止各模块自行管理进程。

建议接口：

```typescript
interface CommandSpec {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: string;
  resourceClaims?: ResourceClaim[];
  permissionContext?: PermissionContext;
  outputLimitBytes?: number;
  shell?: boolean;
}

interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  truncated: boolean;
}
```

CommandRunner 必须支持：

* timeout；
* AbortSignal；
* 进程树终止；
* cwd 校验；
* 环境变量白名单；
* stdout/stderr 限制；
* 敏感信息脱敏；
* 结构化事件；
* 权限审批；
* sandbox policy；
* resource claims；
* Windows 和 Unix 的基本兼容；
* shell=false 默认值。

逐步迁移：

* AgentTool verification；
* Worktree/Git 操作；
* Loop quality gates；
* Background task；
* Shell/Bash tools；
* 其他直接使用 exec、execSync、spawn 的位置。

允许 CommandRunner 底层直接调用 spawn，但业务模块不得绕过它。

为确实无法立即迁移的代码建立明确的 allowlist，并在文档中列出；不要留下无说明的旁路。

---

## 六、Phase 3：统一资源调度

目标：ResourceScheduler 成为唯一的并发冲突判定来源。

### 要求

1. 删除或停用基于工具名称的 permissive legacy safe whitelist。
2. 每个工具必须声明资源访问：

```typescript
type ResourceMode = "read" | "write" | "exclusive";

interface ResourceClaim {
  type: "file" | "directory" | "git" | "process" | "session" | "network" | "workspace";
  id: string;
  mode: ResourceMode;
}
```

3. 没有声明资源的工具默认串行执行。
4. 规范化路径，避免：

```text
./src/a.ts
src/a.ts
绝对路径/src/a.ts
```

被识别为不同资源。

5. 至少处理：

* 同文件读读可并发；
* 同文件读写冲突；
* 同文件写写冲突；
* 父目录写与子文件访问冲突；
* 同一 Git Worktree 操作冲突；
* 同一 Shell/Tmux session 冲突；
* Agent merge 与工作区修改冲突。

6. 支持：

* AbortSignal；
* lock timeout；
* waiting event；
* acquired event；
* released event；
* fairness；
* 防止永久饥饿。

7. ToolScheduler 只负责计划和提交，不再自行维护第二套并发安全判断。

增加竞争测试和取消测试。

---

## 七、Phase 4：统一 Worker 生命周期

定义统一 WorkerRuntime：

```typescript
interface WorkerRuntime {
  start(spec: WorkerStartSpec): Promise<WorkerHandle>;
  status(runId: string): Promise<WorkerStatus>;
  steer(runId: string, message: string): Promise<void>;
  cancel(runId: string, reason?: string): Promise<void>;
  wait(runId: string, signal?: AbortSignal): Promise<WorkerResult>;
  collect(runId: string): Promise<WorkerResult>;
  reattach(runId: string): Promise<WorkerHandle | null>;
  dispose(runId: string): Promise<void>;
}
```

### 必须实现

1. 进程内 Agent 保存：

```text
runId → child engine / AbortController / result promise / artifact references
```

2. cancel 必须真正传播到子 Agent，而不仅是修改数据库状态。
3. steer 必须有明确语义：

* queued；
* delivered；
* rejected；
* worker_not_running。

4. collect 必须返回：

* 最终状态；
* 最终文本；
* changed files；
* patch；
* verification results；
* artifact references；
* token/cost/time；
* error。

5. 外部 Worker 尽可能支持 reattach。
6. 进程重启后：

* 可恢复的外部 Worker 尝试 reattach；
* 无法恢复的进程内 Worker 标记为 lost；
* 不得统一粗暴标记为 failed。

7. Claude Code、进程内 Agent 和未来 Codex Worker 共享同一生命周期协议。
8. AgentTool 只做工具层参数解析和结果转换，不自行实现另一套生命周期状态机。

---

## 八、Phase 5：可靠事件存储

将 EventStore 抽象为正式组件。

建议数据模型：

```text
runs
run_events
workers
artifacts
approvals
checkpoints
```

优先采用 SQLite WAL；JSONL 保留为导出和兼容格式。

### 要求

1. Run 状态变化和对应事件在同一 transaction 中提交。
2. 每个 Run 的事件具有单调 sequence。
3. 支持幂等 event id。
4. 支持按 runId replay。
5. 支持崩溃后重建状态。
6. 支持 schema version。
7. 支持旧 JSONL 数据迁移或只读导入。
8. 关键持久化失败不得被空 catch 吞掉。
9. 非关键观察者失败不得破坏 Run。
10. 明确定义 critical subscriber 和 normal subscriber。
11. 增加：

* 并发写入测试；
* 崩溃恢复测试；
* corrupted record 测试；
* duplicate event 测试；
* sequence continuity 测试。

---

## 九、Phase 6：修复执行语义

### 1. 禁止伪造用户消息

空响应重试、长度截断继续、工具错误恢复等 Runtime 控制信息，不得以普通 `user` 消息写入真实对话历史。

定义内部消息类型，例如：

```typescript
type InternalControlMessage =
  | { type: "continue_after_length" }
  | { type: "retry_empty_response"; attempt: number }
  | { type: "tool_recovery"; toolCallId: string };
```

在进入 ProviderAdapter 前转换为合适的 Provider 表达，但不得污染用户可见历史，也不得冒充用户意图。

### 2. 修正终态

不得把 `max_iterations` 自动视为 succeeded。

至少区分：

```text
completed
partial
exhausted
failed
cancelled
lost
```

完成状态必须有明确证据，例如：

* 模型明确结束；
* 所需验证完成；
* acceptance criteria 满足；
* 没有仍在运行的关键 Worker。

### 3. WorkingState 信任边界

WorkingState 中可能包含用户目标、工具输出、文件内容等不可信文本。

不得仅因为它被序列化或放在 System Prompt 后部，就认为不存在 Prompt Injection 风险。

要求：

* 区分 trusted policy 与 untrusted runtime data；
* 对 WorkingState 使用明确数据边界；
* 限制尺寸；
* 避免把工具输出直接拼接为高权限指令；
* 增加包含恶意文本的测试；
* 保证数据内容不能修改系统策略、权限策略或工具约束。

---

## 十、Phase 7：真实 Agent Eval

新增：

```text
evals/
  fixtures/
  tasks/
  scorers/
  baselines/
  reports/
```

至少建立以下固定 Fixture：

1. TypeScript 单文件 bugfix；
2. TypeScript 多文件 feature；
3. Python bugfix；
4. Rust compile error；
5. 测试失败定位；
6. 需要先搜索再修改的任务；
7. 错误需求或信息不足任务；
8. 大上下文压缩任务；
9. 两个子 Agent 并行任务；
10. Worker 取消与恢复任务；
11. Tool 冲突调度任务；
12. 恶意仓库指令和 Prompt Injection 任务。

### 每个 Eval 记录

* success；
* acceptance score；
* tests passed；
* unnecessary files changed；
* tool calls；
* failed tool calls；
* retries；
* model requests；
* input/output tokens；
* estimated cost；
* duration；
* context compactions；
* worker count；
* cancellation latency；
* recovery success。

输出机器可读 JSON 和简洁 Markdown 报告。

增加 baseline comparison：

* 明显低于 baseline 时退出非零；
* 允许配置合理波动范围；
* 不将随机单次结果直接作为唯一门禁；
* 支持固定 Fake Provider 的确定性回归；
* 支持真实模型的可选评测。

添加脚本：

```json
{
  "test:unit": "...",
  "test:integration": "...",
  "eval": "...",
  "eval:deterministic": "...",
  "check": "..."
}
```

---

## 十一、Phase 8：工程化和发布准备

完善 package.json：

* name 与 CLI 品牌一致；
* description；
* version；
* license；
* repository；
* bugs；
* homepage；
* engines；
* packageManager；
* files；
* exports；
* prepack。

增加 GitHub Actions：

* install with frozen lockfile；
* typecheck；
* lint；
* unit tests；
* integration tests；
* deterministic eval；
* build；
* npm pack smoke test。

至少覆盖：

* Ubuntu；
* Windows。

更新 README：

1. 将功能标注为 Stable / Beta / Experimental / Planned。
2. 区分已经接入主执行链的功能与原型功能。
3. 增加 5 分钟 Quick Start。
4. 增加 Architecture Reality 图。
5. 增加 Provider 支持矩阵。
6. 增加 Worker 支持矩阵。
7. 增加安全边界和非目标。
8. 不夸大尚未完整实现的生命周期、恢复和多 Provider 能力。

---

## 十二、全局验收标准

最终必须满足：

1. ExecutionCoordinator 不包含 Provider-specific 分支。
2. ModelGateway 的真实请求通过 ProviderAdapter。
3. ToolScheduler 不再维护 permissive legacy safe tool 白名单。
4. ResourceScheduler 是唯一资源冲突判定来源。
5. Agent cancel 能真正终止仍在运行的进程内 Agent。
6. collect 能返回输出、变更、验证和 artifact。
7. max_iterations 不再映射为 succeeded。
8. Runtime 控制消息不再伪装为 user 消息。
9. 关键事件持久化失败不会被静默吞掉。
10. Loop 和 Agent verification 不再绕过 CommandRunner。
11. 至少存在一个确定性的端到端 Coding Eval。
12. 原有测试通过。
13. 新增测试覆盖本轮核心路径。
14. build、typecheck、lint、unit、integration、deterministic eval 全部通过。
15. 搜索仓库中所有直接进程调用并给出剩余 allowlist。
16. 不得留下只有类型没有 Runtime 接入的“假完成”。

---

## 十三、执行顺序

按照以下顺序实施：

```text
Phase 0 架构审计
→ Phase 1 Provider
→ Phase 2 CommandRunner
→ Phase 3 ResourceScheduler
→ Phase 4 Worker lifecycle
→ Phase 5 EventStore
→ Phase 6 执行语义
→ Phase 7 Eval
→ Phase 8 工程化
```

如果单轮上下文无法完成全部内容：

1. 优先完成 Phase 0；
2. 然后完成 Phase 1–3；
3. 再完成 Phase 4–6；
4. 最后完成 Phase 7–8；
5. 将未完成事项写入 `docs/V0_2_RUNTIME_INTEGRITY.md`；
6. 不得用空壳实现宣称完成。

---

## 十四、最终输出格式

完成后输出：

### 1. Architecture audit

* 原问题；
* 根因；
* 真实调用链；
* 双轨实现；
* 风险。

### 2. Changes made

按模块列出修改文件和行为变化。

### 3. Runtime guarantees

说明现在真正可以保证什么。

### 4. Tests and evals

列出实际执行的命令、结果和失败项。

### 5. Compatibility

说明 CLI、配置和 API 是否有兼容性变化。

### 6. Remaining risks

只列真实未解决问题，不得用模糊措辞掩盖。

### 7. Next milestone

给出 v0.3 最值得实施的三个方向，但本轮不得继续横向堆功能。
