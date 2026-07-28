import type { TaskIntent } from './taskIntent.js'

const CONTINUATION_QUESTION = /\b(?:would|do)\s+you\s+(?:like|want)\s+me\s+to\s+(?:continue|proceed|go\s+deeper|investigate|implement|fix|review)|\bshould\s+i\s+(?:continue|proceed|investigate|implement|fix)|\bif\s+you(?:'d|\s+would)?\s+like[,\s]+i\s+can\s+(?:continue|proceed|investigate|implement|fix)|(?:要不要|是否需要|需不需要|是否要|要我|需要我)(?:再|继续|进一步|深入)?(?:读取|查看|分析|审计|检查|修复|实现|处理|继续)|(?:如果你愿意|如果需要)[，,\s]*(?:我可以|可以再)(?:继续|进一步|深入)/i
const PROPOSAL_ONLY = /\b(?:next|then)\s+i\s+(?:would|could)\s+(?:inspect|implement|fix)|\bi\s+can\s+(?:next\s+)?(?:inspect|implement|fix)\b|下一步(?:可以|将会|我会)(?:读取|检查|修复|实现)/i
const BLOCKER = /\b(?:blocked|cannot|unable|missing access|permission denied|need credentials|requires a decision)\b|(?:被阻塞|无法继续|没有权限|缺少权限|缺少凭据|需要你决定|存在冲突)/i
const RISKY_CONFIRMATION = /\b(?:force[- ]push|reset --hard|drop database|publish|deploy|production|delete permanently)\b|(?:强制推送|硬重置|删除数据库|正式发布|部署生产|永久删除)/i

export interface PrematureHandoffInput {
  assistantText: string
  intent: TaskIntent
  filesRead: number
  filesChanged: number
  verificationCount: number
}

export interface PrematureHandoffDecision {
  continue: boolean
  reason?: string
}

export function detectPrematureHandoff(input: PrematureHandoffInput): PrematureHandoffDecision {
  if (input.intent.kind === 'informational') return { continue: false }
  const text = input.assistantText.trim()
  if (!text || BLOCKER.test(text) || RISKY_CONFIRMATION.test(text)) return { continue: false }
  if (CONTINUATION_QUESTION.test(text) || PROPOSAL_ONLY.test(text)) {
    return {
      continue: true,
      reason: 'The response delegates an already-authorized next step back to the user.',
    }
  }
  if (input.intent.kind === 'mutation' && input.filesChanged === 0) {
    return {
      continue: true,
      reason: 'The mutation task stopped without producing the requested workspace change.',
    }
  }
  const analysisTarget = workspaceAnalysisReadTarget(input.intent.userMessage)
  if (input.intent.kind === 'analysis' && analysisTarget > 0 && input.filesRead < analysisTarget) {
    return {
      continue: true,
      reason: `The analysis stopped with only ${input.filesRead}/${analysisTarget} required file reads.`,
    }
  }
  if (
    input.intent.kind === 'analysis'
    && requiresExecutionVerification(input.intent.userMessage)
    && input.verificationCount === 0
  ) {
    return {
      continue: true,
      reason: 'The verification task stopped without executing any verification command.',
    }
  }
  if (
    input.intent.expectedVerification.length > 0
    && input.intent.kind === 'mutation'
    && input.verificationCount === 0
    && input.filesChanged > 0
  ) {
    return {
      continue: true,
      reason: 'The mutation stopped before executing any verification evidence.',
    }
  }
  return { continue: false }
}

export function workspaceAnalysisReadTarget(message: string): number {
  if (/\b(?:audit|review|architect|architecture|security|performance|investigate)\b|(?:审计|架构|安全|性能|全面检查|深入分析)/i.test(message)) return 3
  if (/\b(?:file|module|code|implementation|function|class)\b|(?:文件|模块|代码|实现|函数|类)/i.test(message)) return 1
  return 0
}

export function requiresExecutionVerification(message: string): boolean {
  return /\b(?:run|verify|validate|check|test)\b[\s\S]{0,30}\b(?:tests?|build|typecheck|lint|compiler|command|project)\b|\b(?:tests?|build|typecheck|lint|compiler)\b[\s\S]{0,30}\b(?:run|verify|validate|check)\b|(?:运行|验证|检查|执行|测试)[\s\S]{0,15}(?:测试|构建|编译|类型|lint|命令|项目|功能)/i.test(message)
}
