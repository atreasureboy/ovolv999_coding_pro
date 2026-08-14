# Architecture & Security Audit — 2026-08-14 (Round 26, "对齐并超越 Claude Code")

> **目标**: 用户明确定位 — 对标并超越 Claude Code。本轮在 Round 25 基础上**完成全部遗留架构整合 + 清零安全残留**，并以两个独立审计 agent 复审本轮变更（复审发现 12 项缺陷，全部修复）。
> **Method**: 逐项核实 → 实施整合 → 双 agent 交叉复审 → 缺陷全修 → 全链验证。
> **Build state**: tsc 0 错误 · eslint 0 错误（24 警告均为良性 require-await/接口一致性）· **296 files / 4,511 tests 全过** · build + verify-runtime-static + ESM 全绿。

---

## 1. Hooks 子系统统一（Round 25 遗留 #1 — 最重要的一项）

**复审发现比 Round 25 认知的更严重**：主 REPL 路径（engineAssembly → config/hooks.ts HookRunner）用的是**能力更弱**的 runner — 它不实现 `runPreToolUse`/`runSessionStart`/`runStop`/`runPreCompact`，而 engine（toolExecutor/coordinator）**优先调用这些 Phase-2 方法**。即：Claude-Code 式 hooks（含 **hook 权限决策 allow/deny**）在主路径上从未生效，只在 ACP server 路径生效；两套 loader 还用不同 schema 解析**同一个** settings.json。

**整合方案（全部落地）**：
- **ONE runner**: `core/hooks/DefaultHookRunner`（CC JSON 协议、权限决策、SessionStart/Stop/PreCompact）成为唯一 runner；engineAssembly 与 acpServer 汇聚同源。**删除** `config/hooks.ts`（弱 runner）与 `core/hooks.ts`（legacy ~/.ovolv999/hooks.json）。
- **ONE parser**: `normalizeHooksSection`（hooksConfig.ts）成为 "hooks" 配置块唯一解析器 — 同时接受 CC schema（`{matcher, hooks:[{type:'command',command,timeout}]}`）与 legacy 平铺（`{matcher, command}`）；事件名别名映射 `PreToolCall→PreToolUse`、`PostToolCall→PostToolUse`、`OnComplete→Stop`、`OnContextOverflow→PreCompact`。settings.ts loadSettings 与 loadHookConfig 同源，**两套入口解析行为从此一致**。
- **结果**: Claude Code 的 settings.json hooks 配置**可直接拷入即用**（含 hook 输出 `permissionDecision: deny` 阻断工具调用）— 主路径、ACP、子 agent 全部生效。这是对 CC 的**协议级兼容**。

**复审缺陷修复（12 项）**：
| # | 缺陷 | 修复 |
|---|---|---|
| D1 HIGH | hook 子进程 stdin EPIPE 无监听 → 不读 stdin 的 hook（echo/printf）可**崩掉整个 CLI**（本轮把该 runner 接上主路径后成为主路径风险；测试套件自身复现 `errno:-32`） | hookExecutor 挂 stdin 'error' 监听 |
| D2 HIGH | legacy matcher 语法（`Write,Edit` 逗号表、`Bash*` 前缀）在统一后静默失配 | matcherMatches 支持逗号/管道表 + 尾 `*` 前缀 + `/regex/`，回归测试锁定 |
| D3 HIGH | legacy `OVOGO_*` 环境变量契约丢失（旧 hook 读 `$OVOGO_TOOL_NAME` 等拿到空值） | executeHookCommand 注入全套 back-compat 环境变量；settings.ts 文档同步改写 |
| D4 MED | 未知/拼写错误事件名静默死配置；`OnError` 无映射静默死；`__proto__` 键可污染原型 | 事件名白名单校验 + 诊断（OnError 明示迁移到 PostToolUse）；危险键拒绝 |
| D5 MED | /hooks list 显示合并视图索引，remove 却按 project 数组删 — **删错条目** | list 分 project（编号、可变）/ user（只读）两段，索引仅指 project |
| D6 MED | ask 权限 fail-closed 后 --classic 交互 REPL 无法批准 | classic 前端接入共享 readline 批准提示（真正 headless 仍 fail-closed） |
| D7 MED | SessionStart 每轮触发（CC 语义为每会话一次） | DefaultHookRunner 单次触发门控 |
| D8 MED | UserPromptSubmit bin+coordinator 双触发 | 统一由 coordinator 单点分发 |
| D9 LOW | `security -i` 脚本对含换行 secret 的命令注入 | 拒绝含换行值；`-w` 置行尾（macOS 实机待验证） |
| D10 LOW | strict Seatbelt 缺 `(allow process-fork)` — 管道/make 类进程被杀 | 补齐 |
| D11 LOW | `df` 去掉 shell 管道后解析了表头行 → 磁盘检查恒 NaN | 取末行解析 |
| D12 LOW | agent.ts 降级路径 `childRenderer.destroy()` 可能销毁**父** renderer | destroy 加 paneSlot+factory 守卫 |

## 2. Daemon 子系统统一（Round 25 遗留 #2）

- **删除** HTTP 三件套 `core/daemon/{daemonServer,daemonClient,sessionStore}.ts`（生产从未启动 server；`daemon ps` 永远空表、`daemon attach` 永远报缺端口 — 纯属摆设）。
- bin `daemon ps/attach/kill` 全部改接到**真实会话系统** `core/backgroundSession.ts`（与顶层 ps/attach/logs/stop/rm 同源）；`daemon kill` 现先 `stopSession` 再删元数据（不再留孤儿进程）。Unix-socket Daemon（/daemon 工作进程注册表）保留。

## 3. 分层解耦（Round 25 遗留 #3/#4）

| 边 | Round 25 | Round 26 后 |
|---|---|---|
| core → ui | 12 条（1 值 + 11 类型） | **0** |
| tools → ui | 2 条值 | 0 值（仅 askUser 一条类型边界契约） |
| utils → 上层 | 3 条值（doctor） | 0 值（doctor 移入 commands/；仅 sessionExport 一条类型） |

手段：`RendererInterface` 迁入 `core/types.ts`（ui 反向 re-export 兼容）；`tmuxLayout`（纯进程管理，非渲染）ui→core；AgentTool 的 `Renderer.forFile` 改为组合根注入 `createFileRenderer`（engineAssembly 注入，headless 嵌入可不带 UI 模块图）。

## 4. 安全残留清零（Round 25 L 级全部处理）

- **L1 全批**：systemHealth/ide/lsp/diffBrowser 所有 `execSync` 字符串拼接改 arg-array `execFileSync`（含 IDE 打开文件/差异的路径注入面）。
- **L2**：ShellSession 反弹 shell 监听加**逐会话 token 握手**（首行 `auth <token>`，15s 超时，错则断连）— 本地任意进程无法再冒充 shell 侧伪造 agent 输入。
- **L3**：settingsSync 明文 push 前强制 secretScanner，命中拒绝并提示改用口令加密。
- **L4**：ask 权限无提示处理器时 **fail-closed**（对齐 CC 非交互契约；classic 交互前端另行接 readline 批准）。
- **L5**：`OVOLV999_SSH_STRICT_HOST_KEY=1` 可切严格主机密钥校验。
- **L7**：macOS Seatbelt profile 改标准形态（`(deny default)` + `import system.sb`）— 原非标准指令在现代 sandbox-exec 上整 profile 编译失败，沙箱形同虚设。
- **M6**：macOS keychain 写入改 `security -i` stdin 协议（secret 不再进 argv 被 `ps` 窥视）。
- **M7**：Google 搜索 key 移入 `X-Goog-Api-Key` 头；错误文本经 `redactSecrets`（key=/api_key=/Bearer/sk- 模式打码）后才入 transcript。
- **M2**：fileRead/fileWrite/fileEdit/multiEdit 全部接入 NUL 字节拒绝。

## 5. 死代码清除（复审 agent 逐项核实零引用后删除）

本轮删除 **14 个模块 + 对应测试**（约 4,600 行）：hooks 双轨（config/hooks、core/hooks）、HTTP daemon 三件套、Round 25 遗留 7 个 test-only 文件（core/config、systemPrompt、shellSandbox、skillSearch、pluginManager、migrations）、复审新发现的 7 个（ui/thinkingDisplay、statusLineCustom、markdown、vim、statusLine；core/syntaxHighlight、**core/oauth** — 生产 OAuth 实为 integrations/mcpOAuth，Round 25 修的 core/oauth 原来是死代码，本轮连根删除）。

## 6. 复审确认的架构状态

- 交叉层值导入：**零**（仅存 2 条类型边界契约 + core→config/diagnostics 的 4 条 warnConfigOnce、core→integrations/mcpOAuth 1 条 — 中间层内聚，可接受）。
- madge 循环：3 条全为类型边（无运行时环）。
- `daemon start`/组合根/注入链全部验证正确。

## 7. 明示的后续项（非缺陷，已评估取舍）

1. `commands/builtin.ts`（3,672 行）与 `runtime/coordinator.ts`（2,156 行）拆分 — 纯机械重构但 45 处 lazy require 的**运行时路径**类型系统无法校验，需专轮 + 每命令 dispatch 冒烟，本轮刻意不动。
2. `.ovogo`（配置）与 `.ovolv999`（缓存/数据）双目录 — 迁移属破坏性变更，维持现状并在 daemon help 中如实标注。
3. macOS 实机验证项：`security -i` 交互协议（D9）、strict Seatbelt profile（D10）。
4. `scripts/deadCodeCheck.sh` 误报率 105/112 — 检测器本身需重写（不识别 require/多级相对路径/bin）。

## 8. 验证

- `tsc --noEmit` ✅ 0 错误；`eslint` ✅ 0 错误
- `vitest run` ✅ **296 files / 4,511 tests**（净变化反映死代码测试删除与新增回归）
- 新增回归：`tests/round26.test.ts` 9 项（别名归一化、CC schema 存活、Phase-2 权限决策 deny、matcher 语法兼容、事件校验/OVOLV999 诊断、OVOGO_* 环境契约、EPIPE 不崩、shell token 握手拒/收）
- `pnpm build` ✅ · `verify-runtime-static` ✅ · ESM 双检查 ✅
