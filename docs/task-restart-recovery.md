# 异步视频任务重启恢复方案

## 背景

当前服务重启后，所有 `processing` 状态的任务会被直接标记为 `failed`（错误信息：`服务重启导致任务中断`）。但实际上上游服务（即梦/火山引擎）的任务仍在执行中，只是本地轮询中断了。本方案目标：重启后自动恢复轮询，避免任务浪费。

## 现状分析

### 数据库已有字段

| 字段 | 用途 |
|------|------|
| task_id | 本系统内部 ID |
| status | pending / processing / completed / failed |
| history_id | 即梦渠道返回的任务 ID |
| request_params | 原始请求参数 JSON（model, prompt, ratio, resolution, duration, filePaths, functionMode）|

### 恢复轮询缺失的信息

| 缺失信息 | 说明 |
|----------|------|
| refresh_token | 即梦渠道轮询需要 |
| 火山引擎 task_id | 火山引擎渠道轮询需要 |
| 渠道标识 | 不知道该用哪个渠道恢复 |
| 队列中待执行任务 | pending 状态的任务重启后队列丢失 |

---

## 数据库变更

### 新增字段（ALTER TABLE，兼容已有数据）

```sql
ALTER TABLE video_tasks ADD COLUMN channel TEXT DEFAULT NULL;
ALTER TABLE video_tasks ADD COLUMN channel_task_id TEXT DEFAULT NULL;
ALTER TABLE video_tasks ADD COLUMN refresh_token TEXT DEFAULT NULL;
```

| 字段 | 类型 | 说明 |
|------|------|------|
| channel | TEXT | 当前使用的渠道：`jimeng` / `volcengine`，NULL 表示尚未开始 |
| channel_task_id | TEXT | 上游任务 ID。即梦渠道 = history_id，火山引擎渠道 = ark task_id（如 `cgt-xxx`）|
| refresh_token | TEXT | 即梦渠道轮询使用的 token（火山引擎渠道不需要，用 arkApiKey 配置） |

### 兼容性处理

- 使用 `ALTER TABLE ... ADD COLUMN ... DEFAULT NULL`，SQLite 支持在已有表上安全新增列
- 已有行的新字段为 NULL，不影响旧数据读取
- 代码中使用这些字段时做 NULL 检查，NULL 表示旧任务（不可恢复，保持原有逻辑标记失败）

---

## 代码改动

### 1. task-store.ts — 数据库迁移

在 `initialize()` 中，建表语句后追加迁移逻辑：

```typescript
// 数据库迁移：新增恢复相关字段
const columns = this.db.pragma("table_info(video_tasks)").map((c: any) => c.name);
if (!columns.includes("channel")) {
  this.db.exec("ALTER TABLE video_tasks ADD COLUMN channel TEXT DEFAULT NULL");
  this.db.exec("ALTER TABLE video_tasks ADD COLUMN channel_task_id TEXT DEFAULT NULL");
  this.db.exec("ALTER TABLE video_tasks ADD COLUMN refresh_token TEXT DEFAULT NULL");
  logger.info("TaskStore: 数据库迁移完成，新增 channel/channel_task_id/refresh_token 字段");
}
```

### 2. task-store.ts — 新增方法

```typescript
// 更新渠道信息（任务开始执行时调用）
updateChannel(taskId: string, channel: string, channelTaskId: string, refreshToken?: string): void;

// 获取可恢复的任务（status = processing 且有 channel_task_id）
getRecoverableTasks(): VideoTask[];

// 获取待排队任务（status = pending）
getPendingTasks(): VideoTask[];
```

### 3. videos.ts — 记录渠道信息

**即梦渠道**：`prepareAndSubmitVideo` 返回 `historyId` 后：
```typescript
taskStore.updateChannel(taskId, "jimeng", historyId, refreshToken);
```

**火山引擎渠道**：`generateVideoViaVolcengine` 内部创建任务后，需要将 `taskId` 回传。方案：
- `generateVideoViaVolcengine` 新增可选参数 `onTaskCreated?: (channelTaskId: string) => void`
- 在 `createTask` 拿到 ark task_id 后回调，调用方在回调中写库

```typescript
const videoUrl = await generateVideoViaVolcengine(_model, prompt, options, {
  onTaskCreated: (channelTaskId) => {
    taskStore.updateChannel(taskId, "volcengine", channelTaskId);
  }
});
```

### 4. 启动恢复逻辑 — 新增 task-recovery.ts

服务启动时（在 `initialize()` 之后）执行恢复：

```typescript
export async function recoverTasks(): Promise<void> {
  // 1. 恢复 processing 状态的任务（有 channel_task_id 的）
  const recoverables = taskStore.getRecoverableTasks();
  for (const task of recoverables) {
    taskQueue.enqueue(task.task_id, () => resumeTask(task));
  }

  // 2. 恢复 pending 状态的任务（排队中还没开始的）
  const pendings = taskStore.getPendingTasks();
  for (const task of pendings) {
    const params = JSON.parse(task.request_params);
    taskQueue.enqueue(task.task_id, () =>
      submitVideoTaskAsync(task.task_id, params.model, params.prompt, {
        ratio: params.ratio,
        resolution: params.resolution,
        duration: params.duration,
        filePaths: params.filePaths,
        functionMode: params.functionMode,
      }, task.refresh_token || pickAvailableToken())
    );
  }

  // 3. 无法恢复的任务（旧任务，channel_task_id 为 NULL）标记失败
  const unrecoverables = taskStore.getUnrecoverableTasks();
  for (const task of unrecoverables) {
    taskStore.failTask(task.task_id, "服务重启导致任务中断（旧任务不支持恢复）");
  }

  if (recoverables.length + pendings.length > 0) {
    logger.info(`TaskRecovery: 恢复 ${recoverables.length} 个执行中任务, ${pendings.length} 个排队任务`);
  }
}
```

### 5. resumeTask — 按渠道恢复轮询

```typescript
async function resumeTask(task: VideoTask): Promise<void> {
  const channelTaskId = task.channel_task_id!;

  if (task.channel === "jimeng") {
    // 即梦渠道：用 history_id + refresh_token 继续轮询
    const { videoUrl } = await pollVideoResult(channelTaskId, task.refresh_token!);
    const persistedUrl = await fileStorage.downloadAndSave(videoUrl);
    taskStore.completeTask(task.task_id, persistedUrl, 0, 0);
  } else if (task.channel === "volcengine") {
    // 火山引擎渠道：用 ark task_id 继续轮询
    const videoUrl = await pollUntilDone(channelTaskId); // 需要从 volcengine-video.ts 导出
    const persistedUrl = await fileStorage.downloadAndSave(videoUrl);
    taskStore.completeTask(task.task_id, persistedUrl, 0, 0);
  } else {
    taskStore.failTask(task.task_id, "未知渠道，无法恢复");
  }
}
```

### 6. volcengine-video.ts — 导出 pollUntilDone

将 `pollUntilDone` 从模块内部函数改为 named export，供恢复逻辑直接调用：

```typescript
export async function pollUntilDone(taskId: string): Promise<string> { ... }
```

### 7. pending 任务的 refresh_token 存储

`pending` 任务还没开始执行，但需要 token 才能在恢复后继续。在 `createTask` 时把 token 一起存入：

```typescript
// routes/videos.ts
const taskId = taskStore.createTask({
  model, prompt, ratio, resolution,
  duration: finalDuration, filePaths: finalFilePaths, functionMode
}, token);  // 新增第二个参数
```

对应 `task-store.ts` 修改：
```typescript
createTask(requestParams: Record<string, any>, refreshToken?: string): string {
  // INSERT 时同时写入 refresh_token
}
```

---

## 启动时序

```
1. TaskStore.initialize()     — 建表 / 迁移
2. recoverTasks()             — 恢复排队和轮询（替换原有的批量标记失败逻辑）
3. 启动 HTTP 服务             — 接收新请求
```

---

## 边界情况处理

| 场景 | 处理 |
|------|------|
| 旧任务无 channel_task_id | 标记失败，提示不支持恢复 |
| 即梦任务但 refresh_token 为空 | 标记失败 |
| 恢复轮询后发现上游任务已失败 | 正常走失败逻辑 |
| 恢复轮询后发现上游任务已超时/过期 | 正常走失败逻辑 |
| pending 任务的 filePaths 含本地临时文件 | multipart 上传的文件在重启后丢失，标记失败并提示原因 |
| token 过期（重启间隔太长） | 轮询会拿到 401，走失败逻辑，error_message 说明 token 过期 |
| 任务已过期（超过 3 天 TTL） | getRecoverableTasks 查询时加 `expires_at > now` 条件过滤 |

---

## 风险与限制

1. **refresh_token 明文存库** — 安全风险低（本地 SQLite，不暴露外网），但如需加固可考虑加密存储
2. **multipart 文件不可恢复** — pending 状态的含临时文件的任务无法恢复，只能失败。这是 filePaths 为本地路径时的固有限制
3. **即梦任务存在双重轮询风险** — 如果重启极快（<1s），理论上旧进程和新进程可能同时轮询同一任务。实际无害（轮询是只读查询），但下载/完成可能重复执行一次，需幂等处理（completeTask 对已完成任务应该是 no-op）

---

## 不涉及的改动

- 不改变客户端 API 接口
- 不改变任务过期清理逻辑
- 不改变并发队列上限（仍为 5）
