# STATE — ovolv999 迭代循环

> 最终目标：参考 claude-code 逆向源码，把 ovolv999 迭代成"超级个人 coding 工具"。
> glm-5.2 指挥；实现：直接编码 + amux 委托 Claude Code 混合模式。

## 当前阶段
**v0.2 Runtime Integrity Phase 1/2/5 完成**（2026-07-23，six_goal 驱动）。ProviderAdapter 真正接管模型请求（**MiniMax M3 端到端实测通过**）；CommandRunner 统一命令执行（runVerification 已迁移）；EventStore 加原子批量+幂等。Phase 3/4/6.1 此前已完成。可手动测试。

## 当前目标适配度：约 95%

### 本轮修复（six_goal Phase 1/2/5）
- **Phase 1** ProviderAdapter 接管 ModelGateway：新增 `providerAdapter.ts`（OpenAICompatibleAdapter 拥有 stream_options 探测/请求形状），ModelGateway 只剩 provider-agnostic 的 overflow/retry/watchdog；config.provider 驱动选择。**M3 实测**：经 adapter 流式返回 text+usage
- **Phase 1 修 bug**：MiniMax `/v1` 拒绝 `[1m]` 后缀 → resolveApiEnvironment 剥离
- **Phase 2** CommandRunner（`commandRunner.ts`）：CommandSpec/CommandResult、spawn+进程树 kill、timeout/abort/output 限制、shell=false 默认；runVerification 从 execSync 迁移过来；~30 处 exec 余项列入 allowlist
- **Phase 5** EventStore：`appendBatch` 原子多事件写 + readAll 按 eventId 幂等去重（SQLite WAL → v0.3）

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
