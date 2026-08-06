# Super Plan — ovolv999 v0.6.0 全面优化（第一轮：大方向）

> **目标**: 将项目从"个人项目还行"提升到"成熟项目"水平。
> **方法**: 5 轮迭代 → 全面实施 → 审计 → 识别"表面接入"问题 → 进入 super2_plan.md（细节轮）。
> **基线**: 2026-08-05 全量架构审计报告。

---

## 审计基线摘要

| 维度 | 状态 | 关键问题数 |
|------|------|-----------|
| 架构不变量 (30+) | ✅ 全部正确实现 | 0 |
| CLAUDE.md 准确性 | ❌ 4 条假声明 + 6 处计数不匹配 | 10 |
| README.md 准确性 | ❌ 版本/依赖/能力/Hook 全错 | 6 |
| 死代码 | ⚠️ 5 死函数 + 15 死事件 + 5 死 ICM | 25 |
| 类型不一致 | ⚠️ 重复类型 + ProviderId 双定义 + 循环导入 | 7 |
| "表面接入" | ❌ 大量声明但未 wire 的接口 | 20+ |
| 代码质量 | ⚠️ 元数据缺失 + 错误处理不一致 | 5 |

---

## Round 1: 文档真相层 — 修复所有文档与实现漂移

### 目标
CLAUDE.md / README.md / CHANGELOG.md 与代码真相 100% 一致。

### 任务

#### 1.1 CLAUDE.md 全量修正

| 位置 | 当前 (错误) | 修正为 | 依据 |
|------|-----------|--------|------|
| line 7 | ~67k 行 src | ~82k 行 src | 实际计数: 82,198 |
| line 12 | 当前版本 0.5.3 | 当前版本 0.6.0 | package.json:3 |
| line 12 | (package.json / README / VERSION / CHANGELOG 全部一致) | (package.json / CHANGELOG 一致; README 待更新; VERSION 文件不存在) | 事实 |
| line 83 | 34 个工具 | 42+ 个工具 (createTools 41 + loadSkill + MCP 动态) | tools/index.ts |
| line 84 | 4 个生产模块 | 5 个生产模块 (含 workspace_watcher) | engineAssembly.ts:257-275 |
| line 86 | 89 个 slash 命令 (确认正确) | 保持不变 | builtin.ts 89 registerCommand |
| line 95 | 10 种类型化信号 | 12 种类型化信号 | internalControlMessage.ts:24-36 |
| line 112-113 | RunEvent 54 变体 | RunEvent 55 变体 | events.ts:27-95 |
| line 123 | 仅 openai / minimax / openai-compatible | anthropic / openai / minimax / openai-compatible (4 可服务) | providerAdapter.ts:166-178 |
| line 166 | permissionRules.ts glob 引擎未接线 | ✅ 已接线 (toolExecutor.ts) | toolExecutor.ts:24 |
| line 167 | LongTermMemory R1–R6 接入引擎 | ⚠️ 部分接线 (MemoryModule 已用 LTM; 引擎级 boot relevance 和 search 已通) | modules/memory.ts |
| line 127 | CHANGELOG 0.5.3 "v0.5.3 is the version in package.json" | 标注为"历史记录 — 当前版本见 package.json" | package.json = 0.6.0 |

#### 1.2 README.md 全量修正

| 位置 | 当前 (错误) | 修正为 |
|------|-----------|--------|
| line 1 | `# ovolv999 (v0.5.6)` | `# ovolv999 (v0.6.0)` |
| line 268, 840, 882 | 5 运行时依赖 | 8 运行时依赖 (增加 @anthropic-ai/sdk, chokidar, vscode-jsonrpc) |
| line 209 | ProviderAdapter + ModelCapabilities 未接线 | ✅ 已接线 — ModelGateway 通过 ProviderAdapter.stream() 调用 |
| line 211 | LongTermMemory "尚未接入引擎主循环" | ✅ 已接入 — MemoryModule 通过 LTM 提供 boot relevance + memory_search + 持久化 |
| line 251, 723, 859 | Hook 名: PreToolCall / PostToolCall / OnError / OnComplete / OnContextOverflow | Hook 名: PreToolUse / PostToolUse / UserPromptSubmit / SessionStart / SessionEnd / Notification |
| line 40 | 9 种 Hook 事件 | 6 种 Hook 事件 (实际 hooks.ts 注册 6 个) |
| line 552 | `version: '1.0.0'` 插件示例 | 保留（示例代码，非项目版本） |

#### 1.3 CHANGELOG.md 修正

| 位置 | 修正 |
|------|------|
| line 45 (0.5.6 节) | 删除 "v0.5.6 is the version in package.json" |
| line 127 (0.5.5 节) | 删除 "v0.5.5 is the version in package.json" |
| line 195 (0.5.3 节) | 删除 "v0.5.3 is the version in package.json" |

---

## Round 2: 代码清洁层 — 消除死代码与类型不一致

### 2.1 删除死函数

| 函数 | 文件:行 | 操作 |
|------|---------|------|
| `recordRetry()` | modelRouter.ts:454 | 删除 — 零 caller |
| `applyRouteApplication()` | modelRouter.ts:398-416 | 删除 — 零 caller |
| `transitionTerminal()` | tools/claudeCode.ts:329-336 | 删除 — 零 caller |
| `RUNTIME_KNOWN_PROVIDERS` | modelRuntimeManager.ts:33-37 | 删除 — 零 importer |
| `buildCriticReport()` | criticTrigger.ts:76 | 删除导出或保留为内部函数 |
| `criticReportToGuidance()` | criticTrigger.ts:126 | 删除导出或保留为内部函数 |
| `interventionMessageForStall()` | progressMonitor.ts:324 | 删除导出或保留为内部函数 |
| `parseMemoryEvidenceRefs()` | modules/memory.ts:36 | 取消导出（仅内部使用） |

### 2.2 修复重复类型

| 类型 | 重复位置 | 操作 |
|------|---------|------|
| `CompletionStatus` (7-state) | completionContract.ts:27-34 | 删除。所有消费者从 turnOutcome.ts 导入 6-state 版本。completionContract.ts 内部使用 `'incomplete'` 改为 `CompletionVerdict` 内部字段。 |
| `AcceptanceCriterion` | completionContract.ts:36 + taskIntent.ts:16 | completionContract.ts 从 taskIntent.ts 重新导出 |
| `VerificationState` | completionContract.ts:44 + turnOutcome.ts:35 | completionContract.ts 从 turnOutcome.ts 重新导出 |
| `TaskKind` | reviewer.ts:12 + taskIntent.ts:14 | reviewer.ts 从 taskIntent.ts 导入 |
| `ModelCallAttempt.status` 8 声明只有 2 生产 | turnOutcome.ts:47 | 扩展 coordinator.ts 以正确映射全部 6 种 gateway 错误为细粒度 status，或缩减类型为 2 状态 |

### 2.3 修复 ProviderId 双定义

- **目标**: 全局统一的 `ProviderId` 类型
- **方案**: `providerAdapter.ts:31` 删除 `export type ProviderId = string`，改为 `import type { ProviderId } from '../providers.js'`
- **影响**: 需要验证 `ProviderAdapter` 接口的 `providerId` 字段仍正常工作

### 2.4 修复 searchExtraTools.ts ↔ index.ts 循环导入

- **方案**: 将 `findTool` 提取到独立的 `src/tools/findTool.ts`，双方都从该文件导入
- **注意**: `findTool` 目前是简单的一行函数 `tools.find(t => t.name === name)`

### 2.5 处理 `consecutiveProviderFailures` 废弃状态

- **方案 A** (推荐): 删除 `@deprecated` 标记 — 字段仍在活跃使用，标记是错的
- **方案 B**: 如果团队决定废弃，则从 loopEngine.ts 4 处 + loopSupervisor.ts + builtin.ts 移除引用

---

## Round 3: 深度接入层 — 修复"表面接入"问题

### 目标
消除"声明了接口但没有实际 wire"、"计算了字段但丢弃"、"注册了事件但不 emit"等问题。

### 3.1 RunEvent — 15 个死事件：wire or remove

**策略**: 逐一审查每个死事件，决定是否在 coordinator 中添加 emit 点，或从 union 中删除。

| 死事件 | 决定 | 理由 |
|--------|------|------|
| `PLAN_MODE_ENTERED` | **Wire** | plan mode 进入/退出是关键状态变更 |
| `PLAN_MODE_EXITED` | **Wire** | 同上 |
| `CONTEXT_COMPACTED` | **Wire** | compact 是重要操作，应有事件 |
| `AGENT_COMPLETION_ACCEPTED` | **Wire** | agent 子引擎完成是关键事件 |
| `AGENT_COMPLETION_REJECTED` | **Wire** | 同上 |
| `AGENT_MERGE_STARTED` | **Wire** | 同上 |
| `AGENT_MERGE_COMPLETED` | **Wire** | 同上 |
| `AGENT_WORKTREE_PRESERVED` | **Wire** | worktree 保留是重要决策 |
| `ROUTING_DECIDED` | **Wire** | 路由决策是核心可观测性事件 |
| `MODEL_CALL_RECORDED` | **Wire** | 每次 model call 成本记录 |
| `PROGRESS_RECORDED` | **Wire** | progress 追踪 |
| `REPLAN_REQUESTED` | **Wire** | replan 是重要流程变更 |
| `CRITIC_COMPLETED` | **Wire** | critic 审查完成 |
| `REVIEW_COMPLETED` | **Wire** | reviewer 完成 |
| `RUN_COMPLETED` | **删除** | 已被 RUN_TERMINATED 替代 |

**实现**: 在 coordinator.ts 的状态机每一步添加对应 `emit()` 调用。

### 3.2 ROC-2: 修复 `ROUTING_UNAVAILABLE` as never 绕过

- 方案: 将 `ROUTING_UNAVAILABLE` 加入 `RunEvent` union，移除 `as never` cast

### 3.3 5 个 InternalControlMessage 种类：wire or remove

| ICM 种类 | 决定 | 理由 |
|----------|------|------|
| `critic_feedback` | **Wire** | criticTrigger 产出的反馈应该通过 ICM 注入 |
| `completion_rejected` | **Wire** | 拒绝完成时的解释 |
| `provider_fallback` | **Wire** | fallback 切换时通知模型 |
| `tool_recovery` | **Wire** | 工具恢复 |
| `hook_additional_context` | **Wire** | hook 注入额外上下文 |

**实现**: 在 coordinator.ts 的 criticTrigger / completionContract / modelGateway fallback / tool 恢复 / hook 调用点添加 `controlMessageLog.append()`。

### 3.4 6 个 ReviewResult 丢弃字段：use or remove

- `verdict`, `taskKind`, `satisfiedCriteria`, `unsatisfiedCriteria`, `staleEvidence`, `verificationSummary`, `residualRisks` — 目前全被丢弃
- **方案**: 将 verdict 纳入 TurnOutcome，将其他字段记录到 EventLog（增加可观测性），至少不丢弃

### 3.5 废弃 shim 清理

| Shim | 操作 |
|------|------|
| `getProviderCircuitState()` (coordinator.ts:228) | 将 engine.ts / loopEngine.ts 的调用改为直接 `modelRouter.getProfileCircuitState()`；shim 标 `@deprecated` 留兼容期 |
| `restoreProviderCircuitState()` (coordinator.ts:246) | 同上 — 调用方改为直接 `modelRouter.restoreCircuitState()` |

### 3.6 `codeQuality.ts` 永远返回 `isError: false`

- **问题**: 质量检查失败时 tool 结果 `isError: false`，调用方无法区分通过/失败
- **修复**: 检查失败时设置 `isError: true`

### 3.7 `agent.ts` 缺少 `mutatesState: true`

- **修复**: agent.ts metadata 添加 `{ mutatesState: true, concurrencySafe: true, longRunning: true }`
- **影响**: toolScheduler 正确识别 agent 为状态变更工具

---

## Round 4: 架构一致性与代码质量层

### 4.1 错误处理模式统一

**当前**: 3 种不兼容的错误返回模式混用
- Pattern A: `return { content: '...', isError: true }`（大部分工具）
- Pattern B: `return Promise.resolve({ ... })`（loadSkill, searchExtraTools）
- Pattern C: try/catch + 字符串拼接（claudeCode, webFetch, webSearch）

**目标**: 全部统一为 Pattern A（直接同步 return），异步方法自然返回 Promise。

### 4.2 品牌目录收敛路径

**当前**: `.ovogo` (57 src 引用) vs `.ovolv999` (121 src 引用)
- 不在此轮统一（需要用户数据迁移方案），但需要明确记载在 CLAUDE.md 中
- 在 CLAUDE.md 添加收敛计划：阶段、引用数、迁移策略

### 4.3 测试补全

- `tests/skills/` — 填充测试或删除空目录
- 测试镜像 src 结构比例从 23% 提升到 50%+

### 4.4 `ModelProfile.tier` 删除

- modelRouter.ts:111 — `tier` 字段从未被 `scoreProfile()` 读取
- 删除接口字段和 `routerFromSingleModel()` 中的赋值

### 4.5 `listConfiguredModelTierProfiles` 归属

- modelTier.ts:34-70 — 这个函数仅在 commands/builtin.ts 使用
- 移入 commands/ 或保留但标注 "仅 CLI 使用"

### 4.6 VERSION 文件

- 决定: 创建 VERSION 文件内容为 `0.6.0` 或从 CLAUDE.md 中删除 VERSION 文件引用
- 推荐: 创建 VERSION 文件（CI/CD 友好）

---

## Round 5: 验收与回归防护层

### 5.1 全量类型检查

```bash
npx tsc --noEmit
```
确保所有修改无类型错误。

### 5.2 全量测试

```bash
pnpm check
```
确保所有测试通过。

### 5.3 死代码验证脚本

在 CI 中添加 `scripts/deadCodeCheck.sh`：
- 检测零 import 的 export
- 检测 `@deprecated` 标记的活跃 caller
- 检测 `as never` / `as any` 使用

### 5.4 文档一致性检查脚本

在 CI 中添加 `scripts/docDriftCheck.sh`：
- 版本一致性: package.json ↔ README ↔ VERSION ↔ CHANGELOG
- 工具计数: CLAUDE.md vs createTools()
- 模块计数: CLAUDE.md vs engineAssembly modules
- ICM 计数: CLAUDE.md vs InternalControlMessage union

### 5.5 CHANGELOG 追加

在 CHANGELOG.md 顶部添加本轮优化的条目：
```
## 0.6.1 — Documentation & Integration Hardening
```

---

## 实施优先级矩阵

| 优先级 | Round | 描述 | 估算工作量 |
|--------|-------|------|-----------|
| P0 | 1 | 文档真相层 | 2h |
| P0 | 2.1-2.3 | 删除死代码 + 修复类型 | 3h |
| P1 | 2.4-2.6 | 循环导入 + 废弃字段 + ModelCallAttempt | 2h |
| P1 | 3.1-3.5 | 深度接入 RunEvent + ICM + ReviewResult + shim | 4h |
| P1 | 3.6-3.7 | codeQuality + agent metadata | 1h |
| P2 | 4.1 | 错误处理统一 | 2h |
| P2 | 4.2-4.6 | 品牌收敛路径 + 测试 + VERSION | 2h |
| P2 | 5 | 验收 + CI 脚本 | 1h |
| **总计** | | | **~17h** |

---

## 验证标准

实施完成后执行:
1. `npx tsc --noEmit` — 零错误
2. `pnpm check` — 全绿
3. CLAUDE.md / README.md / CHANGELOG 人工复核 — 所有计数验证通过
4. `scripts/docDriftCheck.sh` 通过
5. `scripts/deadCodeCheck.sh` — 零死代码

---

## 审计后预期残留问题（将进入 super2_plan.md）

以下问题在此轮中**有意不处理**，留待 super2_plan.md:

1. **品牌目录实际迁移** (.ovogo → .ovolv999 数据搬家)
2. **semantic.jsonl → longterm.jsonl 数据迁移**
3. **工具错误处理返回值语义统一** (大重构，需要全量回归)
4. **测试覆盖率从 23% 提升到 80%+**
5. **性能 profiling 与热点优化**
6. **类型窄化: `as unknown as` / `as any` 消除** (13 处)
7. **Windows 兼容性租约指纹降级** (/proc-only 路径)
8. **router 信号真实化** (repoFileCount=filesTouched×10 代理)
9. **MCP 工具错误隔离增强**
10. **LSP 集成深度**
