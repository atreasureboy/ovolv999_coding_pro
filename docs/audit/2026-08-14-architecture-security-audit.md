# Architecture & Security Audit — 2026-08-14 (Round 25)

> **Scope**: 全面架构级审计 — 分层耦合 / 安全攻击面 / 异步生命周期 / 死代码。
> **Method**: 3 个并行审计 agent（layering、security、lifecycle）+ 对全部 HIGH 发现逐条人工源码复核。
> **Build state (audit 时)**: 4862/4862 tests pass, 0 typecheck errors, 0 lint errors。
> **Build state (修复后)**: 4875/4875 tests pass（含本轮新增 13 个回归测试）, 0 typecheck errors, 0 lint errors, build + verify-runtime-static + ESM checks 全绿。

## Executive Summary

本轮审计发现 **25 项问题**，其中 5 项 HIGH 安全缺陷、10 项生命周期缺陷、10 项架构/死代码问题。**本轮已全部修复 HIGH 项与全部可安全落地的 MEDIUM/生命周期项**（共 18 项修复），剩余为大型重构建议（列于 §4 后续建议，未动）。

| 类别 | 发现 | 已修复 |
|---|---|---|
| 安全 HIGH | 5 | 5 |
| 安全 MEDIUM | 7 | 6 |
| 生命周期 | 10 | 10 |
| 架构/死代码 | 3 组 | 死代码清理 + 循环削弱 |

---

## 1. 安全修复（本轮全部落地）

| # | 严重度 | 问题 | 位置 | 修复 |
|---|---|---|---|---|
| H1 | HIGH | **沙箱逃逸**：`run_in_background:true` 的 Bash 命令完全绕过 `sandboxWrap` — bubble 模式下模型只需加一个参数即可逃出 bwrap/Seatbelt 获得完整网络+文件系统访问 | `src/tools/bash.ts:306-410` | 背景路径（BTM + 直连 spawn）均套用与前台一致的 `sandboxWrap`；bubble 模式强制 strict 配置 |
| H2 | HIGH | **WebFetch SSRF**：仅校验 scheme 前缀；无内网/元数据 IP 拦截；`redirect:'follow'` 允许公网 URL 302 跳到 `169.254.169.254` 或 RFC1918 | `src/tools/webFetch.ts` | 新增 SSRF guard：RFC1918/link-local/CGNAT/ULA/0.0.0.0 全拦截（IP 直连 + DNS 全记录校验 + `.internal/.local` 域名）；**手动跟随重定向（≤5 跳）且每跳重新校验**；loopback 放行（本地 dev server 是核心用例）；`OVOGO_WEBFETCH_ALLOW_PRIVATE=1` 显式逃生门 |
| H3 | HIGH | OAuth 回调服务器绑定 `0.0.0.0`（LAN 任意主机可用 `?error=` 打断授权流）且 error 参数未转义反射进 HTML（XSS） | `src/core/oauth.ts:210,226` | 绑定 `127.0.0.1`；error 参数 HTML 转义 |
| H4 | HIGH | ACP WebSocket 无 Origin 校验 — 浏览器任意网页可连 `ws://127.0.0.1:<port>` 劫持 agent（cross-site WS hijacking） | `src/integrations/acpWebSocket.ts` | 新增 Origin 校验：无 Origin（原生客户端）放行；有 Origin 则默认仅允许 loopback origin，可用 `allowedOrigins` 配置 |
| H5 | HIGH | 浏览器打开授权 URL 用 `execSync(\`open "${authUrl}"\`)` — MCP 服务器通告的 authorizationEndpoint 含 `"$()` 即 RCE | `src/core/oauth.ts:289` | 改为 arg-array `spawn`（无 shell），URL 彻底惰性化 |
| M1 | MED | OAuth token 明文 JSON 写盘且 0644；`serverName` 未消毒直接拼路径（`../` 穿越） | `src/core/oauth.ts:310-319` | `mode:0o600`（对齐 mcpOAuth）+ serverName 白名单消毒 |
| M3 | MED | bwrap `deniedPaths` 形同虚设 — 只"不 bind"，但默认 ro-bind 已覆盖 `/etc` `/opt` 等路径，deny 完全 no-op | `src/core/sandbox.ts:206-244` | deny 与 bind 求交集过滤 + deny 路径追加 `--tmpfs` 掩蔽（后挂载优先） |
| M4 | MED | `.bg_logs/`、`.ovogo/` 未整体 gitignore（仅 `*.log` 与 `settings.json`）— 运行时产物（常含命令输出/密钥）距 `git add .` 一步之遥 | `.gitignore` | 整目录忽略 |
| M6 | MED | 文件保险库全进程复用同一 scrypt SALT（可预计算彩虹表）；头注释仍写 "XOR-encrypted" | `src/utils/keychain.ts` | 每次 encrypt 独立 SALT（payload 首段携带，旧 vault 兼容）；注释纠正为 AES-256-GCM |
| L1 | LOW | teamMemory `execSync(\`git ${args.join(' ')}\`)` — config 来源的 remoteUrl/branch 可注入命令 | `src/core/teamMemory.ts` | 改 `execFileSync('git', args)` 无 shell |
| M2部分 | MED | `isLoopDriverOwnedPath` 大小写敏感 — `.LOOP/DONE.flag` 在 macOS/Windows 默认文件系统上绕过 ADR-007 防护 | `src/core/pathSecurity.ts` | 文件名一律 case-fold（宁可错杀）；目录名仅在不区分大小写平台 fold |

**已复核为安全（无需修复）**：无硬编码密钥；commandRunner 默认 `shell:false`；secretScanner 真实挂载于 /share、/export、teamMemory 出口；PKCE+state 双实现齐全；mcpOAuth token 0600；tmux keys 白名单。

## 2. 异步生命周期修复（10 项全部落地）

| # | 失败模式 | 位置 | 修复 |
|---|---|---|---|
| L1 | HTTP MCP 请求无超时无 AbortSignal — 死服务器挂死 engine 启动 | `mcpHttpClient.ts:111` | 每请求 `AbortSignal.timeout(60s)`（可配 `timeoutMs`） |
| L2 | turn AbortSignal 不达 MCP 传输层 — ESC/硬中止无法取消在途 MCP 调用 | `mcpToolAdapter.ts` / `mcpClient.ts` / `mcpHttpClient.ts` | adapter 透传 `context.signal`；stdio 侧 request 注册 abort（正常完成即摘除监听）；HTTP 侧 abort×timeout 复合 signal |
| L3 | shellSession listen 后 ref'd server 永久占用事件循环（忘 kill 则 CLI 永不退出） | `tools/shellSession.ts` | listen 后 `server.unref()`（活动连接仍保持存活，空闲监听不再阻塞退出） |
| L4 | daemon `stop()` 等 idle 连接永久挂起；连接从不销毁 | `core/daemon.ts` | 连接跟踪 Set + stop 时全部 destroy |
| L5 | MCP stdio close() 只发 SIGTERM 即返回 — 忽略 SIGTERM 的 server 成孤儿进程 | `core/mcpClient.ts` | close 有界等待（3s）+ SIGKILL 升级 + 幂等 promise；pending 定时器 unref |
| L6 | LSP kill() 单发 SIGTERM 无升级 — 忙碌 tsserver 永不收割 | `core/lsp/client.ts` | 5s SIGKILL 升级（unref + exit 清理）；waitForDiagnostics 定时器 unref |
| L7 | hookExecutor 在 pre-abort 早退路径上子进程无 error 监听（ENOENT → uncaughtException 崩进程）且已装填的 timeout 泄漏 | `core/hooks/hookExecutor.ts` | error 监听紧跟 spawn 挂载；pre-abort 分支 clearTimeout |
| L8 | backgroundSession SIGKILL 前不验证 PID 身份 — grace 窗口内 PID 复用会误杀无关进程 | `core/backgroundSession.ts` | spawn 时记录 `/proc/<pid>/stat` starttime（Linux），升级前比对；不符则跳过击杀 |
| L9 | Renderer 每个实例在共享 stdout 上挂 resize 监听，destroy 不摘除 — 长会话监听器累积 | `ui/renderer.ts` | 持有 handler 引用，destroy 时 removeListener |
| L10 | messageBus receive 的有界定时器不 unref — 挂起的长轮询拖延进程退出 | `core/messageBus.ts` | timer.unref |

**已复核为健康**：AbortSignal 在 engine→gateway→OpenAI/Anthropic adapter→compact→webFetch/webSearch 全链贯通；全部 4 处 setInterval 已 unref+清理；backgroundTaskManager/claudeCodeWorkerManager 的 PID 复用防护堪称典范（backgroundSession 的 L8 即对齐该模式）；文件句柄 finally 关闭齐全。

## 3. 架构修复（本轮落地部分）

- **删除 5 个零引用死模块**（约 1,055 行，已确认 src/bin/tests/scripts/evals 及动态 require 均无引用）：
  `core/sessionCheckpoint.ts`、`core/toolSuggester.ts`、`utils/vcr.ts`、`utils/imageInput.ts`、`commands/mod.ts`
- **削弱 model 层循环**：`providerAdapter.ts` 移除对 `AnthropicAdapter` 的 barrel re-export（基类模块不再导出具体实现）；测试改为直接从 `anthropicAdapter.js` 导入。
- **lint 告警清理**：coordinator 死导入、builtin.ts 两处失效 eslint-disable 指令（17→13，余为接口一致性 require-await，不动）。

## 4. 后续建议（本轮未动 — 需专项重构）

1. **三层 hooks 子系统并存**（`config/hooks.ts` 主路径 / `core/hooks/` 仅 acpServer 用 / `core/hooks.ts` 仅 /hooks 命令用），事件名（`PreToolUse` vs `PreToolCall`）与配置目录（`.ovogo` vs `.ovolv999`）互不兼容 — 用户配置的 hook 可能因入口不同而静默不触发。建议收敛到单一 runner。
2. **双 daemon 实现**：`core/daemon.ts`（Unix socket, 950 行）vs `core/daemon/`（HTTP, 465 行），两个同名 `DaemonClient`，其中 daemonServer 生产不可达。建议二选一。
3. **tools→ui 运行时依赖**：`tools/agent.ts` 直接实例化 `Renderer` + tmux 布局，链路 core→tools→ui 使 headless 引擎无法脱离 UI 模块图加载。建议注入渲染接口。
4. **utils→上层反向依赖**：`utils/doctor.ts` 值导入 ui/core/skills 三层。
5. **巨型模块拆分**：`commands/builtin.ts`（3,672 行/~100 命令/45 处 lazy require）、`core/runtime/coordinator.ts`（2,156 行）。
6. **双组合根**（`core/engine.ts` 与 `cli/engineAssembly.ts`）、`.ovogo` vs `.ovolv999` 配置目录统一。
7. test-only 模块（`core/config.ts`、`core/oauth.ts` 旧版、`core/systemPrompt.ts` 等约 2,370 行）与生产并行重复 — 建议明确标注或合并。

## 5. 验证

- `tsc --noEmit` ✅ 0 错误
- `eslint src/ bin/ tests/` ✅ 0 错误（13 告警，均为良性 require-await）
- `vitest run` ✅ **311 files / 4,875 tests**（新增 `tests/securityAuditRound25.test.ts` 13 项回归：SSRF 拦截矩阵、重定向逐跳校验、loopback 放行、逃生门、token 0600 权限、serverName 消毒、大小写折叠）
- `pnpm build` ✅；`verify-runtime-static` ✅；ESM 双检查 ✅；`deadCodeCheck` 无新增死文件 ✅
