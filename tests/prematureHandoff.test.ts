import { describe, expect, it } from 'vitest'
import { classifyTaskIntent } from '../src/core/runtime/taskIntent.js'
import {
  detectPrematureHandoff,
  requiresExecutionVerification,
  workspaceAnalysisReadTarget,
} from '../src/core/runtime/prematureHandoff.js'

function decision(message: string, assistantText: string, filesRead = 0, filesChanged = 0, verificationCount = 0) {
  return detectPrematureHandoff({
    assistantText,
    intent: classifyTaskIntent(message),
    filesRead,
    filesChanged,
    verificationCount,
  })
}

describe('premature handoff guard', () => {
  it('continues already-authorized analysis instead of asking the user again', () => {
    expect(decision('审计这个模块', '我已经大致看过了，要不要我继续深入分析？').continue).toBe(true)
    expect(decision('review this module', 'Would you like me to continue investigating?').continue).toBe(true)
  })

  it('continues mutation tasks without changes or verification', () => {
    expect(decision('修复登录错误', '这里可能需要修改认证逻辑。').continue).toBe(true)
    expect(decision('修复登录错误', '已经修改完成。', 2, 1, 0).continue).toBe(true)
    expect(decision('修复登录错误', '已经修改并验证。', 2, 1, 1).continue).toBe(false)
  })

  it('allows concrete blockers and risky confirmations to reach the user', () => {
    expect(decision('修复部署', '无法继续：缺少生产环境权限。').continue).toBe(false)
    expect(decision('更新发布流程', 'Should I deploy to production?').continue).toBe(false)
  })

  it('requires stronger read evidence for audits than focused file analysis', () => {
    expect(workspaceAnalysisReadTarget('全面审计认证架构')).toBe(3)
    expect(workspaceAnalysisReadTarget('分析这个文件')).toBe(1)
    expect(workspaceAnalysisReadTarget('解释什么是 JWT')).toBe(0)
  })

  it('classifies mixed inspect-and-fix requests as mutation', () => {
    expect(classifyTaskIntent('审计项目然后修复发现的问题').kind).toBe('mutation')
    expect(classifyTaskIntent('review the repository and fix the issues').kind).toBe('mutation')
  })

  it('requires command evidence for executable verification requests', () => {
    expect(requiresExecutionVerification('运行项目测试并验证构建')).toBe(true)
    expect(requiresExecutionVerification('run the test suite and check the build')).toBe(true)
    expect(requiresExecutionVerification('验证这个设计思路')).toBe(false)
    expect(classifyTaskIntent('运行项目测试').kind).toBe('analysis')
    expect(decision('运行项目测试', '测试应该可以通过。', 0, 0, 0).continue).toBe(true)
    expect(decision('运行项目测试', '测试通过。', 0, 0, 1).continue).toBe(false)
  })
})
