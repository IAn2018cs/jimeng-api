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

class TaskStore {
  private db: Database.Database | null = null;

  initialize(): void {
    fs.ensureDirSync(DB_DIR);
    this.db = new Database(DB_PATH);
    this.db.pragma("journal_mode = WAL");

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
    this.db!.prepare(
      `INSERT INTO video_tasks (task_id, status, request_params, created_at, updated_at, expires_at)
       VALUES (?, 'pending', ?, ?, ?, ?)`
    ).run(taskId, JSON.stringify(requestParams), now, now, now + TASK_TTL_SECONDS);
    return taskId;
  }

  updateTaskSubmitted(taskId: string, historyId: string): void {
    const now = util.unixTimestamp();
    this.db!.prepare(
      `UPDATE video_tasks SET status = 'processing', history_id = ?, updated_at = ? WHERE task_id = ?`
    ).run(historyId, now, taskId);
  }

  updateTaskProgress(
    taskId: string,
    upstreamStatus: number,
    progressText: string,
    pollCount: number,
    elapsedSeconds: number
  ): void {
    const now = util.unixTimestamp();
    this.db!.prepare(
      `UPDATE video_tasks SET upstream_status = ?, progress_text = ?, poll_count = ?, elapsed_seconds = ?, updated_at = ?
       WHERE task_id = ?`
    ).run(upstreamStatus, progressText, pollCount, elapsedSeconds, now, taskId);
  }

  completeTask(
    taskId: string,
    videoUrl: string,
    pollCount: number,
    elapsedSeconds: number
  ): void {
    const now = util.unixTimestamp();
    this.db!.prepare(
      `UPDATE video_tasks SET status = 'completed', video_url = ?, upstream_status = 10,
       progress_text = 'SUCCESS', poll_count = ?, elapsed_seconds = ?, updated_at = ?
       WHERE task_id = ?`
    ).run(videoUrl, pollCount, elapsedSeconds, now, taskId);
  }

  failTask(taskId: string, errorMessage: string): void {
    const now = util.unixTimestamp();
    this.db!.prepare(
      `UPDATE video_tasks SET status = 'failed', error_message = ?, updated_at = ? WHERE task_id = ?`
    ).run(errorMessage, now, taskId);
  }

  getTask(taskId: string): VideoTask | undefined {
    return this.db!.prepare("SELECT * FROM video_tasks WHERE task_id = ?").get(
      taskId
    ) as VideoTask | undefined;
  }

  cleanExpiredTasks(): number {
    const now = util.unixTimestamp();
    const result = this.db!.prepare(
      "DELETE FROM video_tasks WHERE expires_at < ?"
    ).run(now);
    return result.changes;
  }

  close(): void {
    this.db?.close();
  }
}

export default new TaskStore();
