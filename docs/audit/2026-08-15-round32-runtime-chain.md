# Runtime Main-Chain Hardening — 2026-08-15 (Round 32)

> **Scope**: 用户指定六项：真并发 Agent、运行期 steer、事务化 rewind、Windows containment、mtime 复用、todo 生命周期 + 内容寻址快照 + Bash 未跟踪变更。不扩功能面。
> **Result**: 302 files / 4,538 tests 全绿；独立复审抓到 4 个 must-fix（含旗舰特性 happy-path 撞名）全部修复。

## 1. AgentTool 真并发（审计结论：并行从未存在过）

前置审计证实：调度器只并行**声明 claims** 的工具，AgentTool 从未声明 → 每个 Agent 调用串行成单调用批次 —— 头注释/工具描述/协调者提示词承诺的 fan-out 全是假的，N 个子代理成本=全和。

修复：
- `metadata.claims`：modify → 每调用**唯一**独占键（各自 worktree，兄弟无竞争）；read_only → 共享 cwd 读 claim
- **复审 F1（must-fix）**：并行同 tick 同描述兄弟原先必撞 worktree 名（Date.now 零熵）→ 第二个 fail-closed blocked。修复：每调用 `invocationId`（randomBytes）同时喂 claim 键与 worktree 名
- E2E-P 证明：3 个并行 modify agent 经**真实引擎栈**（真实调度器并行批 → AgentTool → 子引擎 → 真实 git worktree → 互斥序列化合并），三个文件全部落基分支

## 2. Delivery/Git 独占（审计结论：合并零独占，只是被串行掩盖）

- **withGitMutex**（进程级 FIFO promise 链）：delivery 的 commit+merge+worktree-remove 全程持锁；持锁者拒绝不破链
- **复审 F6/F7**：父引擎自己的 git Bash（git:HEAD claim）与 delivery 互斥锁互不可见 —— git 变更命令（commit/merge/rebase/checkout/reset/revert/cherry-pick/pull/push/worktree）现在也走同一把全局锁

## 3. 运行期 Steer（审计结论：三层假接线——队列无读者、injectUserText 不存在、onSteered 从未接线）

- 链路：`engine.steer()` → `coordinator.injectSteer()` → ControlMessageLog(`steered_instruction`) → **下一次 LLM 调用**渲染为临时高优指令（不进持久历史）
- `steer()` 在无活动回合/无 live child 时返回 false——不再说谎
- AgentTool `liveChildren` 注册表：runTurn 期间注册、finally 注销、终态清理
- **顺带修复真 bug**：`controlMessageLog.clear()` 原在 LLM 调用**后**——调用中（流式期间）append 的消息被清掉永远无法送达。移到 render 后。这同时救活了原本必死的 provider_fallback 通知
- E2E-S：真实引擎栈上 3/3 子代理收到注入指令（fixture 断言 wire 上出现 steered_instruction）

## 4. 事务化 /rewind（preflight/stage/commit）

- `planRewind` 纯函数：全部计划（含边界检查）先算好，零副作用
- stage：恢复载荷先拷入 `rewind-stage/`——快照丢失/版本备份不可读在**动任何真实文件之前**失败
- commit：staged rename + 删除 + 锚点截断；失败按文件上报
- **复审 F11**：快照缺失恢复 Round 31 F7 的 tip 回退（计划层带 fallback version，staging 失败时降级恢复而非硬失败）
- **复审 F12**：staging 基础设施失败原先静默 ok:true 还照截锚点——现在诚实返回 aborted、零触碰
- F13：rewind-stage/ 目录泄漏（unlink 不能删目录）→ rmdirSync

## 5. 并行 worktree 语境下的真 bug（E2E 调试中挖出）

- **相对路径解析不一致（F20）**：Write 修过、Edit/Read/MultiEdit 未修——子代理相对路径 Edit 会写**父进程目录**，静默绕过 worktree 隔离。三工具统一按 `context.cwd` 解析
- **delegation 包装泄漏进意图分类**：[Delegation Contract] 样板里的 "architecture" 让每个子任务被判为 3-文件分析任务，纯写任务的子代理**永远无法 completed**（partial 死循环）。`extractTaskIntentText` 剥离包装只对分类器生效（LLM 仍见全文）；F23：effort profile 解析同修

## 6. 其余项

- **Windows containment**：输入先归一化再 dirname（POSIX dirname 对 `C:\` 路径得 `.`）；驱动器路径在 POSIX 宿主上不做 realpath/resolve（会 cwd 前缀化成垃圾）；NTFS 大小写不敏感比较
- **mtime+size 复用**：改为**内容校验**的复用（mtime+size+hash 三匹配才复用；粗 mtime 文件系统上的陈旧窗口关闭）
- **内容寻址快照**：快照文件名=sha256——跨文件/跨轮相同内容自动去重
- **Todo 生命周期**：`releaseScope` 于 engine.dispose；主引擎 todo.json 持久 + 下轮 ensureLoaded 再水合
- **Bash 未跟踪变更**：前后 workspace 清单 diff（限 20k 文件/16 深，skip-list），新建→markCreated、变更→trackEdit，150ms unref 延迟覆盖异步写盘；rm/sed -i/formatter/codegen 进入 rewind 覆盖
- 字节预算 compaction 保留

## 黑盒 E2E（tests/round32E2E + round32ParallelE2E，无引擎 mock）

| 场景 | 验证 |
|---|---|
| 3 并行 modify agent | 真实引擎栈全链（上文），文件落 base，git 状态无锁残留 |
| 运行期 steer | wire 级断言注入到达子代理的下一请求 |
| merge conflict | 真实 git 仓库双 worktree 并发 delivery——恰一胜一 blocked+冲突清单+分支保留，无 index.lock |
| 部分 rewind 失败 | 快照损坏：该文件失败、其余恢复、staging 清理 |
| Windows path | 反斜杠 layout 根推导、驱动器大小写、越界跳过 |

## 验证

tsc 0 错 · eslint 0 错（67 警告为继承风格）· **302 files / 4,538 tests** · build + verify-runtime-static + ESM + deadCodeCheck(0) 全绿。
