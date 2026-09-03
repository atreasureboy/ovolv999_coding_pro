# Task Control Plane

The task control plane provides a durable local queue for background and remote workers. It persists task transitions as JSONL, assigns expiring worker leases, requeues abandoned work, and stores summaries and artifacts for later review.

Start it for the current workspace:

```bash
ovolv999 task-server 7727
```

The server binds to `127.0.0.1`. Set `OVOGO_TASK_STORE` to override the default workspace-specific event-log location.

Create and inspect a task:

```bash
curl -X POST http://127.0.0.1:7727/tasks \
  -H 'content-type: application/json' \
  -d '{"goal":"Fix the failing tests","cwd":"/path/to/repo","maxAttempts":2}'

curl http://127.0.0.1:7727/tasks
curl http://127.0.0.1:7727/tasks/<task-id>
curl 'http://127.0.0.1:7727/events?taskId=<task-id>'
```

A worker claims one task and renews its lease while working:

```bash
curl -X POST http://127.0.0.1:7727/tasks/claim \
  -H 'content-type: application/json' \
  -d '{"workerId":"worker-1","leaseMs":60000}'

curl -X POST http://127.0.0.1:7727/tasks/<task-id>/heartbeat \
  -H 'content-type: application/json' \
  -d '{"workerId":"worker-1","leaseMs":60000}'
```

Complete or fail the task with the same worker identity:

```bash
curl -X POST http://127.0.0.1:7727/tasks/<task-id>/complete \
  -H 'content-type: application/json' \
  -d '{"workerId":"worker-1","result":{"summary":"Fixed and verified","changedFiles":["src/a.ts"]}}'

curl -X POST http://127.0.0.1:7727/tasks/<task-id>/fail \
  -H 'content-type: application/json' \
  -d '{"workerId":"worker-1","error":"verification failed"}'
```

Tasks whose leases expire are requeued until `maxAttempts` is exhausted. `POST /tasks/recover` performs an explicit recovery pass; claiming work also recovers expired leases automatically.

`GET /events` returns the durable transition log. Pass `taskId` to filter it to one task. Completion results can include a summary, output, changed files, artifacts, and metadata.

The TypeScript `TaskWorker` class connects an executor callback to the same claim, heartbeat, completion, and retry lifecycle. A later worker process can use that adapter to invoke `ExecutionEngine` in a worktree or container without changing the queue protocol.
