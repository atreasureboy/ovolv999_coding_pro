# STATE — ovolv999 迭代循环

> 最终目标：参考 claude-code 逆向源码，把 ovolv999 迭代成"超级个人 coding 工具"。
> glm-5.2 指挥；实现：直接编码 + amux 委托 Claude Code 混合模式。

## 当前阶段
**v0.2 Runtime Integrity 推进（six_goal Phase 3/4/6.1）**（2026-07-23）。参考 GPT-5.6 的 six_goal.md 建议，先全面核实其论断（非猜测），再实施高价值有界改进；大项（Provider/CommandRunner/SQLite/Eval/CI）写入 docs/V0_2_RUNTIME_INTEGRITY.md 作为 v0.3 milestone。

## 当前目标适配度：约 93%

### 本轮修复（six_goal 驱动）
- **Phase 3** ResourceScheduler 成为唯一调度源：`partitionToolCalls` 改为 claims 驱动，**删除 LEGACY_CONCURRENCY_SAFE_TOOLS 白名单**；无 claims 工具默认串行（§六.3）；新增 `claimsConflictBetween` 批量冲突谓词
- **Phase 4** AgentTool.cancel 真正终止运行中子 agent：新增 `childAborts` (runId→abort) 映射，cancel(runId) 调 `childEngine.abort()`（原仅改 registry 状态，不真正取消）
- **Phase 6.1** 修复消息语义：compaction summary 从 `role:user` 改为 `role:system`（运行时上下文非用户输入），**删除伪造的 synthetic assistant ack**（把话塞进 assistant 嘴里）
- **Phase 0** 新增 `docs/V0_2_RUNTIME_INTEGRITY.md`（真实调用图 + 名义vs实际 + 双轨实现 + exec 旁路 + 修改计划 + 兼容风险）

### six_goal 核实结果（非猜测）
- ✓ 已满足：coordinator 无 provider 分支、max_iterations→blocked、EventStore 写失败不吞
- ✗ 本轮修复：legacy 白名单（Phase3）、cancel 不生效（Phase4）、compaction 伪造（Phase6.1）
- ✗ 确认未接入：ModelGateway 直接调 OpenAI SDK，ProviderAdapter 平行未用（Phase1，v0.3）
- ⚠ 部分残留：coordinator nudges/critic/snip 仍 role:user（Phase6.1 余项，v0.3 InternalControlMessage）

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
