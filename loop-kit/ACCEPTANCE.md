# ACCEPTANCE — 验收清单

## 质量门（每轮必须全绿）
- [ ] A1: 类型检查 — `npx tsc --noEmit`
- [ ] A2: lint — `npx eslint src/ bin/ tests/`
- [ ] A3: 测试 — `npx vitest run`

## 功能验收（全部完成后才 DONE）
- [ ] A4: 系统提示词含 coding 工作流 — `grep -c "workflow\|Verify\|Search first" src/prompts/system.ts` (exit 0 if >2)
- [ ] A5: 项目上下文含 framework — `grep -c "framework" src/config/projectContext.ts` (exit 0 if >0)
- [ ] A6: Edit 后自动格式化 — `grep -c "prettier\|format" src/tools/fileEdit.ts` (exit 0 if >0)
- [ ] A7: Bash 错误模式识别 — `grep -c "command not found\|exit code" src/tools/bash.ts` (exit 0 if >0)
- [ ] A8: Read 大文件分页 — `grep -c "MAX_LINES\|offset\|limit" src/tools/fileRead.ts` (exit 0 if >0)
- [ ] A9: Grep 代码搜索增强 — `grep -c "include\|glob" src/tools/grep.ts` (exit 0 if >0)
- [ ] A10: coding skills 增强 — `test -f src/skills/coding-skills.ts` 或 `grep -c "refactor\|debug" src/skills/loader.ts` (exit 0 if >0)
- [ ] A11: 错误恢复模式 — `grep -c "retry\|recover\|fix.*error" src/prompts/system.ts` (exit 0 if >0)
