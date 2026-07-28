import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assessProjectExploration,
  buildProjectExplorationProfile,
  isProjectExplorationRequest,
} from '../src/core/runtime/projectExploration.js'
import { classifyTaskIntent } from '../src/core/runtime/taskIntent.js'
import { ExecutionEngine } from '../src/core/engine.js'
import type { EngineConfig, Tool } from '../src/core/types.js'

const roots: string[] = []

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'ovolv999-explore-'))
  roots.push(root)
  const files: Record<string, string> = {
    'README.md': '# Project',
    'package.json': '{"scripts":{"test":"vitest"}}',
    'src/index.ts': 'export {}',
    'src/core/engine.ts': 'export {}',
    'src/ui/app.ts': 'export {}',
    'src/tools/read.ts': 'export {}',
    'tests/engine.test.ts': 'test("x",()=>{})',
    'tests/ui.test.ts': 'test("x",()=>{})',
  }
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

async function* response(text: string): AsyncIterable<unknown> {
  yield {
    choices: [{ delta: { content: text }, index: 0, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }
}

async function* reads(files: string[]): AsyncIterable<unknown> {
  yield {
    choices: [{
      delta: {
        tool_calls: files.map((file, index) => ({
          index,
          id: `read-${index}`,
          function: { name: 'Read', arguments: JSON.stringify({ file_path: file }) },
        })),
      },
      index: 0,
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }
}

class FakeClient {
  calls: Array<Record<string, unknown>> = []
  private streams: AsyncIterable<unknown>[] = []
  chat = {
    completions: {
      create: (params: Record<string, unknown>) => {
        this.calls.push(params)
        const stream = this.streams[this.calls.length - 1]
        if (!stream) throw new Error('unexpected model call')
        return Promise.resolve(stream)
      },
    },
  }
  push(stream: AsyncIterable<unknown>): void {
    this.streams.push(stream)
  }
}

function renderer(): ConstructorParameters<typeof ExecutionEngine>[1] {
  const value: Record<string, () => void> = {}
  for (const name of [
    'banner', 'info', 'warn', 'error', 'success', 'startSpinner', 'stopSpinner',
    'beginAssistantText', 'endAssistantText', 'streamToken', 'streamReasoning',
    'toolStart', 'toolResult', 'compactStart', 'compactDone', 'contextWarning',
    'agentStart', 'agentDone', 'agentSummary', 'agentHeartbeat',
  ]) value[name] = () => {}
  return value as unknown as ConstructorParameters<typeof ExecutionEngine>[1]
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('project exploration completion', () => {
  it('recognizes initial and follow-up project reading requests as analysis', () => {
    for (const request of ['读取这个项目', '进一步读取，不要只看表面', 'inspect this repository thoroughly']) {
      expect(isProjectExplorationRequest(request)).toBe(true)
      expect(classifyTaskIntent(request).kind).toBe('analysis')
    }
  })

  it('rejects a shallow pass with uncovered project areas', () => {
    const root = fixture()
    const profile = buildProjectExplorationProfile(root)
    const assessment = assessProjectExploration(profile, [
      join(root, 'README.md'),
      join(root, 'package.json'),
      join(root, 'src/index.ts'),
    ])
    expect(assessment.complete).toBe(false)
    expect(assessment.missing.length).toBeGreaterThan(0)
    expect(assessment.criteria.find((criterion) => criterion.id === 'project-tests')?.satisfied).toBe(false)
  })

  it('accepts representative root, entrypoint, implementation, and test coverage', () => {
    const root = fixture()
    const profile = buildProjectExplorationProfile(root)
    const assessment = assessProjectExploration(profile, profile.files.map((file) => join(root, file)))
    expect(assessment.complete).toBe(true)
    expect(assessment.missing).toEqual([])
  })

  it('deduplicates repeated reads instead of treating them as progress', () => {
    const root = fixture()
    const profile = buildProjectExplorationProfile(root)
    const same = join(root, 'README.md')
    const assessment = assessProjectExploration(profile, [same, same, same])
    expect(assessment.filesRead).toBe(1)
    expect(assessment.complete).toBe(false)
  })

  it('continues the same run after a shallow stop and closes coverage before completing', async () => {
    const root = fixture()
    const profile = buildProjectExplorationProfile(root)
    const client = new FakeClient()
    client.push(response('I looked briefly. Should I continue?'))
    client.push(reads(profile.files.map((file) => join(root, file))))
    client.push(response('Consolidated project architecture report.'))
    const readTool: Tool = {
      name: 'Read',
      definition: {
        type: 'function',
        function: {
          name: 'Read',
          description: 'read',
          parameters: {
            type: 'object',
            properties: { file_path: { type: 'string' } },
            required: ['file_path'],
          },
        },
      },
      execute: (input) => Promise.resolve({ content: String(input.file_path), isError: false }),
      metadata: { concurrencySafe: true },
    }
    const config: EngineConfig = {
      apiKey: 'test',
      model: 'test',
      maxIterations: 10,
      cwd: root,
      permissionMode: 'auto',
      permissionManager: undefined,
      enabledModules: [],
      extraTools: [readTool],
    }
    const engine = new ExecutionEngine(
      config,
      renderer(),
      client as unknown as ConstructorParameters<typeof ExecutionEngine>[2],
    )
    const result = await engine.runTurn('进一步读取这个项目并形成完整理解', [])
    expect(client.calls).toHaveLength(3)
    expect(JSON.stringify(client.calls[1])).toContain('project_exploration_continue')
    expect(result.result.output).toContain('Consolidated project architecture report.')
    expect(engine.getLastRunContext()?.completionVerdict?.status).toBe('completed')
  })

  it('never marks repeated shallow summaries completed without read evidence', async () => {
    const root = fixture()
    const client = new FakeClient()
    for (let index = 0; index < 5; index++) client.push(response(`Shallow summary ${index}`))
    const config: EngineConfig = {
      apiKey: 'test',
      model: 'test',
      maxIterations: 10,
      cwd: root,
      permissionMode: 'auto',
      permissionManager: undefined,
      enabledModules: [],
    }
    const engine = new ExecutionEngine(
      config,
      renderer(),
      client as unknown as ConstructorParameters<typeof ExecutionEngine>[2],
    )
    await engine.runTurn('读取这个项目', [])
    expect(client.calls).toHaveLength(5)
    expect(engine.getLastRunContext()?.completionVerdict?.status).toBe('partial')
  })

  it('continues a mutation that stopped without making changes', async () => {
    const root = fixture()
    const client = new FakeClient()
    for (let index = 0; index < 4; index++) client.push(response(`Proposed fix ${index}`))
    const config: EngineConfig = {
      apiKey: 'test',
      model: 'test',
      maxIterations: 10,
      cwd: root,
      permissionMode: 'auto',
      permissionManager: undefined,
      enabledModules: [],
    }
    const engine = new ExecutionEngine(
      config,
      renderer(),
      client as unknown as ConstructorParameters<typeof ExecutionEngine>[2],
    )
    await engine.runTurn('修复登录错误', [])
    expect(client.calls).toHaveLength(4)
    expect(JSON.stringify(client.calls[1])).toContain('task_completion_continue')
    expect(engine.getLastRunContext()?.completionVerdict?.status).toBe('incomplete')
  })

  it('does not accept a verification summary without command evidence', async () => {
    const root = fixture()
    const client = new FakeClient()
    for (let index = 0; index < 4; index++) client.push(response(`Tests should pass ${index}`))
    const config: EngineConfig = {
      apiKey: 'test',
      model: 'test',
      maxIterations: 10,
      cwd: root,
      permissionMode: 'auto',
      permissionManager: undefined,
      enabledModules: [],
    }
    const engine = new ExecutionEngine(
      config,
      renderer(),
      client as unknown as ConstructorParameters<typeof ExecutionEngine>[2],
    )
    await engine.runTurn('运行项目测试并验证构建', [])
    expect(client.calls).toHaveLength(4)
    expect(engine.getLastRunContext()?.completionVerdict?.status).toBe('partial')
  })
})
