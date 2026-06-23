import axios from "axios";
import logger from "@/lib/logger.ts";
import config from "@/lib/config.ts";
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { prepareFilesForVolcengine } from "@/lib/volcengine-file-prepare.ts";

const ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks";
const ARK_AGENT_PLAN_BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks";

export interface ArkEndpoint {
  baseUrl: string;
  apiKey: string;
  label: string;
}

const POLL_INTERVAL_MS = 30_000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
const NETWORK_RETRY_COUNT = 3;
const NETWORK_RETRY_DELAY_MS = 5_000;

const TRANSIENT_ERROR_CODES = ["EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"];

function isTransientNetworkError(error: any): boolean {
  const code = error?.code || error?.cause?.code || "";
  if (TRANSIENT_ERROR_CODES.includes(code)) return true;
  const msg = error?.message || "";
  return TRANSIENT_ERROR_CODES.some((c) => msg.includes(c));
}

async function withNetworkRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 1; attempt <= NETWORK_RETRY_COUNT; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (attempt < NETWORK_RETRY_COUNT && isTransientNetworkError(error)) {
        logger.warn(`[Volcengine] ${label} 网络错误(${error.code || error.message})，${NETWORK_RETRY_DELAY_MS / 1000}s 后重试 (${attempt}/${NETWORK_RETRY_COUNT})`);
        await new Promise((r) => setTimeout(r, NETWORK_RETRY_DELAY_MS));
        continue;
      }
      throw error;
    }
  }
  throw new Error("unreachable");
}

const VOLCENGINE_ERROR_MAP: [string, string][] = [
  ["SensitiveContentDetected.SevereViolation", "输入内容可能包含严重违规信息，请更换后重试"],
  ["SensitiveContentDetected.Violence", "输入内容可能包含暴力相关信息，请更换后重试"],
  ["SensitiveContentDetected", "输入内容可能包含敏感信息，请更换后重试"],
  ["InputTextSensitiveContentDetected.PolicyViolation", "输入文本可能涉及版权限制，请更换后重试"],
  ["InputImageSensitiveContentDetected.PolicyViolation", "输入图片可能涉及版权限制，请更换后重试"],
  ["InputImageSensitiveContentDetected.PrivacyInformation", "输入图片可能包含真人，请更换后重试"],
  ["InputVideoSensitiveContentDetected.PolicyViolation", "输入视频可能涉及版权限制，请更换后重试"],
  ["InputVideoSensitiveContentDetected.PrivacyInformation", "输入视频可能包含真人，请更换后重试"],
  ["OutputVideoSensitiveContentDetected.PolicyViolation", "生成的视频可能涉及版权限制，请更换输入内容后重试"],
  ["InputTextSensitiveContentDetected", "输入文本可能包含敏感信息，请更换后重试"],
  ["InputImageSensitiveContentDetected", "输入图像可能包含敏感信息，请更换后重试"],
  ["InputVideoSensitiveContentDetected", "输入视频可能包含敏感信息，请更换后重试"],
  ["InputAudioSensitiveContentDetected", "输入音频可能包含敏感信息，请更换后重试"],
  ["OutputTextSensitiveContentDetected", "生成的文字可能包含敏感信息，请更换输入内容后重试"],
  ["OutputImageSensitiveContentDetected", "生成的图像可能包含敏感信息，请更换输入内容后重试"],
  ["OutputVideoSensitiveContentDetected", "生成的视频可能包含敏感信息，请更换输入内容后重试"],
  ["OutputAudioSensitiveContentDetected", "生成的音频可能包含敏感信息，请更换输入内容后重试"],
  ["InputTextRiskDetection", "输入文本包含敏感信息，请更换后重试"],
  ["InputImageRiskDetection", "输入图片包含敏感信息，请更换后重试"],
  ["OutputTextRiskDetection", "输出文本包含敏感信息，请更换输入内容后重试"],
  ["OutputImageRiskDetection", "输出图片包含敏感信息，请更换输入内容后重试"],
  ["ContentSecurityDetectionError", "内容安全检测服务异常，请稍后重试"],
  ["InvalidEndpoint.ClosedEndpoint", "推理接入点已关闭或暂时不可用，请稍后重试"],
  ["MissingParameter", "请求缺少必要参数"],
  ["InvalidParameter", "请求包含非法参数"],
  ["AuthenticationError", "API Key 校验未通过"],
  ["InvalidAccountStatus", "账号状态异常"],
  ["AccountOverdueError", "账号欠费，请充值后重试"],
  ["AccessDenied", "无访问权限"],
  ["OperationDenied.ServiceNotOpen", "模型服务未开通"],
  ["OperationDenied.ServiceOverdue", "账单已逾期，请充值后重试"],
  ["InvalidEndpointOrModel.NotFound", "模型或推理接入点不存在"],
  ["ModelNotOpen", "模型服务未开通"],
  ["RateLimitExceeded", "请求频率超限，请稍后重试"],
  ["ModelAccountRpmRateLimitExceeded", "模型请求频率超限(RPM)，请稍后重试"],
  ["ModelAccountTpmRateLimitExceeded", "模型请求频率超限(TPM)，请稍后重试"],
  ["ModelAccountIpmRateLimitExceeded", "模型请求频率超限(IPM)，请稍后重试"],
  ["AccountRateLimitExceeded", "请求频率超限，请稍后重试"],
  ["QuotaExceeded", "额度已用完，请稍后重试"],
  ["ServerOverloaded", "服务资源紧张，请稍后重试"],
  ["RequestBurstTooFast", "请求量激增，请放缓后重试"],
  ["InternalServiceError", "服务内部异常，请稍后重试"],
];

function getReadableVolcengineError(code: string): string {
  if (!code || code === "unknown") return "未知错误";
  for (const [prefix, msg] of VOLCENGINE_ERROR_MAP) {
    if (code === prefix || code.startsWith(prefix + ".")) return msg;
  }
  return `错误(${code})`;
}

const SENSITIVE_ERROR_PREFIXES = [
  "SensitiveContentDetected",
  "InputTextSensitiveContentDetected",
  "InputImageSensitiveContentDetected",
  "InputVideoSensitiveContentDetected",
  "InputAudioSensitiveContentDetected",
  "OutputTextSensitiveContentDetected",
  "OutputImageSensitiveContentDetected",
  "OutputVideoSensitiveContentDetected",
  "OutputAudioSensitiveContentDetected",
  "InputTextRiskDetection",
  "InputImageRiskDetection",
  "OutputTextRiskDetection",
  "OutputImageRiskDetection",
];

function isSensitiveContentError(code: string): boolean {
  if (!code) return false;
  return SENSITIVE_ERROR_PREFIXES.some((p) => code === p || code.startsWith(p + "."));
}

function getArkModel(_model: string): string {
  if (_model.includes("fast")) {
    return config.system.arkFastModel;
  }
  return config.system.arkModel;
}

export function splitArkApiKeys(value: string): string[] {
  return [...new Set(value
    .split(/[,\n]/)
    .map((key) => key.trim())
    .filter(Boolean))];
}

function getEndpoints(): ArkEndpoint[] {
  const endpoints: ArkEndpoint[] = [];
  const agentPlanApiKeys = splitArkApiKeys(config.system.arkAgentPlanApiKey);
  for (let i = 0; i < agentPlanApiKeys.length; i++) {
    endpoints.push({
      baseUrl: ARK_AGENT_PLAN_BASE_URL,
      apiKey: agentPlanApiKeys[i],
      label: agentPlanApiKeys.length === 1 ? "AgentPlan" : `AgentPlan#${i + 1}`,
    });
  }
  if (config.system.arkApiKey) {
    endpoints.push({
      baseUrl: ARK_BASE_URL,
      apiKey: config.system.arkApiKey,
      label: "Standard",
    });
  }
  return endpoints;
}

function buildContent(
  prompt: string,
  filePaths: string[],
  functionMode: string
): any[] {
  const content: any[] = [];

  if (prompt) {
    content.push({ type: "text", text: prompt });
  }

  if (filePaths.length === 0) return content;

  if (functionMode === "omni_reference") {
    for (const url of filePaths) {
      const isVideo = /\.(mp4|mov|avi|mkv|webm|flv|wmv|m4v)(\?|$)/i.test(url)
        || /^data:video\//i.test(url);
      if (isVideo) {
        content.push({
          type: "video_url",
          video_url: { url },
          role: "reference_video",
        });
      } else {
        content.push({
          type: "image_url",
          image_url: { url },
          role: "reference_image",
        });
      }
    }
  } else {
    content.push({
      type: "image_url",
      image_url: { url: filePaths[0] },
      role: "first_frame",
    });
    if (filePaths.length >= 2) {
      content.push({
        type: "image_url",
        image_url: { url: filePaths[1] },
        role: "last_frame",
      });
    }
  }

  return content;
}

async function createTask(
  arkModel: string,
  content: any[],
  options: { ratio?: string; resolution?: string; duration?: number },
  endpoint: ArkEndpoint
): Promise<string> {
  const body: any = {
    model: arkModel,
    content,
  };

  if (options.ratio && options.ratio !== "adaptive") {
    body.ratio = options.ratio;
  }
  if (options.resolution) {
    body.resolution = options.resolution;
  }
  if (options.duration && options.duration >= 4 && options.duration <= 15) {
    body.duration = options.duration;
  }
  body.watermark = false;

  logger.info(`[Volcengine][${endpoint.label}] 创建视频任务, model=${arkModel}, ratio=${options.ratio}, duration=${options.duration}`);
  logger.debug(`[Volcengine][${endpoint.label}] 请求体: ${JSON.stringify(body, null, 2)}`);

  let response: any;
  try {
    response = await withNetworkRetry(
      () =>
        axios.post(endpoint.baseUrl, body, {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${endpoint.apiKey}`,
          },
          timeout: config.system.arkCreateTaskTimeoutMs,
          proxy: false,
        }),
      `创建任务(${endpoint.label})`
    );
  } catch (error: any) {
    if (error?.response) {
      const { status, data } = error.response;
      const errCode = data?.error?.code || "unknown";
      const errMsg = data?.error?.message || JSON.stringify(data);
      logger.error(`[Volcengine][${endpoint.label}] 创建任务HTTP错误, status=${status}, code=${errCode}, message=${errMsg}`);
      throw new APIException(EX.API_VIDEO_GENERATION_FAILED, `[火山引擎] ${getReadableVolcengineError(errCode)}: ${errMsg}`).setData({ volcengineErrorCode: errCode });
    }
    throw error;
  }

  const taskId = response.data?.id;
  if (!taskId) {
    logger.error(`[Volcengine][${endpoint.label}] 创建任务失败，响应: ${JSON.stringify(response.data)}`);
    throw new APIException(EX.API_VIDEO_GENERATION_FAILED, `[火山引擎] 创建视频任务失败`);
  }

  logger.info(`[Volcengine][${endpoint.label}] 任务创建成功, task_id=${taskId}`);
  return taskId;
}

async function queryTask(taskId: string, endpoint: ArkEndpoint): Promise<any> {
  try {
    const response = await axios.get(`${endpoint.baseUrl}/${taskId}`, {
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
      timeout: 30_000,
      proxy: false,
    });
    return response.data;
  } catch (error: any) {
    if (error?.response) {
      const { status, data } = error.response;
      const errCode = data?.error?.code || "unknown";
      const errMsg = data?.error?.message || JSON.stringify(data);
      logger.error(`[Volcengine][${endpoint.label}] 查询任务HTTP错误, task_id=${taskId}, status=${status}, code=${errCode}, message=${errMsg}`);
    }
    throw error;
  }
}

function extractVideoUrl(taskResult: any): string | null {
  if (!taskResult?.content) return null;

  const contentItems = Array.isArray(taskResult.content) ? taskResult.content : [taskResult.content];
  for (const item of contentItems) {
    if (item?.type === "video_url" && item?.video_url?.url) {
      return item.video_url.url;
    }
    if (item?.video_url) {
      return item.video_url;
    }
  }

  if (taskResult.video_url) return taskResult.video_url;

  const str = JSON.stringify(taskResult);
  const match = str.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
  return match ? match[0] : null;
}

export async function resolveTaskEndpoint(taskId: string): Promise<ArkEndpoint> {
  const endpoints = getEndpoints();
  for (const ep of endpoints) {
    try {
      const result = await queryTask(taskId, ep);
      if (result?.id || result?.status) {
        logger.info(`[Volcengine] 恢复任务 ${taskId} 匹配到 ${ep.label} 渠道`);
        return ep;
      }
    } catch {
      // ignore, try next
    }
  }
  if (endpoints.length > 0) {
    logger.warn(`[Volcengine] 恢复任务 ${taskId} 无法确定渠道，使用 ${endpoints[0].label}`);
    return endpoints[0];
  }
  return { baseUrl: ARK_BASE_URL, apiKey: config.system.arkApiKey, label: "Standard" };
}

export async function pollUntilDone(taskId: string, endpoint: ArkEndpoint): Promise<string> {
  const startTime = Date.now();
  let pollCount = 0;

  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    pollCount++;

    try {
      const result = await queryTask(taskId, endpoint);
      const status = result?.status;

      logger.info(`[Volcengine][${endpoint.label}] 轮询 #${pollCount}, task_id=${taskId}, status=${status}`);

      if (status === "succeeded") {
        const videoUrl = extractVideoUrl(result);
        if (videoUrl) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          logger.info(`[Volcengine] 视频生成成功, URL=${videoUrl}, 耗时=${elapsed}s, 轮询=${pollCount}次`);
          return videoUrl;
        }
        logger.error(`[Volcengine] 任务成功但未找到视频URL, response=${JSON.stringify(result)}`);
        throw new APIException(EX.API_VIDEO_GENERATION_FAILED, `[火山引擎] 任务成功但未找到视频URL`);
      }

      if (status === "failed") {
        const errCode = result?.error?.code || "unknown";
        const errMsg = result?.error?.message || "未知错误";
        logger.error(`[Volcengine] 任务失败, task_id=${taskId}, code=${errCode}, message=${errMsg}`);
        throw new APIException(EX.API_VIDEO_GENERATION_FAILED, `[火山引擎] ${getReadableVolcengineError(errCode)}: ${errMsg}`);
      }

      if (status === "expired") {
        logger.error(`[Volcengine] 任务超时`);
        throw new APIException(EX.API_VIDEO_GENERATION_FAILED, `[火山引擎] 视频生成任务超时`);
      }
    } catch (error: any) {
      if (error instanceof APIException) throw error;
      logger.warn(`[Volcengine] 轮询请求失败 #${pollCount}: ${error.message}`);
    }
  }

  throw new APIException(EX.API_VIDEO_GENERATION_FAILED, `[火山引擎] 轮询超时（${POLL_TIMEOUT_MS / 60000}分钟）`);
}

export async function generateVideoViaVolcengine(
  _model: string,
  prompt: string,
  options: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    files?: Record<string, any>;
    functionMode?: string;
  },
  onTaskCreated?: (arkTaskId: string) => void
): Promise<string> {
  const arkModel = getArkModel(_model);
  const functionMode = options.functionMode || "first_last_frames";

  let preparedFilePaths: string[] = [];
  const rawFilePaths = options.filePaths || [];
  const hasFiles = options.files && Object.keys(options.files).length > 0;

  if (hasFiles || rawFilePaths.length > 0) {
    try {
      preparedFilePaths = await prepareFilesForVolcengine(options.files, rawFilePaths);
      logger.info(`[Volcengine] 文件预处理完成, 共 ${preparedFilePaths.length} 个文件`);
    } catch (err: any) {
      logger.warn(`[Volcengine] 文件预处理失败, 使用原始 filePaths: ${err.message}`);
      preparedFilePaths = rawFilePaths;
    }
  }

  const content = buildContent(prompt, preparedFilePaths, functionMode);
  const taskOptions = {
    ratio: options.ratio,
    resolution: options.resolution,
    duration: options.duration,
  };

  const endpoints = getEndpoints();
  if (endpoints.length === 0) {
    throw new APIException(EX.API_VIDEO_GENERATION_FAILED, "[火山引擎] 未配置 ARK API Key");
  }

  let taskId: string | undefined;
  let usedEndpoint: ArkEndpoint | undefined;

  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    try {
      taskId = await createTask(arkModel, content, taskOptions, ep);
      usedEndpoint = ep;
      break;
    } catch (error: any) {
      const volcCode = error?.data?.volcengineErrorCode || "";
      if (isSensitiveContentError(volcCode)) {
        logger.warn(`[Volcengine][${ep.label}] 内容敏感错误，不再回退`);
        throw error;
      }
      if (i < endpoints.length - 1) {
        logger.warn(`[Volcengine][${ep.label}] 创建任务失败(${error.message})，回退到 ${endpoints[i + 1].label}`);
        continue;
      }
      throw error;
    }
  }

  onTaskCreated?.(taskId!);

  return pollUntilDone(taskId!, usedEndpoint!);
}
