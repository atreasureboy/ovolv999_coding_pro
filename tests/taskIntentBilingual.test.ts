/**
 * v0.3.3 (background autonomy contract §Phase 3) bilingual TaskIntent tests.
 * Verifies Chinese keyword classification + fail-closed default.
 */
import { describe, it, expect } from 'vitest'
import { classifyTaskIntent } from '../src/core/runtime/taskIntent.js'

describe('TaskIntent bilingual classification (background autonomy contract §Phase 3)', () => {
  describe('Chinese mutation keywords', () => {
    const cases = [
      '修复 src/a.ts 的 bug',
      '修改配置文件',
      '实现登录功能',
      '增加一个新接口',
      '删除无用代码',
      '重构核心模块',
      '迁移到新架构',
      '优化代码性能',
      '补充测试用例',
      '完善错误处理',
      '接入新的 Provider',
      '改造现有流程',
    ]
    for (const goal of cases) {
      it(`classifies "${goal}" as mutation`, () => {
        const intent = classifyTaskIntent(goal)
        expect(intent.kind).toBe('mutation')
        expect(intent.requiresWorkspaceChange).toBe(true)
      })
    }
  })

  describe('Chinese analysis keywords', () => {
    const cases = ['审计项目架构', '分析性能瓶颈', '评估迁移风险', '设计缓存方案', '研究竞品实现']
    for (const goal of cases) {
      it(`classifies "${goal}" as analysis`, () => {
        const intent = classifyTaskIntent(goal)
        expect(intent.kind).toBe('analysis')
        expect(intent.requiresWorkspaceChange).toBe(false)
      })
    }
  })

  describe('Chinese informational keywords', () => {
    const cases = ['解释这段代码', '总结今天的工作', '翻译这个注释', '回答一个问题']
    for (const goal of cases) {
      it(`classifies "${goal}" as informational`, () => {
        const intent = classifyTaskIntent(goal)
        expect(intent.kind).toBe('informational')
        expect(intent.requiresWorkspaceChange).toBe(false)
      })
    }
  })

  describe('Mixed language', () => {
    it('classifies mixed EN+ZH mutation', () => {
      expect(classifyTaskIntent('fix 这个 bug 并 add 测试').kind).toBe('mutation')
    })
    it('classifies mixed EN+ZH analysis', () => {
      expect(classifyTaskIntent('audit 一下 security 然后 explain 方案').kind).toBe('analysis')
    })
  })

  describe('Fail-closed default (background autonomy contract)', () => {
    it('ambiguous goal defaults to mutation (NOT informational)', () => {
      const intent = classifyTaskIntent('do the thing')
      expect(intent.kind).toBe('mutation')
      expect(intent.confidence).toBeLessThan(0.5)
    })
    it('empty-ish goal defaults to mutation', () => {
      const intent = classifyTaskIntent('xyz qwerty')
      expect(intent.kind).toBe('mutation')
    })
  })

  describe('Explicit override', () => {
    it('explicitKind=informational wins over keywords', () => {
      const intent = classifyTaskIntent('修复 bug', { explicitKind: 'informational' })
      expect(intent.kind).toBe('informational')
      expect(intent.source).toBe('user-stated')
      expect(intent.confidence).toBe(0.95)
    })
  })

  describe('Plan mode forces analysis', () => {
    it('plan mode + mutation goal → analysis', () => {
      const intent = classifyTaskIntent('重构核心架构', { planMode: true })
      expect(intent.kind).toBe('analysis')
      expect(intent.source).toBe('plan-mode')
    })
  })
})
