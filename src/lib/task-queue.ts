import logger from "@/lib/logger.ts";

type TaskFn = () => Promise<void>;

interface QueuedTask {
  taskId: string;
  fn: TaskFn;
}

/**
 * 并发控制队列
 * 不限制队列大小，但限制同时执行的任务数量
 */
class TaskQueue {
  private readonly maxConcurrency: number;
  private running = 0;
  private queue: QueuedTask[] = [];

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  /**
   * 将任务加入队列，队列会自动按并发上限调度执行
   */
  enqueue(taskId: string, fn: TaskFn): void {
    this.queue.push({ taskId, fn });
    logger.info(
      `任务 ${taskId} 已加入队列（排队: ${this.queue.length}, 执行中: ${this.running}/${this.maxConcurrency}）`
    );
    this.tryRun();
  }

  private tryRun(): void {
    while (this.running < this.maxConcurrency && this.queue.length > 0) {
      const { taskId, fn } = this.queue.shift()!;
      this.running++;
      logger.info(
        `任务 ${taskId} 开始执行（排队: ${this.queue.length}, 执行中: ${this.running}/${this.maxConcurrency}）`
      );
      fn().finally(() => {
        this.running--;
        logger.info(
          `任务 ${taskId} 执行结束（排队: ${this.queue.length}, 执行中: ${this.running}/${this.maxConcurrency}）`
        );
        this.tryRun();
      });
    }
  }

  /** 队列中等待的任务数 */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** 正在执行的任务数 */
  get runningCount(): number {
    return this.running;
  }
}

// 最多同时执行 5 个视频生成任务
export default new TaskQueue(5);
