# HEAD Audit — 2026-08-15 (Round 30)

> **Scope**: 用户指定的四个疑点 + 独立复审 + 真实 CLI E2E。不扩架构、不大规模重构。
> **Result**: 四项疑点**全部证实为真 bug 并修复**；独立复审又发现 3 项（1 项复现级）并修复。299 files / 4,512 tests 全绿。

## 1. Anthropic 计量（用户疑点 ①— 属实）

| 缺陷 | 证据 | 修复 |
|---|---|---|
| `message_delta.usage` 按**增量**累加 | anthropicSse: `outputTokens += …`。API 契约是**累计值**（message_start 已播种 3，delta 携带最终 50）→ 每次 53 起步；多 delta 后端（running totals）灾难性超计 | 赋值（last-wins），`typeof === 'number'` 守卫 |
| **双重 final usage** | message_stop 与 finalizeWithUsage 各发一个 usage chunk。overwrite 型消费者侥幸正确，任何累加型消费者双计 | 单一发射点（finalize）；message_stop 只带 finish_reason |
| **cache 字段在 SDK→translator 适配层被剥掉**（E2E 抓出） | adaptEventRecord 只透传 input/output —— 缓存总量被当普通 input 计费，R27 的缓存省钱对真实 SDK 流**从未生效** | cache_read/cache_creation 透传 |

E2E-1（真实子进程：真实 SDK client + 真实 HTTP fixture + 真实 StreamConsumer + 真实 CostTracker）锁定：outputTokens=50（非 53）、prompt=7000、cacheRead=4000、saved>0。

## 2. /rewind turn 语义（用户疑点 ②— 部分属实）

- **新建文件**：`trackEdit` 对不存在路径是 no-op → 一次性写入的新文件对 /rewind 完全不可见；rewind 到创建前也不删。修复：checkpoint 记录累计 `createdFiles` + 每文件版本数（含 0）；rewind 时"未来锚点 createdFiles − 目标锚点 createdFiles" = 创建于锚点之后的文件 → **删除**；创建于锚点前但后续编辑过 → 恢复首次写入内容（count 0 → restore versions[0]）。
- **删除文件**：曾编辑过的文件被 rm 后 rewind 可复活（restoreVersion 原子重建）；从未编辑过的 rm 文件不可恢复（FileHistory 固有限制，注释明示）。
- **未来分支残留**（属实）：rewind 后 4、5 号锚点残留，再次 rewind 可能命中描述已不存在时间线的旧锚点。修复：rewind 成功即原子截断 JSONL 至第 N 锚；截断失败时**如实告警**（复审 C3：首版静默谎报成功）。

## 3. Checkpoint 读写效率与保留（用户疑点 ③— 属实）

appendCheckpoint 原先每轮 `listCheckpoints` **全量读取+解析**。修复：
- 编号走 **tail-read**（末 8KB，读最后完整锚点，readSync position 参数正确）；
- 撕裂尾行隔离（末字节非 `\n` 先补行，防止下一次 append 与残片合并双丢——测试复现过）；
- 保留：size > 200KB 时原子压缩保留最新 450（每 ~50 锚一次全量读，均摊 O(1)）。

## 4. TodoStore 多 session 污染（用户疑点 ④— 属实）

module-global 数组 → 同进程多引擎（主 agent + AgentTool 子 agent）互相覆盖清单、提示词注入错乱。修复：**按 sessionDir 键控**（无 dir 引擎共享 legacy `''` 桶，单引擎行为不变）。复审确认：coordinator 与 ToolContext 注入同值、子 agent（sessionDir=undefined）隔离成立。

## 5. 独立复审发现（全部修复）

| # | 发现 | 严重度 | 修复 |
|---|---|---|---|
| D | **复现级**：fileWrite 在写入**前**标记 createdThisSession → 写失败后用户在同路径手工建文件，rewind 会**静默删除用户文件**（agent 以 /tmp PoC 复现） | 高 | `markCreated()` 只在 atomicWrite 成功后调用；trackEdit 恢复纯 no-op |
| C3 | 截断写失败时仍报告 "Dropped N checkpoints" 且 ok:true | 中 | 失败时 truncated=0 + WARNING 提示锚点仍陈旧 |
| E | ToolContext.sessionDir 仅靠 WorkspaceModule patch 注入 —— 项目配置 enabledModules 去掉 workspace 时 todo 双脑（工具写 '' 桶、提示词渲染 session 桶） | 中 | boot.ts ToolContext 直接 `sessionDir: config.sessionDir` |
| nit | translator 死代码 `chunks` 数组无界累积（每流）；tail 片段校验过松（`{"turn":99}` 残片会抬号） | 低 | 删除数组；tail 校验对齐 listCheckpoints 三字段 |

## 6. 真实 E2E（tests/round30E2E.test.ts，非 mock）

- **E2E-1** 真实子进程跑真实 AnthropicAdapter(SDK)→StreamConsumer→CostTracker，对真实 HTTP SSE fixture —— 锁定累计语义 + 缓存计费链。
- **E2E-2** 真实 CLI 子进程（provider=anthropic 走真实配置门），断言**上线请求体**带 3 个 cache_control 断点。
- **E2E-3** 真实 CLI 非 TTY 单轮（scenario-a：真实 Write+Bash）→ 真实 session 产物（checkpoints.jsonl 锚点含 created 文件记录）→ 真实 rewind 恢复/删除/截断。顺带补齐：runSingleTask 此前**不写锚点**（只有 REPL 写）——非交互运行可 resume 却不可 rewind，已接线。

## 验证

tsc 0 错 · eslint 0 错（33 警告为继承风格）· **299 files / 4,512 tests**（+9 round30 回归 +3 E2E）· build + verify-runtime-static + ESM + deadCodeCheck(0) 全绿。
