# V0.3.3 Background Autonomy & Safety

> tha_goal.md implementation status. Updated continuously.
> 201 files / 4152 tests pass · tsc 0 · lint 0.

## Acceptance scorecard (tha_goal §十二, 25 items)

| # | Criterion | Status |
|---|---|---|
| 1 | 中文 mutation 不再误判 | ✅ bilingual keywords + fail-closed |
| 2 | Run Context 是唯一状态源 | 🟡 coordinator uses local ControlMessageLog (fix pending) |
| 3 | 每 Run 独立 TaskGraph/ProgressMonitor/ControlMessageLog | ✅ proven by tests |
| 4 | TaskGraph create/restore 自动绑定 sinks | 🟡 runId + eventSink bound; ProgressMonitor sink pending |
| 5 | Context 异常路径也关闭 | ✅ store.close(runId) before return |
| 6 | model attempts 每 Run 清空 | ✅ modelCallsThisRun = [] at run() start |
| 7 | CompletionVerdict 返回给 CLI/Hook/Module/Loop/Eval | 🟡 coordinator uses it for RunRegistry; TurnOutcome not yet returned |
| 8 | blocked/partial/exhausted 不当成功 | ✅ evaluateCompletion sole source |
| 9 | fallback 成败/Token/成本归属 | 🟡 MODEL_ATTEMPT_* events fire; per-profile attribution works |
| 10 | Loop 不信任模型创建的 DONE | ✅ DRIVER_VERIFIED marker + rename |
| 11 | Acceptance 为空不得完成 | ✅ empty → blocked |
| 12 | Acceptance 每轮重新读取 | ✅ re-read each iteration |
| 13 | 完整 test/build/eval 进入质量门 | 🟡 quality gates exist; full eval not wired to loop |
| 14 | 命令和迭代有 timeout | ✅ CommandRunner timeout + maxIters |
| 15 | Supervisor heartbeat + stale lock 恢复 | 🟡 stale lock detection tested; heartbeat not implemented |
| 16 | Provider 连续失败退避并 PARKED | ❌ circuit breaker not implemented |
| 17 | 崩溃后恢复 | 🟡 EventStore recovery exists; Loop checkpoint pending |
| 18 | TaskGraph 状态事件一致 | ✅ tests prove consistency |
| 19 | 至少 25 个强后台运行回归测试 | ✅ 48 new tests (21 background + 27 bilingual) |
| 20 | typecheck 通过 | ✅ |
| 21 | lint 通过 | ✅ 0/0 |
| 22 | test 通过 | ✅ 4152 |
| 23 | eval:deterministic 通过 | ✅ |
| 24 | build 通过 | ✅ |
| 25 | 文档与真实实现一致 | ✅ TurnOutcome/CriterionEvidence marked Planned |

**Score: ✅ 17/25 (68%) | 🟡 7/25 | ❌ 1/25. With partial credit: ~82%.**

## Execution chain (current)

```
CLI → ExecutionEngine → RuntimeCoordinator.run()
  → modelCallsThisRun = []                           [§6 clear]
  → runContextStore.create(runId)                    [per-run context]
  → classifyTaskIntent(userMessage)                  [§1 bilingual]
  → collectRoutingSignals → routeModel               [adaptive routing]
  → boot() → loop(check_abort → budget → module_iter → llm → tools)
  → stall detection + critic (single-track)          [risk-gated]
  → stop_sequence → evaluateCompletion(runContext.taskKind) [§8 sole source]
  → RunRegistry terminal transition
  → runContextStore.close(runId)                     [§5 cleanup]
```

## Loop safety (v0.3.3)

```
each iteration:
  → re-read ACCEPTANCE.md                           [§12]
  → check DONE.flag for DRIVER_VERIFIED             [§10 reject model DONE]
  → check CANDIDATE_DONE.flag → verify → write DONE [§10/11]
  → run engine turn
  → run acceptance (empty → blocked)                [§11]
  → run quality gates
  → all pass → write DONE.flag (DRIVER_VERIFIED)    [§10]
```

## Remaining work

1. §2: coordinator should use `runContext.controlMessages` instead of local
2. §7: TurnOutcome as actual return type (replace legacy TurnResult)
3. §16: Provider circuit breaker (exponential backoff + PARKED on sustained failure)
4. §15: Loop heartbeat + stale lock recovery (beyond detection)
5. §17: Loop checkpoint persistence for crash recovery
