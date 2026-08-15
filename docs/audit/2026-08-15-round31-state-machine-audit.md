# Deep State-Machine Audit — 2026-08-15 (Round 31)

> **Scope**: 用户复查提出的 5+1 个深水区问题，全部核实为真；修复后独立复审又抓到 2 个**探测复现级回归**并修复。
> **Result**: 300 files / 4,527 tests 全绿（+15 回归 +3 E2E 扩展）。

## 用户提出的点 — 全部属实、全部修复

| # | 问题 | 核实 | 修复 |
|---|---|---|---|
| P1-1 | 版本上限驱逐后 checkpoint 计数饱和 → rewind 静默失真 | 属实：50 上限后 count==count → `continue` 跳过恢复 | **v2 锚点携带内容身份**：每锚点对每个 tracked 文件写入**实时内容快照**（cp-snapshots/）+ sha256；rewind 用哈希比较判定漂移——计数饱和不再相关。测试：62 次编辑跨过驱逐边界后 rewind 精确恢复 |
| P1-2 | 子 Agent ↔ 子 Agent todo 污染（sessionDir 全 undefined → 共享 '' 桶） | 属实 | **逻辑域键** `todoScopeId ?? sessionDir ?? ''`：AgentTool 每个 child engine 独立 `agent-<rand>` scope；sessionDir 只管磁盘持久化。coordinator/ToolContext/引擎接线三处同值保证 |
| P1/P2 | Bash 变更绕过 rewind；"edited-then-rm 可恢复"说过头 | 属实：rm 后 live 内容（从未备份）实际丢失 | 快照即锚点时刻的 live 内容：**rm-after-anchor 精确复活**（E2E 用真实 CLI 产物验证 'hello' 原样回来）；sed -i/formatter 漂移同样被哈希比较捕获并回滚；rm-before-anchor 记 `absent`，之后的重建会被回滚掉。边界如实：**从未被 session 触碰过的文件**（bash 独立创建/删除）仍不可恢复 |
| P2 | compaction 固定 450 条可能每轮 full parse+rewrite | 属实 | **按字节预算裁剪**（累计 ≤150KB，至少留 1，硬上限 500）+ 孤儿快照 GC |
| P2 | rewind unlink 无 workspace 边界 | 属实 | 锚点记录 `cwd`；所有破坏性操作过 `isInsideWorkspace`（**realpath 解析父链**，防符号链接走私；测试用篡改 JSONL 注入外部路径验证被跳过并警告）。复审发现我初版把 root 的父目录当容器——真 bug，已修 |
| P2 | CostTracker 缓存费率 fallback 把 Anthropic 假设套所有 provider | 属实 | **provider 感知默认表**：anthropic 10%/125%，openai 系 50%/无写溢价，google 25%，未知 provider 1.0/1.0（不发明折扣，绝不低报）。测试锁定 openai/anthropic 两族数字 |

## 独立复审抓到的回归（探测复现级，已修 + 回归测试）

| # | 回归 | 根因 | 修复 |
|---|---|---|---|
| F1 | **rewind 删掉锚点后仅被编辑的既有文件**（用户数据丢失） | 我把 tracked-set（编辑∪创建，驱动快照）误用作 created-set（驱动删除语义）持久化 | 两个集合分离：`trackedSet` 只进快照循环；`createdFiles` 仅真创建文件（∪上一锚点维持 resume 累计性） |
| F2 | **--resume 后 todo 计划被首次 TodoWrite 清空** | coordinator 预热调用不带 persistDir → `loaded` 标志被提前毒化 → 工具路径的水合变 no-op → 空桶全量替换覆盖磁盘 | 双修：coordinator 传 `todoScopeId ? undefined : sessionDir`；ensureLoaded 仅在真实咨询过 persistDir 时才置 loaded |
| F3 | 日期别名（gpt-4o-2024-08-06）缓存读按 100% 计价（高报 80%） | cacheRates 用 exact-match 的 getModelInfo 取 provider，而定价走最长前缀 | provider 解析镜像定价的前缀策略 |

另修：F7（快照缺失时回退 tip 身份恢复而非直接失败）。明示遗留：>8KB 单锚点触发 tail-read 全量回退（每轮几 ms 常数税）、Windows 路径分隔符的 root 推导、粗 mtime 文件系统上的复用快窗（ns 精度下可忽略）。

## 验证

tsc 0 错 · eslint 0 错（33 警告为继承风格）· **300 files / 4,527 tests** · build + verify-runtime-static + ESM + deadCodeCheck(0) 全绿。E2E-3 扩展：真实 CLI 单轮产物上的 rm-复活（精确内容）+ v2 锚点形状 + cwd 边界。
