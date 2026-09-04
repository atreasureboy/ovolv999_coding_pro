# Open Questions — 挂起的设计决定

> 本文件记录**已查实、但需要产品方向才能动手**的事项。每项都已完成代码级
> 调查(非猜测),修复路径明确,只差选边。按项目约定,这类决定不擅自拍板。

## OQ-1 /schedule(cron)任务被持久化但无人执行

**状态**:暂留(2026-09-03 查实)

**现状**:
- `src/core/cron.ts` 有完整 CRUD 持久层:`addTask` / `removeTask` /
  `enableTask` / `disableTask` / `getDueTasks` / `markTaskRun`。
- `/schedule`(group04.ts,别名 `/cron`)是唯一写入方,CRUD 全部可用。
- **`getDueTasks` 与 `markTaskRun` 零生产调用者** —— 用户通过 /schedule
  建的定时任务会被持久化,但进程内没有任何东西轮询或执行它们。

**为什么没修**:接线 executor 是产品行为变更,且与新的
durable task control plane(0525a85,`--task-server`)方向重叠 ——
docs/TASK-CONTROL-PLANE.md 明言 executor(TaskWorker → ExecutionEngine)
是规划中的独立 worker 进程。两条调度抽象并存,先收敛哪条需要拍板。

**三个候选方向**:
- (a) REPL 内轮询执行:bin loop 每 N 秒 `getDueTasks` → 起引擎 turn。
  改动最小,但后台 LLM turn 跑在交互进程里,与 `--bg`/control plane 语义重叠。
- (b) `/schedule` 改写 control-plane store(cron.ts 退役):调度收敛到
  队列协议,执行由未来 TaskWorker 进程承担。最贴架构方向,但"现在就能跑"
  的体验要等 worker 落地。
- (c) 移除 /schedule + cron.ts:诚实收敛(假入口比没有入口更伤信任),
  等 control plane worker 成熟后以新命令回归。

**倾向**:(b),配合 control plane 路线;若短期想要可用性,(a) 可作过渡。
