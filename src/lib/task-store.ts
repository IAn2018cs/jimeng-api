import path from "path";
import fs from "fs-extra";
import Database from "better-sqlite3";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";

export type TaskStatus = "pending" | "processing" | "completed" | "failed";

export interface VideoTask {
  task_id: string;
  status: TaskStatus;
  history_id: string | null;
  request_params: string;
  upstream_status: number | null;
  progress_text: string | null;
  poll_count: number;
  elapsed_seconds: number;
  video_url: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

// 任务有效期 3 天（秒）
const TASK_TTL_SECONDS = 3 * 24 * 60 * 60;

const DB_DIR = path.resolve("./data");
const DB_PATH = path.join(DB_DIR, "tasks.db");

// 内存中缓存的进度数据
interface ProgressData {
  upstreamStatus: number;
  progressText: string;
  pollCount: number;
  elapsedSeconds: number;
  updatedAt: number;
}

class TaskStore {
  private db: Database.Database | null = null;

  // 进度数据缓存在内存中，避免高频写入 SQLite 造成锁竞争
  private progressCache: Map<string, ProgressData> = new Map();

  // 预编译的 prepared statements
  private stmts!: {
    createTask: Database.Statement;
    updateSubmitted: Database.Statement;
    completeTask: Database.Statement;
    failTask: Database.Statement;
    getTask: Database.Statement;
    cleanExpired: Database.Statement;
  };

  initialize(): void {
    fs.ensureDirSync(DB_DIR);
    this.db = new Database(DB_PATH);
    this.db.pragma("journal_mode = WAL");
    // 遇到写锁时最多等待 5 秒，避免立即抛出 SQLITE_BUSY
    this.db.pragma("busy_timeout = 5000");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS video_tasks (
        task_id         TEXT PRIMARY KEY,
        status          TEXT NOT NULL DEFAULT 'pending',
        history_id      TEXT,
        request_params  TEXT NOT NULL,
        upstream_status INTEGER,
        progress_text   TEXT,
        poll_count      INTEGER DEFAULT 0,
        elapsed_seconds INTEGER DEFAULT 0,
        video_url       TEXT,
        error_message   TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        expires_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_expires_at ON video_tasks(expires_at);
    `);

    // 预编译所有 statements，避免每次调用都重新 prepare
    this.stmts = {
      createTask: this.db.prepare(
        `INSERT INTO video_tasks (task_id, status, request_params, created_at, updated_at, expires_at)
         VALUES (?, 'pending', ?, ?, ?, ?)`
      ),
      updateSubmitted: this.db.prepare(
        `UPDATE video_tasks SET status = 'processing', history_id = ?, updated_at = ? WHERE task_id = ?`
      ),
      completeTask: this.db.prepare(
        `UPDATE video_tasks SET status = 'completed', video_url = ?, upstream_status = 10,
         progress_text = 'SUCCESS', poll_count = ?, elapsed_seconds = ?, updated_at = ?
         WHERE task_id = ?`
      ),
      failTask: this.db.prepare(
        `UPDATE video_tasks SET status = 'failed', error_message = ?, updated_at = ? WHERE task_id = ?`
      ),
      getTask: this.db.prepare(
        `SELECT * FROM video_tasks WHERE task_id = ?`
      ),
      cleanExpired: this.db.prepare(
        `DELETE FROM video_tasks WHERE expires_at < ?`
      ),
    };

    // 服务重启恢复：将所有 processing 状态的任务标记为失败
    const recovered = this.db
      .prepare(
        "UPDATE video_tasks SET status = 'failed', error_message = '服务重启导致任务中断', updated_at = ? WHERE status = 'processing'"
      )
      .run(util.unixTimestamp());
    if (recovered.changes > 0) {
      logger.warn(
        `TaskStore: ${recovered.changes} 个进行中的任务因服务重启被标记为失败`
      );
    }

    logger.info(`TaskStore initialized, database: ${DB_PATH}`);
  }

  createTask(requestParams: Record<string, any>): string {
    const taskId = util.uuid();
    const now = util.unixTimestamp();
    this.stmts.createTask.run(taskId, JSON.stringify(requestParams), now, now, now + TASK_TTL_SECONDS);
    return taskId;
  }

  updateTaskSubmitted(taskId: string, historyId: string): void {
    const now = util.unixTimestamp();
    this.stmts.updateSubmitted.run(historyId, now, taskId);
  }

  /**
   * 进度更新只写入内存缓存，不写 DB
   * 这是调用频率最高的操作（每个任务每 10 秒一次），
   * 通过内存缓存彻底消除并发任务间的 SQLite 写锁竞争
   */
  updateTaskProgress(
    taskId: string,
    upstreamStatus: number,
    progressText: string,
    pollCount: number,
    elapsedSeconds: number
  ): void {
    this.progressCache.set(taskId, {
      upstreamStatus,
      progressText,
      pollCount,
      elapsedSeconds,
      updatedAt: util.unixTimestamp(),
    });
  }

  completeTask(
    taskId: string,
    videoUrl: string,
    pollCount: number,
    elapsedSeconds: number
  ): void {
    const now = util.unixTimestamp();
    this.stmts.completeTask.run(videoUrl, pollCount, elapsedSeconds, now, taskId);
    // 任务结束，清理内存缓存
    this.progressCache.delete(taskId);
  }

  failTask(taskId: string, errorMessage: string): void {
    const now = util.unixTimestamp();
    this.stmts.failTask.run(errorMessage, now, taskId);
    // 任务结束，清理内存缓存
    this.progressCache.delete(taskId);
  }

  getTask(taskId: string): VideoTask | undefined {
    const task = this.stmts.getTask.get(taskId) as VideoTask | undefined;
    if (!task) return undefined;

    // 合并内存中的最新进度数据
    const progress = this.progressCache.get(taskId);
    if (progress) {
      task.upstream_status = progress.upstreamStatus;
      task.progress_text = progress.progressText;
      task.poll_count = progress.pollCount;
      task.elapsed_seconds = progress.elapsedSeconds;
      task.updated_at = progress.updatedAt;
    }
    return task;
  }

  cleanExpiredTasks(): number {
    const now = util.unixTimestamp();
    const result = this.stmts.cleanExpired.run(now);
    return result.changes;
  }

  close(): void {
    this.progressCache.clear();
    this.db?.close();
  }
}

export default new TaskStore();
