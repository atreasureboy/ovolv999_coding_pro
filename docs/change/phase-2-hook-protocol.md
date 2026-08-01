# Phase 2 变更记录 — Hook 协议

> 审计追踪:Phase 2 引入 Hook 控制回路(PreToolUse / PostToolUse)。所有大修改前都有此记录。

## 范围

从 claude-code 移植 hook 协议(JSON stdin/stdout 子进程),接入 ovolv999 的:
- `ToolContext` / `IHookRunner` 接口扩展
- `ToolExecutor` 在工具执行前后调用 outcome 接口
- `ControlMessageLog` 注入 hook 提供的 `additionalContext`(下一次 LLM call 携带后立即 clear,不污染用户历史)
- 默认 `DefaultHookRunner` 实现,加载 `<cwd>/.ovogo/settings.json` 与 `~/.ovogo/settings.json` 的 `hooks` 块

## 新增文件

| 文件 | 职责 |
|---|---|
| `src/core/hooks/hookProtocol.ts` | Hook 类型 + JSON 解析(`parseHookOutput`) |
| `src/core/hooks/hooksConfig.ts` | `loadHookConfig` / `matcherMatches` / `matchersForEvent` |
| `src/core/hooks/hookExecutor.ts` | `executeHookCommand` / `executeHooksParallel`(spawn shell + JSON stdin/stdout + timeout + abort) |
| `src/core/hooks/defaultRunner.ts` | `DefaultHookRunner implements IHookRunner` |
| `tests/core/hooks/hookProtocol.test.ts` | 类型解析 / 拒绝非法输入 |
| `tests/core/hooks/hooksConfig.test.ts` | 配置加载 / matcher 匹配 |
| `tests/core/hooks/hookExecutor.test.ts` | spawn / timeout / abort 集成测试(用真实 `node -e` 脚本) |

## 修改文件

| 文件 | 变更 |
|---|---|
| `src/core/types.ts` | `IHookRunner.runPreToolCall`/`runPostToolCall`/`runUserPromptSubmit` 返回类型扩展为 `HookResult[] \| Promise<HookResult[]>`(向后兼容 sync 与 async);新增 `PreToolUseOutcome` / `PostToolUseOutcome` 接口;新增 `runPreToolUse?` / `runPostToolUse?` 可选 outcome 方法 |
| `src/core/toolRuntime/toolExecutor.ts` | 替换 `runPreToolCall` 调用 → 优先 `runPreToolUse` outcome,deny/modify 实际生效,additionalContext 收集到 `executor.deps.contextManager` 旁的 hook context 通道(后续 P2.6 接 ControlMessageLog) |
| `src/core/runtime/internalControlMessage.ts` | 新增 `'hook_additional_context'` 类型 + `renderForProvider` 时携带 |

## 协议对齐

与 claude-code `src/utils/hooks.ts` 兼容:

| 字段 | 我们的实现 | claude-code |
|---|---|---|
| 输入协议 | JSON 写 stdin,关闭 | 同 |
| 输出协议 | JSON 单对象 stdout(或视为 stdout 文本) | 同 |
| 事件类型 | 9 种(PreToolUse/PostToolUse/PostToolUseFailure/UserPromptSubmit/SessionStart/SessionEnd/Stop/PreCompact/PostCompact) | 27+ 种 |
| `hookSpecificOutput.hookEventName` | 支持 PreToolUse / PostToolUse / UserPromptSubmit / SessionStart | 支持全部 |
| `permissionDecision` | allow / deny / ask | allow / deny / ask |
| `updatedInput` | Record<string, unknown> | 同 |
| `additionalContext` | 字符串注入下次 LLM call | 同 |
| 异步 hooks | **未支持**(`{async: true}` 协议延后,同步阻塞覆盖 90% 场景) | 支持 |

## 与现有反假成功纵深的协调

- Hook outcome 的 `deny` 走和 `policyError` 相同的路径:`ToolResult { isError: true, content: reason }`,不进用户历史
- Hook 的 `additionalContext` 通过新加的 `'hook_additional_context'` 内部消息类型在 `ControlMessageLog` 中暂存,**`renderForProvider()` 时携带到 LLM,** 之后 `clear()`(对齐内部控制消息 10 类机制的不污染用户历史原则)
- Hook 永远 best-effort,失败不抛(任何 `Promise` reject / spawn 异常都包成 `HookResult.error`)

## 测试覆盖

- `hookProtocol.test.ts`:Hook 输入/输出解析、字段提取、拒绝非法 JSON、必需字段检查
- `hooksConfig.test.ts`:配置加载、matcher 字符串/regex、跨 settings.json 合并、空配置返回 null
- `hookExecutor.test.ts`:用真实 `node -e` 子进程跑 happy path / timeout / abort

## 不在 Phase 2 范围

- Prompt-based hooks(`{ type: 'prompt' }`)— 本次只做 command hooks
- HTTP hooks / webhook callback — 本次不做
- Async response 协议(`{async: true}`)— 同步阻塞 + timeout 覆盖 90% 用例,后续按需补
- Hook UI 配置界面 — 留给后续 Phase
- SessionStart 自动加载 settings(`onDynamicSkillsLoaded` 风格)— 不在本阶段

## 验证方式

- `npx tsc --noEmit`
- `pnpm lint`
- `npx vitest run` 全套
- **行为验证需用户手动**:在 `~/.ovogo/settings.json` 加 `hooks.PreToolUse.Bash` 拦截 `rm -rf`,启动 ovolv999,观察 hook 输出

## 升级影响

- **向后兼容**:既有的 `IHookRunner` 实现(sync `runPreToolCall` 等)继续工作,因为返回类型扩展为 `HookResult[] | Promise<HookResult[]>`
- **新接口可选**:`runPreToolUse?` / `runPostToolUse?` 标 `?`,未实现时 ToolExecutor 退回 legacy 行为
- **配置 opt-in**:不创建 `<cwd>/.ovogo/settings.json` 中的 `hooks` 块时,DefaultHookRunner 是 no-op,行为零变化

## 风险

| 风险 | 缓解 |
|---|---|
| Hook 命令卡死转圈 | timeout + AbortSignal 双保险,默认 60s,可 per-hook 配置 |
| Hook 输出损坏导致 OOM | stdout 1MB 上限,超出截断 |
| Hook 命令被 LLM 看到 | `CANDIDATE_DONE.flag` 的 Driver/Model 分离机制已经存在(ADR-007),hook 不写 `.loop/` |
| Hook 反复调用 `rm -rf` 自我死锁 | hook 进程独立,从父进程 cwd 而非 `.loop/`,且 .loop/ 4 个 driver-owned 文件已被 isLoopDriverOwnedPath 锁死 |
