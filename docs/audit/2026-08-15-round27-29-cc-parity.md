# CC-Parity Iteration — 2026-08-14/15 (Rounds 27–29)

> **目标**: 用户定位 — 对标并超越 Claude Code；借鉴 opencode/codex 开源实现。
> **Method**: 本地差距审计（10 项特性逐一核实）+ opencode 源码结构研究 → 三轮按价值排序实施，每轮全量验证后提交。
> **Final state**: tsc 0 错 · eslint 0 错（34 警告，均为继承的 lazy-require 风格所致）· **297 files / 4,503 tests 全过** · build + verify-runtime-static + ESM + deadCodeCheck(0 findings) 全绿。

---

## Round 27 — 六项特性补齐（价值排序）

| # | 特性 | 差距审计结论 | 实施 |
|---|---|---|---|
| 1 | **Prompt caching 端到端** | 代码写了 80% 但从未接通——断点无人设置、用量被丢弃、/cache 永远空 | 3 个缓存断点（system/最后 tool/**最后一条消息**=增量对话缓存）；Anthropic 用量（cache_read/cache_creation）翻译为 OpenAI 风格透传；**默认开启**（`OVOLV999_NO_PROMPT_CACHE=1` 可关）；成本按 读≈10%×单价 / 写≈125%×单价 计价，/cost 显示缓存行与节省额，/cache 真实命中率；顺手修掉写 token 双重计费 bug。OpenAI 自动缓存因读 `prompt_tokens_details.cached_tokens` 免费获得支持 |
| 2 | **真正的 /rewind** | 命令自己的注释承认 restore 从未接线；MultiEdit 完全绕过 trackEdit | `/rewind [file] [n\|original]`、`/rewind all` 全形态恢复；MultiEdit 补 trackEdit（原子事务回滚 ≠ 可回溯历史） |
| 3 | **Grep CC 级** | 无 multiline/exclude/head_limit；rg+grep 双缺失直接报错 | `exclude[]` 负 glob、`multiline`（-U --multiline-dotall）、`head_limit`（带真实总数的截断提示，替换粗暴 500 行上限）、**纯 JS 兜底引擎**（rg→grep→JS 三级链，最小化机器永不硬失败） |
| 4 | **Live todos** | 内存态、退出即失、不进系统提示词——清单不驱动模型 | 状态移入 core/todoStore：持久化 `<sessionDir>/todo.json`、--resume 恢复、**每次 LLM 调用重注入系统提示词**（计划在压缩后仍存活并持续导引模型——CC todos 的核心机制） |
| 5 | **Classic REPL @-mentions** | Ink 有、classic 静默透传为字面文本 | 同一 expandAtMentions 展开（文本级，classic 不携带图片） |
| 6 | **Glob gitignore 感知** | 固定 3 条 ignore 列表，构建产物刷屏 | .gitignore + .git/info/exclude → ignore 模式（含目录/锚定/转义规则转换，10s 缓存） |

新增回归 tests/round27.test.ts（13 项）。

## Round 28 — 对话级回滚（CC /rewind 的另一半）

- **core/conversationCheckpoints**: 每轮完成后追加锚点（JSONL：turn、historyLength、各文件版本数）
- **/rewind turn [n]**: 同时恢复**对话**（history 截断）+**文件**（按快照语义：版本 k = 第 k 次编辑后的内容，仅在后续编辑发生过快照化时恢复；未被再动的文件跳过）
- 处理压缩后 history（cap 当前长度）与保留淘汰（best-effort 最早版）
- **deadCodeCheck.sh 重写**: 旧检测器不识别 require()/动态 import/多级相对路径/bin/ — 112 条警告 105 条误报；重写后 **0 findings**（顺带发现并删除 2 个真死模块 ui/theme.ts、utils/ansi.ts）

新增回归 tests/round28.test.ts（5 项，含快照语义正确性——首版实现有 bug 被测试抓出：应恢复版本 k 而非 k-1）。

## Round 29 — builtin.ts 上帝模块拆分

3,841 行 / 89 命令 / 40+ lazy require → **7 个 ≤620 行的分组文件**（cmd/group01-07）+ cmd/common.ts（跨组 helper）+ shared.ts（构造器/隐藏输入/workers 单例）+ 薄 barrel（builtin.ts 26 行，re-export 测试钩子保持兼容）。

- 脚本化切分：顶层声明识别（registerCommand 进组、其余 hoist 到 common）、按组裁剪 imports（引用检测）、require()/import() 深度修正
- 命令注册语义不变（副作用式，registry 仍是 map）——registry/dispatch/trace 测试全部原样通过
- wiringSmoke 的源码文本断言更新指向新位置
- deadCodeCheck 增补裸副作用 import 识别（本轮拆分自身暴露的检测盲区）

## 三轮合计

- **15 个用户可感特性/修复**，全部带回归测试（+23）
- 净变化：R27 +1,121/−321，R28 +386/−237，R29 拆分（builtin 3,841→26 行主文件）
- 已知遗留（明示）：`.ovogo`/`.ovolv999` 双目录统一（破坏性）、macOS 实机验证项（security -i、strict 沙箱）、README 特性文档更新

## 验证

每轮均：`tsc --noEmit` 0 错 → `eslint` 0 错 → `vitest run` 全过 → `pnpm build` → `verify-runtime-static` → ESM 检查 → `deadCodeCheck`（R28 起 0 findings）→ commit + push。
