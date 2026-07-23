# STATE — ovolv999 迭代循环

> 最终目标：参考 claude-code 逆向源码，把 ovolv999 迭代成"超级个人 coding 工具"。
> glm-5.2 指挥；实现：直接编码 + amux 委托 Claude Code 混合模式。

## 当前阶段
**架构审计 + 全面修复完成**（2026-07-23）。本轮基于对 five_goal Runtime 主链的全面架构审计，修复了审计发现的所有 P1 与可修复 P2 问题。

## 当前目标适配度：约 92%

### 本轮修复（架构审计驱动）
- **P1-1** `claudeCode.ts:630` 死代码三元式：新增 `runTasks` Map 持久化 taskId，detached→wait 路径不再退化为 `^[DONE]$` 陈旧哨兵匹配
- **P1-2** `engine.runTurn` 增加 `parentRunId` 参数 + loopEngine 透传 loopRunId → 修复 loop→turn Run 树断链（turn 不再是孤儿）
- **P1-3** 构造器末尾调度 `recoverWorkers()`（in-flight merge）→ external_worker 不再永久卡 `recovery-pending-reattach`
- **P1-6** sandbox 接入 BashTool 前台执行路径（opt-in，`~/.ovolv999/sandbox.json` enabled 才生效，默认 passthrough）
- **P1-7** lint 门禁恢复绿色：0 error（原 741 error）。type-strictness/死代码/风格债降为 475 warning（可见、非阻断、增量清理）
- **P2-6** `maybeCompactWithInvariants` 接入生产压缩路径（evaluateBudget + reactiveCompact）
- **P2-7** 新增 GAP-C.4 测试覆盖 parentRunId 透传
- **P2-8** 删除误提交的 `nul` 文件
- **P2-9** `claimSoftAbort` 去重到 SharedRuntimeState（engine + coordinator 两副本合并）
- **P2-1** engine.ts 头注释诚实化（"thin facade" → "assembly root + lifecycle facade"）
- README 能力矩阵诚实化（§3 事件持久化优先、§5 WorkerAdapter 全生命周期 + /workers 直连）

## 本轮证据
- `npx tsc --noEmit` → **0 error**（exit 0）
- `npm run lint` → **0 error / 475 warning**（exit 0；baseline 为 741 error）
- `npx vitest run` → **174 files / 3887 tests passed**（exit 1 仅因预存 lspClient ENOENT 环境错误，无断言失败；baseline 3885 → +2 新测试）
- `git status` → nul 已 `git rm`；改动覆盖 engine/coordinator/claudeCode/loopEngine/contextManager/sharedState/bash/sandbox/eslint.config/README + 2 测试

## 当前 P0
- 无

## 当前 P1
- 无

## 已知 P2（未修复，低风险/延后）
- `no-unused-vars` 56 处死 import/局部（lint warn，非阻断，与死代码清理重叠，按需清理）
- `consistent-type-imports` 48 处（builtin.ts 惰性 require 模式伴生，保留以避免 49 处高风险转换）
- 模块级全局状态（todo/fileState/shellSession/modes 单例）— 并发子 agent 场景风险，单进程低风险
- `/workers` 命令直连 Manager（未走 WorkerAdapter）— 交互模式有效；程序化生命周期经 WorkerAdapter
- EventBus in-process `.on()` 无生产订阅者（持久化已生效，订阅为扩展点）
- `sharedState.modelState` 富字段（provider/capabilities/contextWindow/maxOutput）声明未填充（无 live bug，未被读取）
- lspClient.test.ts 需 `/nonexistent/server-binary`（预存环境错误）

## 下一步
1. 死代码清理（no-unused-vars 56 处，与 P2-2 重叠，可按文件渐进）
2. 若需 Worker Steering 交互化：`/workers` 改走 WorkerAdapter（start/status/steer/cancel/collect）
3. 若需事件驱动 UI：Renderer 订阅 EventBus（替换直接调用）
