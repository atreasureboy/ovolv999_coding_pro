# Round 4 变更记录 — Daemon 持久化 + Linux Sandbox + WorkspaceWatcher

> 用户目标"继续"。选择 3 个让 Round 1-3 投资真正产生用户价值的方向。

## 范围

### 1. Session 持久化 + Resume

**当前**: Daemon 重启会丢失所有 sessions。每个 session 内的 turn history 仅在内存。
**借鉴后**: 每个 session 持久化到 `~/.ovolv999/sessions/<id>.jsonl`,启动时自动恢复;`--attach <id>` 即使 daemon 重启也能续接。

**实现**:
- `src/core/daemon/sessionStore.ts` — JSONL 读写 + 启动时 replay
- `src/core/daemon/daemonServer.ts` 扩展 — 启动时 `loadAll()` 恢复 sessions
- 增量写入:每个 turn 完成后 `appendTurn(sessionId, turn)`;启动时 `loadTurns(sessionId)`

### 2. Linux 沙箱 helper (C source)

**当前**: Linux bubble mode 是 placeholder,提示 "Requires ovolv999-sandbox-helper on PATH"
**借鉴后**: 完整 C 实现 ~150 行,unprivileged Landlock + bwrap fallback,install.sh 编译

**实现**:
- `scripts/sandbox-helper.c` — Landlock rules + execve(2) syscall
- `install.sh` 增加编译步骤(`cc -O2 scripts/sandbox-helper.c -o ~/.ovolv999/bin/ovolv999-sandbox-helper`)
- macOS 路径不变(sandbox-exec 内置)

### 3. WorkspaceWatcher

**当前**: 工具调用时按需 `Read` 文件;无变化感知
**借鉴后**: 启动时注册监听 workdir,文件变化时注入"file changed"内部消息(下一个 LLM round 自动看到)

**实现**:
- `src/core/workspaceWatcher.ts` — 纯 polling 实现(`fs.watch` 在 Linux 不可靠)
- `setInterval` 每 5s `lstat` 比对 `mtime` + `size`
- 变化注入 `ControlMessageLog`(`workspace_change` 类型)
- 用户可配置 `WORKSPACE_WATCH_INTERVAL_MS`(默认 5000)

## 不在 Round 4 范围(留给后续)

- WorkspaceWatcher 的 IDE 集成(IPC 通知)
- Sandbox helper 的 cgroups 资源限制
- Session persistence 的加密(用户敏感数据)
- 跨机器 session 迁移(需要 teleport infrastructure)

## 验证

- `npx tsc --noEmit`
- `pnpm lint`
- `npx vitest run`
- **行为验证需用户手动**(尤其 sandbox-helper 需 `install.sh` 编译后测试)

## 风险

| 风险 | 缓解 |
|---|---|
| Sandbox helper 编译失败(缺 cc / 缺 Landlock headers) | install.sh 检测 + 跳过 + 提示用户 |
| Polling 频率过高 → CPU 消耗 | 默认 5s,可关闭(0) |
| Polling 频率过低 → 错过变化 | 文档建议大项目用 inotify 替换 |
| Session JSONL 损坏 → 启动崩溃 | loadTurns 跳过损坏行,不阻断 daemon |
| Session 文件过大 → 内存爆炸 | 限制每个 session 最多 10000 turns(超出警告) |
