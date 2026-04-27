import { v4 as uuidv4 } from "uuid";
import logger from "@/lib/logger.ts";

export interface ObjectStorageConfig {
  type: string;
  tosAccessKeyId: string;
  tosAccessKeySecret: string;
  tosRegion: string;
  tosEndpoint: string;
  tosBucket: string;
}

interface IObjectStorage {
  upload(buffer: Buffer, key: string, contentType?: string): Promise<string>;
}

class TosObjectStorage implements IObjectStorage {
  private client: any;
  private bucket: string;
  private endpoint: string;

  private constructor(client: any, bucket: string, endpoint: string) {
    this.client = client;
    this.bucket = bucket;
    this.endpoint = endpoint;
  }

  static async create(opts: {
    accessKeyId: string;
    accessKeySecret: string;
    region: string;
    endpoint: string;
    bucket: string;
  }): Promise<TosObjectStorage> {
    const TOS = await import("@volcengine/tos-sdk");
    const TosClient = TOS.TosClient || TOS.TOS;
    const client = new TosClient({
      accessKeyId: opts.accessKeyId,
      accessKeySecret: opts.accessKeySecret,
      region: opts.region,
      endpoint: opts.endpoint,
    });
    return new TosObjectStorage(client, opts.bucket, opts.endpoint);
  }

  async upload(buffer: Buffer, key: string, contentType?: string): Promise<string> {
    await this.client.putObject({
      bucket: this.bucket,
      key,
      body: buffer,
      contentType,
    });
    return `https://${this.bucket}.${this.endpoint}/${key}`;
  }
}

class ObjectStorage {
  private storage: IObjectStorage | null = null;

  async initialize(config: ObjectStorageConfig): Promise<void> {
    if (config.type === "tos" && config.tosAccessKeyId && config.tosBucket) {
      this.storage = await TosObjectStorage.create({
        accessKeyId: config.tosAccessKeyId,
        accessKeySecret: config.tosAccessKeySecret,
        region: config.tosRegion,
        endpoint: config.tosEndpoint,
        bucket: config.tosBucket,
      });
      logger.info(
        `[ObjectStorage] TOS 已启用, bucket=${config.tosBucket}, region=${config.tosRegion}`
      );
    } else {
      logger.info("[ObjectStorage] 未配置对象存储，火山引擎视频文件上传不可用");
    }
  }

  isEnabled(): boolean {
    return this.storage !== null;
  }

  async upload(buffer: Buffer, key: string, contentType?: string): Promise<string> {
    if (!this.storage) {
      throw new Error("[ObjectStorage] 对象存储未初始化");
    }
    return this.storage.upload(buffer, key, contentType);
  }

  generateKey(extension: string): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `volcengine-tmp/${y}/${m}/${d}/${uuidv4()}.${extension}`;
  }
}

export default new ObjectStorage();
