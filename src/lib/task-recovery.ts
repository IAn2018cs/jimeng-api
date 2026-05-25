import logger from "@/lib/logger.ts";
import taskStore from "@/lib/task-store.ts";
import taskQueue from "@/lib/task-queue.ts";
import fileStorage from "@/lib/file-storage.ts";
import { pollVideoResult } from "@/api/controllers/videos.ts";
import { pollUntilDone, resolveTaskEndpoint } from "@/lib/volcengine-video.ts";
import type { VideoTask } from "@/lib/task-store.ts";

export async function recoverTasks(): Promise<void> {
  const unrecoverable = taskStore.getUnrecoverableTasks();
  for (const task of unrecoverable) {
    taskStore.failTask(task.task_id, "服务重启导致任务中断（无法恢复）");
  }
  if (unrecoverable.length > 0) {
    logger.warn(`TaskRecovery: ${unrecoverable.length} 个无法恢复的任务已标记失败`);
  }

  const recoverable = taskStore.getRecoverableTasks();
  for (const task of recoverable) {
    logger.info(`TaskRecovery: 恢复任务 ${task.task_id} (channel=${task.channel}, channel_task_id=${task.channel_task_id})`);
    taskQueue.enqueue(task.task_id, () => resumeTask(task));
  }

  const pending = taskStore.getPendingTasks();
  for (const task of pending) {
    const refreshToken = task.refresh_token;
    if (!refreshToken) {
      taskStore.failTask(task.task_id, "服务重启导致任务中断（缺少刷新令牌）");
      continue;
    }
    const params = JSON.parse(task.request_params);
    if (params.hasUploadedFiles || params.hasUploadedFiles === undefined) {
      taskStore.failTask(task.task_id, "服务重启导致任务中断（上传的临时文件已丢失或旧任务无法确认素材完整性）");
      continue;
    }
    logger.info(`TaskRecovery: 重新执行待处理任务 ${task.task_id}`);
    const { submitVideoTaskAsync } = await import("@/api/controllers/videos.ts");
    taskQueue.enqueue(task.task_id, () =>
      submitVideoTaskAsync(
        task.task_id,
        params.model,
        params.prompt,
        {
          ratio: params.ratio,
          resolution: params.resolution,
          duration: params.duration,
          filePaths: params.filePaths,
          functionMode: params.functionMode,
        },
        refreshToken
      )
    );
  }

  const totalRecovered = recoverable.length + pending.length;
  if (totalRecovered > 0) {
    logger.info(`TaskRecovery: 恢复 ${recoverable.length} 个执行中任务, ${pending.length} 个排队任务`);
  }
  if (unrecoverable.length === 0 && totalRecovered === 0) {
    logger.info("TaskRecovery: 无需恢复的任务");
  }
}

async function resumeTask(task: VideoTask): Promise<void> {
  const taskId = task.task_id;
  const channel = task.channel;
  const channelTaskId = task.channel_task_id!;

  try {
    let videoUrl: string;

    if (channel === "jimeng") {
      const refreshToken = task.refresh_token;
      if (!refreshToken) {
        taskStore.failTask(taskId, "恢复失败：缺少刷新令牌");
        return;
      }
      const result = await pollVideoResult(
        channelTaskId,
        refreshToken,
        (status, progressText, pollCount, elapsedSeconds) => {
          taskStore.updateTaskProgress(taskId, status, progressText, pollCount, elapsedSeconds);
        }
      );
      videoUrl = result.videoUrl;
    } else if (channel === "volcengine") {
      const endpoint = await resolveTaskEndpoint(channelTaskId);
      videoUrl = await pollUntilDone(channelTaskId, endpoint);
    } else {
      taskStore.failTask(taskId, `恢复失败：未知渠道 ${channel}`);
      return;
    }

    const persistedUrl = await fileStorage.downloadAndSave(videoUrl);
    taskStore.completeTask(taskId, persistedUrl, 0, 0);
    logger.info(`TaskRecovery: 任务 ${taskId} 恢复成功，URL: ${persistedUrl}`);
  } catch (error: any) {
    logger.error(`TaskRecovery: 任务 ${taskId} 恢复失败: ${error.message}`);
    taskStore.failTask(taskId, `恢复失败: ${error.message}`);
  }
}
