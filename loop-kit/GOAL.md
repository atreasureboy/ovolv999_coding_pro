# GOAL — 任务目标

## 目标(一句话)
将 ovolv999 从通用 agent 基座深度特化为一个**真正好用的 coding 工具**——对齐 Claude Code 的核心 coding 能力，多轮迭代直到实质性可用。

## 详细说明
- 要解决的问题：当前只是"能跑的基座 + coding 提示词"，离"好用的 coding 工具"差距很大
- 期望的行为（逐轮迭代，每轮做一个实质改进）：
  1. 系统提示词深度优化（参考 Claude Code 实际提示词风格，coding 专用工作流指导）
  2. 项目上下文深度检测（framework-specific guidance, npm scripts awareness, .editorconfig/.prettierrc 检测）
  3. Edit 后自动格式化（检测 prettier/eslint 配置，编辑后自动跑 format）
  4. Bash 工具 coding 增强（检测 test runner / build system，错误模式识别）
  5. Read 工增强（大文件分页、二进制检测、行号格式优化）
  6. Grep 增强（代码搜索优化，支持文件类型过滤、import 搜索）
  7. Glob 增强（尊重 .gitignore，支持 common code patterns）
  8. TodoWrite 与系统提示词联动（任务分解指导）
  9. Plan mode coding 专用（分析→规划→执行 flow）
  10. 内置 coding skills 增强（refactor / test-gen / doc-gen / debug）
  11. 错误恢复模式（tsc/lint/test 失败后自动读错误→修复→重试）
  12. 上下文窗口优化（大代码库的 token 节约策略）

- 范围(做哪些)：上述 12 项，每轮做 1-2 项
- 范围(不做哪些)：不改 engine.ts runTurn 核心循环、不加新 npm 依赖、不改模块系统接口

## 明确不做(will_not_do)
- 不改 src/core/engine.ts 的 runTurn 方法
- 不改模块系统（module.ts / moduleRegistry.ts）
- 不加新的 npm 依赖
- 不动测试框架结构

## 背景上下文
- ovolv999 已有完整 agent 基座：统一 Harness + 模块系统 + AgentConfig + Memory + Hooks + loop-kit
- 已完成的 coding 特化：系统提示词英文化、projectContext 检测、Edit diff 显示、loop 引擎
- 项目使用 pnpm + TypeScript ESM + vitest + eslint
- 参考：Claude Code 源码在 C:\Users\ZHHQZS\Desktop\安恒信息实习\参考项目\claude code\cld-code-rev
