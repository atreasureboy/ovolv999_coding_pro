# Architecture Audit — 2026-08-03

> **Scope**: Comprehensive architecture-level audit across subsystems.
> **Method**: 4 parallel audit agents + direct verification of high-severity findings.
> **Build state**: 4856/4856 tests pass, 0 typecheck errors.

## Executive Summary

The audit identified **30 findings** across 4 severity levels:

| Severity | Count | Examples |
|---|---|---|
| HIGH | 15 | 5 dead modules, 4 dead fields, `getModeBehavior` 缺分支, 权限/执行错误不可区分, retryable 正则分歧, `/daemon workers` 运行时崩 |
| MEDIUM | 13 | Union 重复, 死 EventType, ADR 编号缺口, CHANGELOG 缺口, 持久层 subsystem 死接口, `maxRestarts` 不传递到 bulk path |
| LOW | 6 | 错误前缀不一致, 内部 API 死 |
| **总计** | **34** | — |

> ADR 041-044 (R38-R41) 全部 MATCH (peer audit 确认) — 仅有 stale test count 这一项 LOW drift。

**Top 6 actions** (≤ 半天工作量):
1. **修 `/daemon workers` 运行时崩** (Finding 33, HIGH,~10 分钟) — `builtin.ts:3028` wrapper shape 适配
2. **修 `maxRestarts` 不传 bulk path** (Finding 34, MEDIUM,~15 分钟) — `daemon.ts:618,708` 递归携带 payload
3. **删除 5 个死模块** + **3 个死字段** (~45 分钟)
4. **修复 `getModeBehavior` 缺 `dontAsk`/`bubble` 分支** (~20 分钟)
5. **合并双 retryable 正则** (5 LOC 重构)
6. **重写 ADR-010 + 修正 ADR-013/014 描述** + **CHANGELOG 补 R8-R41** (~45 分钟)

---

## Finding 1: 死模块 — `src/skills/marketplace.ts` (HIGH)

**File**: `/project/ovolv999_coding_pro/src/skills/marketplace.ts` (84 行)

**Evidence**:
```bash
$ grep -rn "from.*marketplace\|getMarketplaceSkillsDir" src/
src/skills/marketplace.ts:29:import { parseMarketplaceSkillFile } from './marketplaceParser.js'
src/skills/marketplace.ts:31:export function getMarketplaceSkillsDir(): string {
# only self-references, never imported by any other file
```

**Impact**: 设计阶段提到但未接线。`marketplaceParser.ts` 同。

**Action**: DELETE
```bash
rm src/skills/marketplace.ts src/skills/marketplaceParser.ts
# 验证测试是否依赖
grep -rn "marketplace" tests/  # 应该是 0 个匹配 (除本身)
```

---

## Finding 2: 死模块 — `src/core/daemon/{daemonClient,daemonServer,sessionStore}.ts` (HIGH)

**Files**:
- `src/core/daemon/daemonClient.ts` (202 行)
- `src/core/daemon/daemonServer.ts` (187 行)
- `src/core/daemon/sessionStore.ts` (228 行)

**Evidence**:
```bash
$ grep -rn "from '\.\./daemon/daemonClient\|from '\./daemon/daemonServer\|from '\./daemon/sessionStore" src/
(无输出 — 死代码)
```

**Impact**: R8 替换为 `src/core/daemon.ts` (单文件 895 行) + `src/core/daemonClient.ts`,但旧子目录未清理。

**Action**: DELETE entire `src/core/daemon/` subdir (替换后的 `daemonClient.ts` 独立使用)。

```bash
rm -rf src/core/daemon/
```

---

## Finding 3: 死模块 — `src/core/lspClient.ts` (HIGH)

**File**: `/project/ovolv999_coding_pro/src/core/lspClient.ts` (227 行)

**Evidence**:
```bash
$ grep -rn "lspClient\b" src/
src/core/lspClient.ts:6: * (`require('../core/lspClient.js')` in builtin.ts, `from '../core/lspClient.js'`
# only its own comment, no actual imports
```

**Impact**: 是 R8 替换为 `src/core/lsp/client.ts` 的 re-export shim。`lspTool.ts:17` 直接 import 新路径。

**Action**: DELETE
```bash
rm src/core/lspClient.ts
```

---

## Finding 4: 死字段 — `consecutiveCommandFailures` (HIGH)

**Files**:
- `src/core/loopEngine.ts:466` `consecutiveProviderFailures: circuit.consecutiveFailures, consecutiveCommandFailures: 0,`
- `src/core/loopEngine.ts:533` 同上
- `src/core/loopEngine.ts:882` 同上

**Evidence**: 三处硬编码 `0` — 字段从未被读取或递增。

**Action**: 移除字段声明和赋值

```bash
# grep
grep -n "consecutiveCommandFailures" src/core/loopEngine.ts
# 三处删除 (466, 533, 882)
# 同步检查 TypeScript 类型定义 (LoopState 等)
grep -rn "consecutiveCommandFailures" src/
```

---

## Finding 5: 死字段 — `writeTimeoutMs` (HIGH)

**Files**:
- `src/core/loopSupervisor.ts:83` `writeTimeoutMs: number` (声明)
- `src/core/loopSupervisor.ts:89` `writeTimeoutMs: 5_000,` (默认)

**Evidence**:
```bash
$ grep -rn "writeTimeoutMs" src/
src/core/loopSupervisor.ts:83:  writeTimeoutMs: number
src/core/loopSupervisor.ts:89:  writeTimeoutMs: 5_000,
# 无 reader
```

**Action**: 移除声明 + 默认值。如果意图是配置化超时,需先确定 reader。

---

## Finding 6: ADR 编号缺口 — 缺 ADR-011 (MEDIUM)

**File**: `/project/ovolv999_coding_pro/docs/ADR/`

**Evidence**:
```
001, 002, 003, 004, 005, 006, 007, 008, 009, 010, [GAP], 012, 013, ...
```

**Action**: 创建 ADR-011 占位文件或重命名后续 ADR 缩位。后者破坏太多,推荐前者:

```bash
echo "ADR-011 was reserved but never written." > docs/ADR/011-reserved.md
```

---

## Finding 7: 文档 ↔ 实现漂移 — ADR-010 (HIGH)

**File**: `/project/ovolv999_coding_pro/docs/ADR/010-anthropic-adapter.md`

**Problem**: ADR 描述"zero-deps hand-rolled fetch/SSE",但实际:

```bash
$ grep -n "import.*@anthropic-ai/sdk" src/core/model/anthropicAdapter.ts
src/core/model/anthropicAdapter.ts:11:import Anthropic from '@anthropic-ai/sdk'
```

**Action**: 重写 ADR-010 (替代 zero-deps fetch 描述),或标记为 superseded by ADR-012。

推荐重写 — 说明 SDK 实际接入 + R8 决策原因 (5→8 deps,用户的"A继续升级"决策)。

---

## Finding 8: 文档 ↔ 实现漂移 — ADR-013 Layer 3 描述 (HIGH)

**File**: `/project/ovolv999_coding_pro/docs/ADR/013-permission-system.md`

**Problem**: ADR 表格说 `bypassPermissions/dontAsk` 跳过 Layer 3 (L3)。实际:

```bash
$ grep -A 3 "modeGated" src/core/toolRuntime/toolExecutor.ts
140:    if (modeGated === 'deny') {  # 只有 deny 跳过
144:      return { ok: false, ... }
150:    const globResult = evaluateDefaultGlobRule(toolName, input)  # L3 总是调用
```

**Action**: 更新 ADR-013 表格 — "L3 总是评估;deny 总是 win,不分 mode"。

---

## Finding 9: 依赖计数不符 (MEDIUM)

**Files**:
- `CLAUDE.md` 顶部:"运行时依赖仅 5 个"
- `package.json:55-63`: 8 个 runtime deps

**Action**: 更新 CLAUDE.md 顶部 → "8 个:openai / glob / zod / ink / react / @anthropic-ai/sdk / chokidar / vscode-jsonrpc"。

---

## Finding 10: CHANGELOG 缺口 (MEDIUM)

**File**: `/project/ovolv999_coding_pro/CHANGELOG.md`

**Problem**: R8-R41 阶段 (3 SDK 替换 + Permission 系统 + 28 个 daemon 迭代) 无 CHANGELOG 条目。

**Action**: 添加 R8-R41 章节,简述每轮借用内容。

---

## Finding 11: 数据目录双品牌未完全收敛 (MEDIUM)

**Files**: `src/skills/`, `src/core/`, `bin/ovogogogo.ts`

**Evidence**:
```bash
$ grep -rn "\.ovogo\b\|\.ovolv999\b" src/ | wc -l
33  (大部分是 .ovolv999,但仍有 .ovogo 残留)
```

**Action**: 全面替换 `.ovogo` → `.ovolv999` (CLAUDE.md P3 大迁移)。

---

## Finding 12: 路由信号代理仍存 (MEDIUM)

**File**: `/project/ovolv999_coding_pro/src/core/model/routingSignalCollector.ts:137`

```typescript
const repoFileCount = Math.max(filesTouched * 10, 100) // cheap proxy until a real count exists
```

**Action**: 实现真实文件计数 (`glob('**/*').length` per cwd) 或文档化为已知占位。

---

## Finding 13: ADR-014 模式列表陈旧 (MEDIUM)

**File**: `/project/ovolv999_coding_pro/docs/ADR/014-permission-rules-config.md:79-84`

**Problem**: ADR 说模式命令只接受 5 模式。R12 后实际接受 7 模式 (`/permissions mode dontAsk` 真实工作)。

**Action**: 更新 ADR-014 描述 + 列出 7 模式。

---

## Finding 14-18: 低优先级 (LOW)

| # | 描述 | 文件 |
|---|---|---|
| 14 | 注释称 "5 依赖" 需更新 | `CLAUDE.md:11` |
| 15 | inline 注释陈旧 "R7-era" | `src/core/lsp/client.ts:6` |
| 16 | ADR-019 schema 不一致 (empty response `restarted` vs `requested`) | `docs/ADR/019-restart-worker-all.md:90-92` |
| 17 | `telemetry.ts` 有 `tool_call` 但 eventLog 没有 (两套并行的 tool_call 事件) | `src/core/telemetry.ts:27` |
| 18 | `daemon.log` 与 `events.jsonl` 分裂 (daemon 自己的日志,没有走 engine EventLog) | `src/core/daemon.ts:215-226` |

---

## Finding 19: `getModeBehavior` 缺 `dontAsk` / `bubble` 分支 (HIGH)

**File**: `src/core/permissionSystem.ts:139-171`

**Problem**: `gateByPermissionMode` 在 Layer 2 把 `dontAsk`/`bubble` 短路为 `allow`,所以 Layer 4 `permissionManager.check` 从未用这些 mode 调过。如果有子路径绕过 Layer 2 (例如子 agent 直接调 `permissionManager.check`),`dontAsk` 和 `bubble` 会 fallback 到 `default` 分支(危险的 ask 提示)。

```typescript
export function getModeBehavior(
  mode: PermissionMode,
  toolName: string,
  isDangerous: boolean,
): PermissionBehavior {
  // bypassPermissions branch exists
  // plan branch exists
  // auto branch exists
  // acceptEdits branch exists
  // default fallback: ask for dangerous, allow known-safe
  // ❌ NO dontAsk branch
  // ❌ NO bubble branch
}
```

**Evidence**:
- `isBypassMode(mode)` 工具存在 (`permissionSystem.ts:129`) 但 `getModeBehavior` 未使用
- `isSandboxMode(mode)` 工具存在 (line 125) 但 `getModeBehavior` 未使用

**Action**:
```typescript
if (isBypassMode(mode)) return 'allow'
if (mode === 'bubble') return 'allow'  // bash tool 自身处理 sandbox wrap
```

让函数自完备 — 任何 consumer 都得到一致答案,不依赖 `gateByPermissionMode` 预过滤。

---

## Finding 20: 死 EventType `user_input` / `user_interrupt` (MEDIUM)

**File**: `src/core/eventLog.ts:46-47, 64-65`

**Problem**: EventType 联合声明 15 类型,但 `user_input` / `user_interrupt` 从未被 emit。EventLog 通过 `isValidEntry()` 校验,但 renderer `toolRenderer.ts:75` 的图标 map 没有这两个类型的入口。

**Action**:
- 选项 A:删除死类型 (如果确实不需要)
- 选项 B: 接线 — coordinator.ts 在 user-prompt 阶段 emit `user_input`,在 abort 阶段 emit `user_interrupt`

推荐选项 B — 5 行代码,但提供完整的 user-lifecycle 审计轨迹。

---

## Finding 21: `coordinator.ts` 把 LLM-usage 伪装成 `tool_call` (LOW)

**File**: `src/core/runtime/coordinator.ts:1474, 1516`

**Problem**: 两处用 `eventLog.append('tool_call', 'llm_api_usage_missing', ...)` 和 `'llm_api'`,但 `tool_call` 期望 `input` 字段,实际是 `{ usage, durationMs }`。renderer 会误格式化。

**Action**:
```typescript
// eventLog.ts
| 'llm_api' | 'llm_api_usage_missing'

// coordinator.ts
eventLog.append('llm_api', ...)
```

加 2 个 EventType 解决类型与渲染不匹配。

---

## Finding 22: `LoopCheckpoint.lastCommit` 死字段 (HIGH)

**File**: `src/core/loopSupervisor.ts:59`

```typescript
export interface LoopCheckpoint {
  lastCommit?: string   // ❌ 永不被 read 或 write
  ...
}
```

CLAUDE.md P2 backlog 已列。

**Action**:
- 选项 A:删除 (如果 git head 已存在并够用)
- 选项 B: 用 `git rev-parse HEAD` 真正填充

---

## Finding 23: `HeartbeatConfig.writeTimeoutMs` 死字段 (HIGH)

**File**: `src/core/loopSupervisor.ts:83, 89`

```typescript
export interface HeartbeatConfig {
  writeTimeoutMs: number  // ❌ 声明 + 默认 5000,从未 read
  ...
}
const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  writeTimeoutMs: 5_000,
  ...
}
```

`updateHeartbeat` (line 191) 用 `writeFileSync` 但没有 timeout。4 个 test 引用但都是写端。

**Action**:
- 选项 A:实现 write timeout (重写为 Promise race)
- 选项 B:删除字段 + 测试清理

推荐 B — 心跳写不需要 timeout(写 1KB JSON 不可能 hang)。

---

## Finding 24: PermissionMode 联合重复 4 处 (MEDIUM)

**Files**:
- `src/core/types.ts:149, 409` (inline)
- `src/core/permissionSystem.ts:28-35` (exported)
- `src/core/toolRuntime/permissionModeGate.ts:20` (inline)
- `src/commands/builtin.ts:632` (inline literal array)

**Problem**: 加第 8 个 mode 需要改 4 文件。`permissionSystem.ts` 已 export `isValidPermissionMode()` 但 `builtin.ts:632` 没用。

**Action**:
```typescript
// types.ts:149
permissionMode: PermissionMode  // 替换 inline

// permissionModeGate.ts:20
mode: PermissionMode  // 替换 inline

// builtin.ts:632
if (!isValidPermissionMode(mode)) return text('Unknown permission mode: ' + mode)
```

---

## Finding 25: 错误前缀不一致 (LOW)

**File**: `src/core/toolRuntime/toolExecutor.ts:128-237`, `src/core/daemon.ts`

**Problem**: 5 个不同的拒绝前缀,客户端 pattern-match 困难:
- `Permission mode '${mode}' denies ${toolName}`
- `Permission rule denied: ${reason}`
- `Permission denied for ${toolName}.`
- `Permission denied by user for ${toolName}.`
- `Tool "${toolName}" denied by hook (${hookName}): ${reason}`

IPC 错误前缀又不一致 (`Daemon socket not found` 无 action prefix)。

**Action**: 文档化在 `runtime truth contract` 或考虑统一 `{ code, layer, message }` 形状。优先级低。

---

## Finding 26: `rotateIfExceeded()` 公开 API 死 (LOW)

**File**: `src/core/eventLog.ts:315`

**Problem**: 公开方法 `rotateIfExceeded(threshold)` 文档承诺"callers that want to force a rotation check on a different threshold",但生产代码无 caller。

**Action**: 删除 (生产路径通过 `append()` 内联调用即可)。

---

## Finding 27-30: 其他 LOW (详细略)

| # | 描述 |
|---|---|
| 27 | `permissionModeGate.ts:20` mode 签名重复联合 |
| 28 | `telemetry.ts` 有独立 `tool_call` EventType 平行于 `eventLog.ts` |
| 29 | ADR-019 empty response `restarted: 0` vs `requested: 0` schema 不一致 |
| 30 | ADR-012 引用错误路径 (`workspaceWatcher.ts` vs `modules/workspaceWatcher.ts`) |

---

## Finding 31: Stale test counts in ADRs 041-044 (LOW, recurring)

**Source**: Peer audit (Audit ADRs 041-044) reported recurring pattern:

- ADR-041 line 57: "Plus all **4852** existing tests still pass" (stale)
- ADR-042 line 71: "Plus all **4853** existing tests still pass" (stale)
- ADR-043 line 74: "Plus all **4855** existing tests still pass" (stale)
- ADR-044 line 69: "Plus all **4856** existing tests still pass" (stale)

**Problem**: 实际测试数与 ADR 引用的不符。CLAUDE.md says ~4270 total tests。`r13-daemon-slash-command.test.ts` 只有 71 个 `it()` blocks,所有 `*.test.ts` 累计数千。

**Action**:
- 替换每行为 "all prior tests continue to pass" 或 "all tests in r13-daemon-slash-command.test.ts pass" — 不引用绝对数字
- 未来轮次:在写 ADR 时不引用精确数字,只引用"all existing tests pass"

---

## Finding 32: Worktree vs root 分歧 (informational)

**Source**: Peer audit

**Problem**: 同一份代码在不同 worktree 中可能不同步。该 peer 注意到它在 `agent-add2f86b0591762be` worktree 中,R38-R41 改动在 root checkout 才有。

**Action**: Phase 1 之前,确保 root checkout 状态正确(`git status` 应该干净)。如果有未提交改动,先 commit 提 PR,再开始 Phase 1。

---

## Finding 33: `/daemon workers` 运行时崩 (HIGH, 真实 bug)

**Source**: Peer audit (Cross-Caller Verification Report)

**Files & lines**:
- `src/commands/builtin.ts:3025-3029` — `/daemon workers` subcommand
- `src/core/daemon.ts:887` — `formatWorkers(workers: WorkerEntry[]): string`
- `src/core/daemon.ts:298-307` — `list-workers` R40 wrapper `{workers, total, offset, limit}`

**Bug**:
```typescript
// builtin.ts:3028 (现状)
return text(formatWorkers(res.data as never[]))
//                                    ^^^^^^^^^^
// R40 后 res.data 是 wrapper 对象,不是数组
```

`formatWorkers` 在 `daemon.ts:890` 用 `for (const w of workers)` 迭代 — 传对象会 throw `TypeError: object is not iterable`。

**运行时后果**:
- 0 worker:`workers.length === undefined` → 返回 'No workers registered.'(无错)
- 任何 worker:length === undefined(对象属性,非数组长度)→ 不短路 → `for...of` 抛错

**与 ADR-043 关系**:
- ADR-043 lines 50-52 明确说"所有 caller 需从 `res.data as WorkerEntry[]` 更新为 `res.data as {workers: WorkerEntry[]}`"
- 测试在 R40 已更新 (tests/daemon.test.ts:91, tests/r13-daemon-slash-command.test.ts:106-107)
- 但生产 caller `builtin.ts:3028` **未更新** — ADR-043 迁移清单漏了一项

**严重性**: HIGH — 用户面回归。`/daemon workers` 是 daemon 模块外唯一 IPC 消费者,现在崩了。

**Action**:
```typescript
// builtin.ts:3028
const wrapper = res.data as { workers: WorkerEntry[] }
return text(formatWorkers(wrapper.workers))
```

**附加**:加端到端测试 — 在 r13 测试套件里调 `/daemon workers`,断言输出含 worker 名。当前无此测试。

---

## Finding 34: `maxRestarts` 不传递到 bulk path (MEDIUM, 真实 bug)

**Source**: Peer audit

**Files & lines**:
- `src/core/daemon.ts:618` — `all` 路径递归调用 `handleCommand({action:'restart-worker', payload: {workerId: id}})`
- `src/core/daemon.ts:708` — `tag:` 路径同样递归
- `src/core/daemon.ts:734-740` — `maxRestarts` cap 只在单 worker 路径强制
- `src/commands/builtin.ts:3038` — `/daemon restart <id|all>` 也没暴露 `maxRestarts` 参数

**Bug**:
如果 caller 调 `{action:'restart-worker', payload: {workerId: 'all', maxRestarts: 1}}`:
- `all` 分支收集所有匹配 worker
- 递归调用只传 `{workerId: id}` — `maxRestarts` 被丢弃
- 每个子调用命中单 worker 路径,`rawMaxRestarts` 为 undefined → 默认 3
- **结果**: operator 设的 `maxRestarts: 1` 被忽略,每个 worker 实际允许 3 次重启

**测试覆盖 gap**:
- `tests/r13-daemon-slash-command.test.ts:1238, 1260, 1277` — R36 3 个测试都用 `w1.id` 单 worker
- **无 `{workerId: 'all', maxRestarts: 1}` 或 `{workerId: 'tag:cli', maxRestarts: 1}` 测试**

**严重性**: MEDIUM — 违反 ADR-039 stated purpose(防止 infinite restart loops)。operational risk:operator 配 cap 围栏坏 worker 但 bulk 重启绕开。

**Action**:
```typescript
// daemon.ts:618
const r = this.handleCommand({
  action: 'restart-worker',
  payload: { workerId: id, maxRestarts, concurrency, tag, status, exclude }
})
// daemon.ts:708 同样

// builtin.ts:3038
description: 'Daemon control. Usage: /daemon [status | workers | restart <id|all> [maxRestarts=N] | logs]'
```

加 bulk + maxRestarts 集成测试。

---

## Recommended Action Plan

### Phase 1: 立即清理 (≤ 1 小时,8 deletes + 11 edits)

```bash
# 1. 删除 5 个死模块
rm src/skills/marketplace.ts src/skills/marketplaceParser.ts
rm -rf src/core/daemon/
rm src/core/lspClient.ts
# + 删除 executionRunEvents.ts 死 bus (如未接线,8 类型 + 8 方法全删)

# 2. 删除 4 个死字段
sed -i 's/, consecutiveCommandFailures: 0//' src/core/loopEngine.ts
# 手动删除 loopSupervisor.ts:59 (lastCommit), 83/89 (writeTimeoutMs)

# 3. 修复 getModeBehavior (HIGH-19)
# 在 permissionSystem.ts:139 加 isBypassMode + bubble 分支

# 4. 修复 PermissionMode 联合重复 4 处 (MEDIUM-24)
# types.ts / permissionModeGate.ts / builtin.ts 改用 import

# 5. 合并双 retryable 正则 (HIGH,Audit 1 #4)
# modelGateway.ts:243 isRetryableProviderError 改 public
# coordinator.ts:1452 改调它

# 6. 创建 ADR-011 占位
echo "ADR-011 reserved but never written." > docs/ADR/011-reserved.md

# 7. 移除死 EventType
# eventLog.ts 删除 'user_input' | 'user_interrupt' (或接线 — 推荐接线)
```

### Phase 2: 文档修正 (≤ 2 小时)

- 更新 CLAUDE.md 顶部:8 deps / ~67k 行 / ADR 008-044 范围
- 重写 ADR-010 (SDK 而非 zero-deps)
- 更新 ADR-013 Layer 3 表格 ("L3 总是评估;deny 总是 win")
- 更新 ADR-014 模式列表 (7-mode)
- 修正 ADR-012 路径 (routingSignalCollector.ts:137)
- 修正 ADR-019 schema (`restarted` vs `requested`)
- ADR-013 Future Work 章节删除 (实际已接线)

### Phase 3: CHANGELOG 与深度修正 (≤ 1 天)

- 添加 R8-R41 CHANGELOG 章节
- `.ovogo` → `.ovolv999` 全量替换 (122→0 vs 52→122 切换)
- 路由信号真实化 (repoFileCount, budgetRemaining)
- 加 `llm_api` / `llm_api_usage_missing` EventType
- 删 `rotateIfExceeded()` 公开 API
- LongTermMemory 接线或删除 (446 行, MEDIUM)

### Phase 4: 长期 (R42+ borrowing)

- LongTermMemory R1-R6 接入引擎 (若不删)
- Hook async protocol
- Restart audit log unification
- Failure-recovery policy
- Cycle prevention at addWorker
- Windows 租约指纹降级 (其他 PID takeover)

---

## P2/P3 Backlog (CLAUDE.md) 状态总结

| 项 | 状态 | 建议 |
|---|---|---|
| permissionRules glob 引擎 | ✅ **DONE** (R9.2) | 文档化完成 |
| 持久层 subsystem 事件 | ❌ UNDONE (死接口) | 删除 bus (8 类型 + 8 方法) |
| LongTermMemory R1-R6 | ❌ UNDONE (446 行死) | 接线或删除 |
| 双 retryable 正则合并 | ❌ UNDONE (5 vs 7 模式) | 5 LOC 重构 |
| 死字段清理 (writeTimeoutMs, consecutiveCommandFailures, lastCommit) | ⚠️ PARTIAL (3 死) | Phase 1 删除 |
| 品牌目录收敛 (.ovolv999 vs .ovogo) | ❌ UNDONE (122 vs 52) | 大迁移 — Phase 3 |
| 路由信号真实化 (repoFileCount=filesTouched×10, budgetRemaining) | ❌ UNDONE | Phase 3 |
| Windows 租约指纹降级 | ⚠️ PARTIAL (own-process 行, takeover 不行) | Phase 4 |

---

## Verification

```bash
# Phase 1 完成后
npx tsc --noEmit          # 0 errors
pnpm lint                  # 0 errors
npx vitest run            # 4856/4856 (test count 不变,删除的是死代码)

# 死代码残留检查
grep -rn "consecutiveCommandFailures\|writeTimeoutMs\|lastCommit" src/  # 应为 0
ls src/core/daemon/        # 应为 No such file
ls src/core/lspClient.ts   # 应为 No such file
ls src/skills/marketplace* # 应为 No such file
grep -rn "user_input\|user_interrupt" src/core/eventLog.ts  # 应为 0 (或接线)

# getModeBehavior 验证
grep -A 3 "isBypassMode(mode)\|mode === 'bubble'" src/core/permissionSystem.ts  # 应有

# retryable 正则合并验证
grep -n "isRetryableProviderError" src/core/model/modelGateway.ts  # 应为 public
```

## File Targets Summary

**Delete (7 files / 1 dir + 4 dead fields + 1 dead API)**:
- `src/skills/marketplace.ts`
- `src/skills/marketplaceParser.ts`
- `src/core/lspClient.ts`
- `src/core/daemon/` (entire subdir)
- `src/core/executionRunEvents.ts` (if not wired — 8 unused types + 8 unused methods)
- `src/core/longTermMemory.ts` (if not wired — 446 lines + tests)
- `lastCommit` field (loopSupervisor.ts)
- `writeTimeoutMs` field (loopSupervisor.ts)
- `consecutiveCommandFailures` field (loopEngine.ts 3 places, loopSupervisor.ts)
- `rotateIfExceeded()` 公开方法
- `user_input` / `user_interrupt` (移除或接线)

**Edit (5 files code + 6 files docs)**:
- `src/core/permissionSystem.ts` (加 isBypassMode + bubble 分支)
- `src/core/types.ts` (PermissionMode 引用)
- `src/core/toolRuntime/permissionModeGate.ts` (PermissionMode 引用)
- `src/commands/builtin.ts` (isValidPermissionMode)
- `src/core/runtime/coordinator.ts` (LLM-usage EventType + 调 isRetryableProviderError)
- `src/core/model/modelGateway.ts` (isRetryableProviderError 改 public)
- `docs/ADR/010-anthropic-adapter.md` (重写)
- `docs/ADR/011-reserved.md` (new)
- `docs/ADR/012-014.md` (path/table updates)
- `docs/ADR/019-restart-worker-all.md` (schema fix)
- `CLAUDE.md` (dep count, scope)
- `CHANGELOG.md` (R8-R41)

**Total: 7 file/dir deletions + 12 edits** to fully remediate the HIGH+MEDIUM findings.

---

# Phase B: Comprehensive Doc-vs-Impl Drift (Audit 3 — 50+ findings)

## B.1: CLAUDE.md Subsystem 地图路径错 (LOW)

- `core/runtime/` 列表含 `queryStateMachine`, `eventLog` — 实际在 `src/core/` 顶层

## B.2: 调用链数字错误 (MEDIUM)

| 声明 | 实际 |
|---|---|
| "routing(11 信号)" | 17 signals (`routingSignalCollector.ts:38-60`) |
| "control_messages → parse" | 实际 `parse_response` 后续,缺 `continuation_check` |
| "50% snip" | 实际 `CONTEXT_MICROCOMPACT_PCT` (`compact.ts:215-222`) |
| "~45 种 RunEvent" | 实际 55 (`events.ts:26-95`) |
| `permissionRules.ts` "未接线" | **已接线** (`toolExecutor.ts:24` import) |

## B.3: 新 ADR 漂移

| ADR | 漂移 | 严重 |
|---|---|---|
| 005 | 只列 3/7 CompletionStatus,缺 7→6 mapping | MEDIUM |
| 010 | zero-deps fetch 描述,实际 SDK | **HIGH** |
| 011 | 缺 | MEDIUM |
| 012 | 路径错 + 依赖数 5 vs 8 | MEDIUM |
| 013 | Layer 3 描述与代码不符 | **HIGH** |
| 024 | statusFilter 描述 scalar,实际 string[] | MEDIUM |
| 027 | direct ID 过滤行为描述错误 | MEDIUM |
| 032 | selector pipeline 缺 `...parentLabels` 描述 | MEDIUM |
| 033 | 仍说"no restart history",但 ADR-037 加了 cumulative | MEDIUM |
| 035 | "one-level non-recursive" 与 ADR-036 矛盾 | MEDIUM |
| 040 | 自相矛盾 (starting→running→stopped→failed vs failed first) | MEDIUM |
| 042 | "Array.sort stability 不保证"陈旧 (ES2019+ stable) | MEDIUM |
| 044 | totalWorkers 描述不全 | MEDIUM |

## B.4: HOOKS.md (HIGH)

- **D1**: 5 事件表 vs 实际 9 事件 (缺 `SessionEnd, Stop, PreCompact, PostCompact`)
- **D2**: `PostToolUseFailure` 在 `hookProtocol.ts:14` 声明但无 `runPostToolUseFailure` — 静默 ignore

## B.5: LSP.md (HIGH)

- **D4**: 文档说"手写 JSON-RPC",实际用 `vscode-jsonrpc`
- **D5**: "<300 行" 实际 603 行
- **D6**: "intentionally minimal" 实际 5+ 方法 + diagnostics

## B.6: MCP-OAUTH.md (HIGH)

- **D9**: 文档说 `ovolv999 mcp list|auth|logout` CLI — 不存在

## B.7: DAEMON.md (HIGH)

- **D13**: 文档说 `--daemon*` flags — 实际是 `ovolv999 daemon <sub>` 子命令
- **D14**: 文档说 `<id>.jsonl` — 实际 `.meta.json` + `.turns.jsonl`
- **D15**: 文档说 HTTP,实际 Unix domain socket JSON-RPC
- **D16**: 文档说"JSON-RPC 2.0",实际自定义 op/id 格式

## B.8: PERMISSION-MODES.md (HIGH)

- **D21**: 文档说 `/mode <name>` — 实际是 `/permissions mode <name>`
- **D22**: `--permission-mode` CLI flag 不存在
- **D23**: Shift+Tab 描述但 key binding 未注册

## B.9: SANDBOX.md (HIGH)

- **D27-D32**: 文档描述 `core/shellSandbox.ts`,实际是 `core/sandbox.ts`
- `shellSandbox.ts` 是死代码 — 与 Finding 4 重叠

## B.10: ACP-WS.md (HIGH)

- **D37**: 文档说 5 个 notification 类型,实际只 emit `message/received` + `response{done:true}`

## B.11: TOOL-SEARCH.md (HIGH)

- **D44**: `discover:keyword` 描述为不标记 discovered,实际无条件标记
- **D45**: 文档说 deferred criteria,缺 "must not be a core tool" 门

## B.12: CHANGELOG.md (HIGH)

- R40 breaking change (response envelope) 无 Breaking 章节
- R41 default `limit=100` cap 未提
- R9-R12 permission 行为完全缺失
- R13-R39 daemon 功能完全缺失
- R8 行 10 与 `package.json` 矛盾 (5→8 deps)

## B.13: 终极总览

| 类别 | 数量 |
|---|---|
| Code findings (Phase A) | 34 |
| Doc findings (Phase B) | HIGH 12 + MEDIUM 18 + LOW ~25 ≈ 55 |
| **综合** | **~89 findings** |

## B.14: 推荐 Top 5 doc 修复(每条独立可执行)

1. **HOOKS.md** — 表格 + `PostToolUseFailure` (~20 min)
2. **SANDBOX.md** — 重写文档基于 `sandbox.ts` 实际行为 (~30 min)
3. **DAEMON.md** — 修正 CLI 路径 + socket 协议 (~30 min)
4. **PERMISSION-MODES.md** — `/mode` → `/permissions mode` + 删 `--permission-mode` (~15 min)
5. **LSP.md** — 修正 vscode-jsonrpc 实际 (~15 min)

---

# Phase C: Dead Code Final Inventory (Audit 2 — 13 new findings)

## C.1: 新发现的死模块(13 个文件,生产无 caller)

| 文件 | 行数 | 状态 |
|---|---|---|
| `src/core/autoDream.ts` | — | DEAD,CLAUDE.md 文档为"被动统计库,无 LLM" |
| `src/core/autoClassifier.ts` | — | DEAD,test only |
| `src/core/snipCompact.ts` | — | DEAD,test only — 不同于 /snip slash 路径 |
| `src/core/promptSuggestions.ts` | — | DEAD,test only |
| `src/core/fileDetection.ts` | — | DEAD,test only |
| `src/core/vcr.ts` | — | DEAD,test only |
| `src/core/imageInput.ts` | — | **DEAD,无任何引用** |
| `src/core/shellSandbox.ts` | — | DEAD,test only — 与 Finding 4 重叠 |
| `src/core/lspClient.ts` | 227 | DEAD,只 `tests/lspClient.test.ts` 引 |
| `src/skills/marketplace.ts` | 84 | DEAD,只自引 |
| `src/skills/marketplaceParser.ts` | — | DEAD,只自引 |
| `src/core/daemon/{daemonClient,daemonServer,sessionStore}.ts` | 617 | **WIRED(更正 Finding 2)** |
| `src/integrations/pipeMode.ts` | — | DEAD in production(只 test fixture) |

## C.2: 新发现的部分死

- `modelCapabilities.ts` 8 个函数 dead,只有 `ModelCapabilities` 类型用
- `core/hooks.ts`(legacy)vs `core/hooks/`(新)— 并行
- `core/daemon.ts`(legacy)vs `core/daemon/`(新)— 并行

## C.3: EventLog 死类型(更精确)

- 3 类型: `user_input`, `user_interrupt`, `workspace_change` (whitelisted 但不 emit)
- `executionRunEvents.ts`: 7 个 `emit*` helper + 8 个 `SubsystemEventType` 全 dead(只有 test)

## C.4: 修正 Finding 2

原审计说 `core/daemon/{daemonClient,daemonServer,sessionStore}.ts` 死 — **更正**:Peer audit 2 确认这些 wired (用于 `bin/ovogogogo.ts:1550, 1564, 1581`)。但与新 `core/daemon.ts` 并行。

## C.5: 最终综合(Phase A + B + C)

| 类别 | 数量 |
|---|---|
| 死模块 (死文件) | 11(原 5,新 8) + 2 部分(并行) |
| 死字段 | 3 |
| 死 API | 1(rotateIfExceeded) |
| 死 EventType | 3 |
| 死 EventLog subsystem | 7 emit helpers + 8 types |
| 死 modelCapabilities 函数 | 8 |
| 死 code 死文件(总) | ~16 files(~2500 行) |
| Doc drift | 55 |
| **综合 findings** | **~95** |

## C.6: 重排序 — Top 6 by ROI

1. **修 2 个真实 bug** (Finding 33+34) — 25 min, **HIGH ROI**
2. **删 11 个真死文件** (Phase A + C) — 5 min, **HIGH ROI**
3. **删 3 死字段 + 1 死 API** — 15 min
4. **修 `getModeBehavior`** — 20 min
5. **合并双 retryable 正则** — 5 LOC
6. **修 8 个 feature docs** — 3 hours,长尾 ROI
