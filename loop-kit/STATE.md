# STATE — ovolv999 深度 coding 特化

## 迭代进度
- 第 3/12 轮  | 模式: 单目标
- 验收通过: 11 / 11 条 ✅ DONE

## 已完成
### Iteration 1
- system.ts: coding workflow 指导（Understand→Search→Plan→Implement→Verify→Report）
- system.ts: error recovery 模式（command failed/type errors/test failures/lint errors/import errors）
- fileEdit.ts: Edit 后自动格式化（检测 .prettierrc/.eslintrc，跑 prettier --write 或 eslint --fix）

### Iteration 2
- bash.ts: 错误模式识别（command not found/file not found/permission denied/connrefused/module not found/syntax error → 附带 hint）
- fileRead.ts: 二进制文件检测（null bytes → 提示用 xxd/strings）
- fileRead.ts: 大文件分页提示（"Use offset=N to read next page"）
- grep.ts: include 简写参数（include:"ts" → glob:"*.ts"）

### Iteration 3
- loader.ts: 新增 4 个 coding skills（refactor/debug/doc-gen + 原有 commit/review/fix-types/test = 8 个）
- projectContext.ts: framework-specific guidance（Next.js/Vite/React/Express 各有专属提示）
- projectContext.ts: 全部英文化（系统提示词一致性）

## 验收结果
- A1: tsc exit 0 ✓
- A2: eslint exit 0 ✓
- A3: 66 tests passed ✓
- A4: workflow/Verify/Search first in system.ts = 6 ✓
- A5: framework in projectContext = 13 ✓
- A6: prettier/format in fileEdit = 8 ✓
- A7: error patterns in bash = 3 ✓
- A8: offset/limit in fileRead = 9 ✓
- A9: include/glob in grep = 12 ✓
- A10: refactor/debug in loader = 7 ✓
- A11: retry/recover in system.ts = 3 ✓
