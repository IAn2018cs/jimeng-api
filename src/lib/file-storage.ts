import path from "path";
import fs from "fs-extra";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import logger from "@/lib/logger.ts";

interface StorageConfig {
  storageType: string;
  nasMountPath: string;
  nasFileUrlPrefix: string;
}

abstract class BaseStorage {
  abstract save(buffer: Buffer, filename: string): Promise<string>;
  abstract delete(relativePath: string): Promise<void>;
  abstract getUrl(relativePath: string): string;

  async downloadAndSave(
    sourceUrl: string,
    extension: string = "mp4"
  ): Promise<string> {
    try {
      logger.info(`[Storage] 开始下载: ${sourceUrl}`);
      const response = await axios.get(sourceUrl, {
        responseType: "arraybuffer",
        timeout: 300000,
      });

      const filename = `${uuidv4()}.${extension}`;
      const buffer = Buffer.from(response.data);
      const url = await this.save(buffer, filename);
      logger.info(
        `[Storage] 下载并保存成功 (${(buffer.length / 1024 / 1024).toFixed(2)}MB): ${url}`
      );
      return url;
    } catch (err: any) {
      logger.error(`[Storage] 下载并保存失败: ${err.message}，返回原始URL`);
      return sourceUrl;
    }
  }
}

class LocalMountStorage extends BaseStorage {
  private mountPath: string;
  private urlPrefix: string;

  constructor(mountPath: string, urlPrefix: string) {
    super();
    this.mountPath = mountPath;
    this.urlPrefix = urlPrefix.replace(/\/+$/, "");
  }

  private getDatePath(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}/${m}/${d}`;
  }

  async save(buffer: Buffer, filename: string): Promise<string> {
    const datePath = this.getDatePath();
    const dirPath = path.join(this.mountPath, datePath);
    await fs.ensureDir(dirPath);

    const filePath = path.join(dirPath, filename);
    await fs.writeFile(filePath, buffer);

    const relativePath = `${datePath}/${filename}`;
    const url = this.getUrl(relativePath);
    logger.info(`[Storage] 已保存: ${filePath} -> ${url}`);
    return url;
  }

  async delete(relativePath: string): Promise<void> {
    const filePath = path.join(this.mountPath, relativePath);
    try {
      await fs.unlink(filePath);
      logger.info(`[Storage] 已删除: ${filePath}`);
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
  }

  getUrl(relativePath: string): string {
    return `${this.urlPrefix}/${relativePath}`;
  }
}

class FileStorage {
  private storage: BaseStorage | null = null;

  initialize(config: StorageConfig): void {
    const { storageType, nasMountPath, nasFileUrlPrefix } = config;

    if (!storageType || storageType === "none" || !nasMountPath || !nasFileUrlPrefix) {
      logger.info("[Storage] 未配置存储，文件存储已禁用");
      return;
    }

    switch (storageType) {
      case "local_mount":
      default:
        fs.ensureDirSync(nasMountPath);
        this.storage = new LocalMountStorage(nasMountPath, nasFileUrlPrefix);
        break;
      // Future: case 's3': this.storage = new S3Storage(...); break;
    }

    logger.info(
      `[Storage] 已启用 (${storageType})，mountPath: ${nasMountPath}, urlPrefix: ${nasFileUrlPrefix}`
    );
  }

  isEnabled(): boolean {
    return this.storage !== null;
  }

  async downloadAndSave(
    sourceUrl: string,
    extension: string = "mp4"
  ): Promise<string> {
    if (!this.storage) {
      return sourceUrl;
    }
    return this.storage.downloadAndSave(sourceUrl, extension);
  }

  async save(buffer: Buffer, filename: string): Promise<string> {
    if (!this.storage) {
      throw new Error("[Storage] 文件存储未启用");
    }
    return this.storage.save(buffer, filename);
  }

  async delete(relativePath: string): Promise<void> {
    if (!this.storage) {
      return;
    }
    return this.storage.delete(relativePath);
  }
}

export default new FileStorage();
