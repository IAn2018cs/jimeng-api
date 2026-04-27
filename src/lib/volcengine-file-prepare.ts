import fs from "fs-extra";
import axios from "axios";
import logger from "@/lib/logger.ts";
import objectStorage from "@/lib/object-storage.ts";
import mime from "mime";

const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "mkv", "webm", "flv", "wmv", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "aac", "ogg", "flac", "m4a", "wma", "opus"]);

function getFileType(filename: string): "image" | "video" | "audio" {
  const ext = (filename || "").toLowerCase().split(".").pop() || "";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "image";
}

function getExtFromFilename(filename: string): string {
  return (filename || "").toLowerCase().split(".").pop() || "bin";
}

function bufferToDataUri(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function detectFileType(file: { mimetype?: string; originalFilename?: string }): "image" | "video" | "audio" {
  if (file.mimetype) {
    if (file.mimetype.startsWith("video/")) return "video";
    if (file.mimetype.startsWith("audio/")) return "audio";
    if (file.mimetype.startsWith("image/")) return "image";
  }
  return getFileType(file.originalFilename || "");
}

async function uploadVideoToTos(buffer: Buffer, filename: string, contentType: string): Promise<string> {
  if (!objectStorage.isEnabled()) {
    throw new Error("对象存储未配置，无法上传视频文件");
  }
  const ext = getExtFromFilename(filename);
  const key = objectStorage.generateKey(ext);
  return objectStorage.upload(buffer, key, contentType);
}

/**
 * 将 multipart 文件和 URL 文件转换为火山引擎 Ark API 可消费的格式
 * - 图片/音频 → base64 data URI
 * - 视频 → 上传到 TOS 获取公网 URL
 */
export async function prepareFilesForVolcengine(
  files?: Record<string, any>,
  filePaths?: string[]
): Promise<string[]> {
  const results: string[] = [];

  if (files) {
    const allFiles: any[] = [];
    for (const fieldFiles of Object.values(files)) {
      if (Array.isArray(fieldFiles)) {
        allFiles.push(...fieldFiles);
      } else if (fieldFiles?.filepath) {
        allFiles.push(fieldFiles);
      }
    }

    for (const file of allFiles) {
      if (!file?.filepath) continue;
      try {
        const buffer = await fs.readFile(file.filepath);
        const fileType = detectFileType(file);
        const mimeType = file.mimetype || mime.getType(file.originalFilename || "") || "application/octet-stream";

        if (fileType === "video") {
          const url = await uploadVideoToTos(buffer, file.originalFilename || "video.mp4", mimeType);
          results.push(url);
          logger.info(`[FilePrepare] multipart 视频已上传 TOS: ${file.originalFilename}`);
        } else {
          results.push(bufferToDataUri(buffer, mimeType));
          logger.info(`[FilePrepare] multipart ${fileType}已转 base64: ${file.originalFilename}`);
        }
      } catch (err: any) {
        logger.error(`[FilePrepare] multipart 文件处理失败: ${file.originalFilename} - ${err.message}`);
      }
    }
  }

  if (filePaths) {
    for (const fileUrl of filePaths) {
      if (!fileUrl) continue;
      try {
        const urlFilename = decodeURIComponent(new URL(fileUrl).pathname.split("/").pop() || "");
        const fileType = getFileType(urlFilename || fileUrl);

        const response = await axios.get(fileUrl, {
          responseType: "arraybuffer",
          timeout: 120_000,
          proxy: false,
        });
        const buffer = Buffer.from(response.data);
        const mimeType = response.headers["content-type"] || mime.getType(urlFilename) || "application/octet-stream";

        if (fileType === "video") {
          const url = await uploadVideoToTos(buffer, urlFilename || "video.mp4", mimeType);
          results.push(url);
          logger.info(`[FilePrepare] URL 视频已上传 TOS: ${fileUrl}`);
        } else {
          results.push(bufferToDataUri(buffer, mimeType));
          logger.info(`[FilePrepare] URL ${fileType}已转 base64: ${fileUrl}`);
        }
      } catch (err: any) {
        logger.warn(`[FilePrepare] URL 文件处理失败: ${fileUrl} - ${err.message}，使用原始URL`);
        results.push(fileUrl);
      }
    }
  }

  return results;
}
