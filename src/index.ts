"use strict";

import environment from "@/lib/environment.ts";
import config from "@/lib/config.ts";
import "@/lib/initialize.ts";
import server from "@/lib/server.ts";
import routes from "@/api/routes/index.ts";
import logger from "@/lib/logger.ts";
import taskStore from "@/lib/task-store.ts";
import fileStorage from "@/lib/file-storage.ts";
import objectStorage from "@/lib/object-storage.ts";
import util from "@/lib/util.ts";

const startupTime = performance.now();

(async () => {
  logger.header();

  logger.info("<<<< jimeng-api >>>>");
  logger.info("Version:", environment.package.version);
  logger.info("Process id:", process.pid);
  logger.info("Environment:", environment.env);
  logger.info("Service name:", config.service.name);

  // 初始化任务存储（SQLite）
  taskStore.initialize();

  // 初始化文件存储（Docker NAS 挂载）
  fileStorage.initialize({
    storageType: config.system.storageType,
    nasMountPath: config.system.nasMountPath,
    nasFileUrlPrefix: config.system.nasFileUrlPrefix,
  });

  // 初始化对象存储（火山引擎 TOS，用于视频文件上传）
  await objectStorage.initialize({
    type: config.system.tosAccessKeyId ? "tos" : "none",
    tosAccessKeyId: config.system.tosAccessKeyId,
    tosAccessKeySecret: config.system.tosAccessKeySecret,
    tosRegion: config.system.tosRegion,
    tosEndpoint: config.system.tosEndpoint,
    tosBucket: config.system.tosBucket,
  });

  // 定时清理过期任务（每小时执行一次）
  const cleanupJob = util.createCronJob('0 * * * *', () => {
    try {
      const deleted = taskStore.cleanExpiredTasks();
      if (deleted > 0) {
        logger.info(`定时清理：已删除 ${deleted} 个过期视频任务`);
      }
    } catch (err: any) {
      logger.error(`定时清理过期任务失败: ${err.message}`);
    }
  });
  cleanupJob.start();

  server.attachRoutes(routes);
  await server.listen();

  config.service.bindAddress &&
    logger.success("Service bind address:", config.service.bindAddress);
})()
  .then(() =>
    logger.success(
      `Service startup completed (${Math.floor(performance.now() - startupTime)}ms)`
    )
  )
  .catch((err) => console.error(err));
