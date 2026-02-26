import _ from "lodash";
import fs from "fs-extra";
import axios from "axios";

import APIException from "@/lib/exceptions/APIException.ts";

import EX from "@/api/consts/exceptions.ts";
import util from "@/lib/util.ts";
import { getCredit, receiveCredit, request, parseRegionFromToken, parseProxyFromToken, getAssistantId, checkImageContent, RegionInfo, WEB_ID } from "./core.ts";
import logger from "@/lib/logger.ts";
import { SmartPoller, PollingStatus } from "@/lib/smart-poller.ts";
import { DEFAULT_ASSISTANT_ID_CN, DEFAULT_VIDEO_MODEL, DRAFT_VERSION, DRAFT_VERSION_OMNI, OMNI_BENEFIT_TYPE, OMNI_BENEFIT_TYPE_FAST, VIDEO_MODEL_MAP, VIDEO_MODEL_MAP_US, VIDEO_MODEL_MAP_ASIA, STATUS_CODE_MAP, BASE_URL_CN, REGION_CN } from "@/api/consts/common.ts";
import { WEB_VERSION } from "@/api/consts/dreamina.ts";
import { uploadImageBuffer, ImageUploadResult } from "@/lib/image-uploader.ts";
import { uploadVideoBuffer, VideoUploadResult } from "@/lib/video-uploader.ts";
import { extractVideoUrl } from "@/lib/image-utils.ts";
import taskStore from "@/lib/task-store.ts";
import browserService from "@/lib/browser-service.ts";

export const DEFAULT_MODEL = DEFAULT_VIDEO_MODEL;

export function getModel(model: string, regionInfo: RegionInfo) {
  // 根据站点选择不同的模型映射
  let modelMap: Record<string, string>;
  if (regionInfo.isUS) {
    modelMap = VIDEO_MODEL_MAP_US;
  } else if (regionInfo.isHK || regionInfo.isJP || regionInfo.isSG) {
    modelMap = VIDEO_MODEL_MAP_ASIA;
  } else {
    modelMap = VIDEO_MODEL_MAP;
  }
  return modelMap[model] || modelMap[DEFAULT_MODEL] || VIDEO_MODEL_MAP[DEFAULT_MODEL];
}

function getVideoBenefitType(model: string): string {
  // veo3.1 模型 (需先于 veo3 检查)
  if (model.includes("veo3.1")) {
    return "generate_video_veo3.1";
  }
  // veo3 模型
  if (model.includes("veo3")) {
    return "generate_video_veo3";
  }
  // sora2 模型
  if (model.includes("sora2")) {
    return "generate_video_sora2";
  }
  if (model.includes("40_pro")) {
    return "dreamina_video_seedance_20_pro";
  }
  if (model.includes("40")) {
    return "dreamina_video_seedance_20_fast";
  }
  if (model.includes("3.5_pro")) {
    return "dreamina_video_seedance_15_pro";
  }
  if (model.includes("3.5")) {
    return "dreamina_video_seedance_15";
  }
  return "basic_video_operation_vgfm_v_three";
}

// 处理本地上传的图片文件
async function uploadImageFromFile(file: any, refreshToken: string, regionInfo: RegionInfo): Promise<ImageUploadResult> {
  try {
    logger.info(`开始从本地文件上传图片: ${file.originalFilename} (路径: ${file.filepath})`);
    const imageBuffer = await fs.readFile(file.filepath);
    return await uploadImageBuffer(imageBuffer, refreshToken, regionInfo);
  } catch (error: any) {
    logger.error(`从本地文件上传图片失败: ${error.message}`);
    throw error;
  }
}

// 处理来自URL的图片
async function uploadImageFromUrl(imageUrl: string, refreshToken: string, regionInfo: RegionInfo): Promise<ImageUploadResult> {
  try {
    logger.info(`开始从URL下载并上传图片: ${imageUrl}`);
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      proxy: false,
    });
    if (imageResponse.status < 200 || imageResponse.status >= 300) {
      throw new Error(`下载图片失败: ${imageResponse.status}`);
    }
    const imageBuffer = imageResponse.data;
    return await uploadImageBuffer(imageBuffer, refreshToken, regionInfo);
  } catch (error: any) {
    logger.error(`从URL上传图片失败: ${error.message}`);
    throw error;
  }
}

/**
 * 解析 omni_reference 模式的 prompt，将 @引用 拆解为 meta_list
 * 输入: "@image_file_1作为首帧，@image_file_2作为尾帧，运动动作模仿@video_file"
 * 输出: 交替的 text + material_ref 段
 */
function parseOmniPrompt(prompt: string, materialRegistry: Map<string, any>): any[] {
  // 收集所有可识别的引用名（字段名 + 原始文件名），转义正则特殊字符
  const refNames = [...materialRegistry.keys()]
    .sort((a, b) => b.length - a.length) // 长名优先匹配
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (refNames.length === 0) {
    return [{ meta_type: "text", text: prompt }];
  }

  const pattern = new RegExp(`@(${refNames.join('|')})`, 'g');
  const meta_list: any[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(prompt)) !== null) {
    // 文本段
    if (match.index > lastIndex) {
      const textSegment = prompt.slice(lastIndex, match.index);
      if (textSegment) {
        meta_list.push({ meta_type: "text", text: textSegment });
      }
    }
    // 引用段
    const refName = match[1];
    const entry = materialRegistry.get(refName);
    if (entry) {
      meta_list.push({
        meta_type: entry.type,
        text: "",
        material_ref: { material_idx: entry.idx },
      });
    }
    lastIndex = pattern.lastIndex;
  }

  // 尾部文本
  if (lastIndex < prompt.length) {
    meta_list.push({ meta_type: "text", text: prompt.slice(lastIndex) });
  }

  // 如果没有任何 @ 引用，把整个 prompt 作为文本段
  if (meta_list.length === 0) {
    meta_list.push({ meta_type: "text", text: prompt });
  }

  return meta_list;
}


/**
 * 准备参数并提交视频生成任务
 * 包含：区域检测、模型映射、时长处理、积分检查、图片上传、构建请求、提交任务
 *
 * @returns historyId
 */
async function prepareAndSubmitVideo(
  _model: string,
  prompt: string,
  {
    ratio = "1:1",
    resolution = "720p",
    duration = 5,
    filePaths = [],
    files = {},
    functionMode = "first_last_frames",
  }: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    files?: any;
    functionMode?: string;
  },
  refreshToken: string
): Promise<string> {
  // 检测区域
  const regionInfo = parseRegionFromToken(refreshToken);
  const { isInternational } = regionInfo;

  logger.info(`视频生成区域检测: isInternational=${isInternational}`);

  const model = getModel(_model, regionInfo);
  const isVeo3 = model.includes("veo3");
  const isSora2 = model.includes("sora2");
  const is35Pro = model.includes("3.5_pro");
  const is40Pro = model.includes("40_pro");
  const is40 = model.includes("40") && !model.includes("40_pro");
  // 只有 video-3.0 和 video-3.0-fast 支持 resolution 参数（3.0-pro 和 3.5-pro 不支持）
  const supportsResolution = (model.includes("vgfm_3.0") || model.includes("vgfm_3.0_fast")) && !model.includes("_pro");

  // 将秒转换为毫秒
  let durationMs: number;
  let actualDuration: number;
  if (isVeo3) {
    durationMs = 8000;
    actualDuration = 8;
  } else if (isSora2) {
    if (duration === 12) {
      durationMs = 12000;
      actualDuration = 12;
    } else if (duration === 8) {
      durationMs = 8000;
      actualDuration = 8;
    } else {
      durationMs = 4000;
      actualDuration = 4;
    }
  } else if (is40Pro || is40) {
    // seedance 2.0 和 2.0-fast: 支持 4~15 秒，clamp 到有效范围，默认 5 秒
    actualDuration = Math.max(4, Math.min(15, duration));
    durationMs = actualDuration * 1000;
  } else if (is35Pro) {
    if (duration === 12) {
      durationMs = 12000;
      actualDuration = 12;
    } else if (duration === 10) {
      durationMs = 10000;
      actualDuration = 10;
    } else {
      durationMs = 5000;
      actualDuration = 5;
    }
  } else {
    durationMs = duration === 10 ? 10000 : 5000;
    actualDuration = duration === 10 ? 10 : 5;
  }

  logger.info(`使用模型: ${_model} 映射模型: ${model} 比例: ${ratio} 分辨率: ${supportsResolution ? resolution : '不支持'} 时长: ${actualDuration}s`);

  // 检查积分
  const { totalCredit } = await getCredit(refreshToken);
  if (totalCredit <= 0) {
    logger.info("积分为 0，尝试收取今日积分...");
    try {
      await receiveCredit(refreshToken);
    } catch (receiveError) {
      logger.warn(`收取积分失败: ${receiveError.message}. 这可能是因为: 1) 今日已收取过积分, 2) 账户受到风控限制, 3) 需要在官网手动收取首次积分`);
      throw new APIException(EX.API_VIDEO_GENERATION_FAILED,
        `积分不足且无法自动收取。请访问即梦官网手动收取首次积分，或检查账户状态。`);
    }
  }

  const isOmniMode = functionMode === "omni_reference";

  // omni_reference 仅支持 seedance 2.0 (40_pro) 和 2.0-fast (40) 模型
  if (isOmniMode && !is40Pro && !is40) {
    throw new APIException(EX.API_REQUEST_FAILED,
      `omni_reference 模式仅支持 jimeng-video-seedance-2.0 和 jimeng-video-seedance-2.0-fast 模型`);
  }

  // omni_reference 模式: 支持 multipart 上传和 file_paths URL，从文件类型自动判断图片/视频

  let requestData: any;

  if (isOmniMode) {
    // ========== omni_reference 分支 ==========
    logger.info(`进入 omni_reference 全能模式`);

    // 从文件扩展名/MIME类型判断文件类型
    const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v']);
    const AUDIO_EXTS = new Set(['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'wma', 'opus']);
    function getFileTypeFromName(filename: string): "image" | "video" | "audio" {
      const ext = (filename || '').toLowerCase().split('.').pop() || '';
      if (AUDIO_EXTS.has(ext)) return 'audio';
      if (VIDEO_EXTS.has(ext)) return 'video';
      return 'image';
    }

    // 素材注册表
    interface MaterialEntry {
      idx: number;
      type: "image" | "video" | "audio";
      refName: string;
      originalFilename: string;
      imageUri?: string;
      imageWidth?: number;
      imageHeight?: number;
      imageFormat?: string;
      videoResult?: VideoUploadResult;
      audioVid?: string;
      audioDuration?: number;
    }
    const materialRegistry: Map<string, MaterialEntry> = new Map();
    let materialIdx = 0;
    let imageCount = 0;
    let videoCount = 0;

    // 处理 multipart 上传的文件
    // 兼容两种方式：
    //   1. 旧版具名字段: image_file_1, image_file_2, video_file（类型由字段名决定）
    //   2. 通用字段名: file_paths 或任意字段名（类型由文件扩展名/MIME自动判断）
    const LEGACY_IMAGE_FIELDS = new Set(['image_file_1', 'image_file_2']);
    const LEGACY_VIDEO_FIELDS = new Set(['video_file']);

    for (const [fieldName, fieldFiles] of Object.entries(files || {})) {
      const fileList = Array.isArray(fieldFiles) ? fieldFiles : [fieldFiles];
      for (const file of fileList) {
        if (!file) continue;

        let refName: string;
        let fileType: "image" | "video" | "audio";

        if (LEGACY_IMAGE_FIELDS.has(fieldName)) {
          // 旧版具名字段: 用字段名作为引用名，类型由字段名决定
          refName = fieldName;
          fileType = 'image';
        } else if (LEGACY_VIDEO_FIELDS.has(fieldName)) {
          refName = fieldName;
          fileType = 'video';
        } else {
          // 通用字段名: 自动编号 file_1, file_2, ...，类型从 MIME/扩展名判断
          refName = `file_${materialIdx + 1}`;
          fileType = file.mimetype?.startsWith('video/') ? 'video' as const
                   : file.mimetype?.startsWith('audio/') ? 'audio' as const
                   : file.mimetype?.startsWith('image/') ? 'image' as const
                   : getFileTypeFromName(file.originalFilename);
        }

      if (fileType === 'video') {
        videoCount++;
        if (videoCount > 3) throw new APIException(EX.API_REQUEST_FAILED, `最多只能上传3个视频文件`);

        try {
          logger.info(`[omni] 上传视频 ${refName}: ${file.originalFilename}`);
          const buf = await fs.readFile(file.filepath);
          const vResult = await uploadVideoBuffer(buf, refreshToken, regionInfo);
          const entry: MaterialEntry = { idx: materialIdx++, type: "video", refName, originalFilename: file.originalFilename, videoResult: vResult };
          materialRegistry.set(refName, entry);
          if (file.originalFilename && file.originalFilename !== refName) {
            materialRegistry.set(file.originalFilename, entry);
          }
          logger.info(`[omni] ${refName} 视频上传成功: vid=${vResult.vid}, ${vResult.videoMeta.width}x${vResult.videoMeta.height}, ${vResult.videoMeta.duration}s`);
        } catch (error: any) {
          throw new APIException(EX.API_REQUEST_FAILED, `视频文件 ${file.originalFilename} 处理失败: ${error.message}`);
        }
      } else if (fileType === 'audio') {
        try {
          logger.info(`[omni] 上传音频 ${refName}: ${file.originalFilename}`);
          const buf = await fs.readFile(file.filepath);
          // 音频使用 VOD 通道（skipDurationCheck=true），与视频上传流程相同
          const vResult = await uploadVideoBuffer(buf, refreshToken, regionInfo, true);
          const entry: MaterialEntry = { idx: materialIdx++, type: "audio", refName, originalFilename: file.originalFilename, audioVid: vResult.vid, audioDuration: vResult.videoMeta.duration };
          materialRegistry.set(refName, entry);
          if (file.originalFilename && file.originalFilename !== refName) {
            materialRegistry.set(file.originalFilename, entry);
          }
          logger.info(`[omni] ${refName} 音频上传成功: vid=${vResult.vid}, duration=${vResult.videoMeta.duration}s`);
        } catch (error: any) {
          throw new APIException(EX.API_REQUEST_FAILED, `音频文件 ${file.originalFilename} 处理失败: ${error.message}`);
        }
      } else {
        imageCount++;
        if (imageCount > 9) throw new APIException(EX.API_REQUEST_FAILED, `最多只能上传9张图片`);

        try {
          logger.info(`[omni] 上传图片 ${refName}: ${file.originalFilename}`);
          const buf = await fs.readFile(file.filepath);
          const imgResult = await uploadImageBuffer(buf, refreshToken, regionInfo);
          await checkImageContent(imgResult.uri, refreshToken, regionInfo);
          const entry: MaterialEntry = { idx: materialIdx++, type: "image", refName, originalFilename: file.originalFilename, imageUri: imgResult.uri, imageWidth: imgResult.width, imageHeight: imgResult.height, imageFormat: imgResult.format };
          materialRegistry.set(refName, entry);
          if (file.originalFilename && file.originalFilename !== refName) {
            materialRegistry.set(file.originalFilename, entry);
          }
          logger.info(`[omni] ${refName} 图片上传成功: ${imgResult.uri} (${imgResult.width}x${imgResult.height})`);
        } catch (error: any) {
          throw new APIException(EX.API_REQUEST_FAILED, `图片文件 ${file.originalFilename} 处理失败: ${error.message}`);
        }
      }
      }
    }

    // 处理 file_paths URL（从URL扩展名自动判断图片/视频）
    if (filePaths && filePaths.length > 0) {
      for (const fileUrl of filePaths) {
        if (!fileUrl) continue;
        const urlFilename = decodeURIComponent(new URL(fileUrl).pathname.split('/').pop() || '');
        const fileType = getFileTypeFromName(urlFilename || fileUrl);
        const refName = `file_${materialIdx + 1}`;

        if (fileType === 'video') {
          videoCount++;
          if (videoCount > 3) throw new APIException(EX.API_REQUEST_FAILED, `最多只能上传3个视频文件`);

          try {
            logger.info(`[omni] 从URL下载并上传视频 ${refName}: ${fileUrl}`);
            const response = await axios.get(fileUrl, { responseType: 'arraybuffer', proxy: false });
            if (response.status < 200 || response.status >= 300) {
              throw new Error(`下载视频失败: ${response.status}`);
            }
            const vResult = await uploadVideoBuffer(response.data, refreshToken, regionInfo);
            const entry: MaterialEntry = { idx: materialIdx++, type: "video", refName, originalFilename: urlFilename || refName, videoResult: vResult };
            materialRegistry.set(refName, entry);
            if (urlFilename && urlFilename !== refName) {
              materialRegistry.set(urlFilename, entry);
            }
            logger.info(`[omni] ${refName} 视频上传成功: vid=${vResult.vid}`);
          } catch (error: any) {
            throw new APIException(EX.API_REQUEST_FAILED, `视频URL ${fileUrl} 处理失败: ${error.message}`);
          }
        } else if (fileType === 'audio') {
          try {
            logger.info(`[omni] 从URL下载并上传音频 ${refName}: ${fileUrl}`);
            const response = await axios.get(fileUrl, { responseType: 'arraybuffer', proxy: false });
            if (response.status < 200 || response.status >= 300) {
              throw new Error(`下载音频失败: ${response.status}`);
            }
            const vResult = await uploadVideoBuffer(response.data, refreshToken, regionInfo, true);
            const entry: MaterialEntry = { idx: materialIdx++, type: "audio", refName, originalFilename: urlFilename || refName, audioVid: vResult.vid, audioDuration: vResult.videoMeta.duration };
            materialRegistry.set(refName, entry);
            if (urlFilename && urlFilename !== refName) {
              materialRegistry.set(urlFilename, entry);
            }
            logger.info(`[omni] ${refName} 音频上传成功: vid=${vResult.vid}`);
          } catch (error: any) {
            throw new APIException(EX.API_REQUEST_FAILED, `音频URL ${fileUrl} 处理失败: ${error.message}`);
          }
        } else {
          imageCount++;
          if (imageCount > 9) throw new APIException(EX.API_REQUEST_FAILED, `最多只能上传9张图片`);

          try {
            logger.info(`[omni] 从URL下载并上传图片 ${refName}: ${fileUrl}`);
            const imgResult = await uploadImageFromUrl(fileUrl, refreshToken, regionInfo);
            await checkImageContent(imgResult.uri, refreshToken, regionInfo);
            const entry: MaterialEntry = { idx: materialIdx++, type: "image", refName, originalFilename: urlFilename || refName, imageUri: imgResult.uri, imageWidth: imgResult.width, imageHeight: imgResult.height, imageFormat: imgResult.format };
            materialRegistry.set(refName, entry);
            if (urlFilename && urlFilename !== refName) {
              materialRegistry.set(urlFilename, entry);
            }
            logger.info(`[omni] ${refName} 图片上传成功: ${imgResult.uri} (${imgResult.width}x${imgResult.height})`);
          } catch (error: any) {
            throw new APIException(EX.API_REQUEST_FAILED, `图片URL ${fileUrl} 处理失败: ${error.message}`);
          }
        }
      }
    }

    if (materialIdx === 0) {
      throw new APIException(EX.API_REQUEST_FAILED,
        `omni_reference 模式需要至少提供一个素材文件`);
    }

    // 构建 material_list（按注册顺序）
    const orderedEntries = [...new Map([...materialRegistry].filter(([k, v]) => k === v.refName)).values()]
      .sort((a, b) => a.idx - b.idx);

    const material_list: any[] = [];
    const materialTypes: number[] = [];

    for (const entry of orderedEntries) {
      if (entry.type === "image") {
        material_list.push({
          material_type: "image",
          image_info: {
            image_uri: entry.imageUri,
            width: entry.imageWidth || 0,
            height: entry.imageHeight || 0,
            format: entry.imageFormat || "",
            id: util.uuid(),
            name: "",
            platform_type: 1,
            source_from: "upload",
            type: "image",
            uri: entry.imageUri,
          },
        });
        materialTypes.push(1);
      } else if (entry.type === "video") {
        const vm = entry.videoResult!;
        material_list.push({
          material_type: "video",
          video_info: {
            vid: vm.vid,
            width: vm.videoMeta.width,
            height: vm.videoMeta.height,
            duration: Math.round(vm.videoMeta.duration * 1000),
            format: vm.videoMeta.format,
            codec: vm.videoMeta.codec,
            size: vm.videoMeta.size,
            bitrate: vm.videoMeta.bitrate,
            uri: vm.uri,
          },
        });
        materialTypes.push(2);
      } else {
        // audio
        material_list.push({
          material_type: "audio",
          audio_info: {
            type: "audio",
            id: util.uuid(),
            source_from: "upload",
            vid: entry.audioVid,
            duration: entry.audioDuration || 0,
            name: "",
          },
        });
        materialTypes.push(3);
      }
    }

    // 解析 prompt → meta_list
    const meta_list = parseOmniPrompt(prompt, materialRegistry);

    logger.info(`[omni] material_list: ${material_list.length} 项, meta_list: ${meta_list.length} 项, materialTypes: [${materialTypes}]`);

    // 构建 omni payload
    const componentId = util.uuid();
    const submitId = util.uuid();

    const sceneOption = {
      type: "video",
      scene: "BasicVideoGenerateButton",
      modelReqKey: model,
      videoDuration: actualDuration,
      materialTypes,
      reportParams: {
        enterSource: "generate",
        vipSource: "generate",
        extraVipFunctionKey: model,
        useVipFunctionDetailsReporterHoc: true,
      },
    };

    const metricsExtra = JSON.stringify({
      position: "page_bottom_box",
      isDefaultSeed: 1,
      originSubmitId: submitId,
      isRegenerate: false,
      enterFrom: "click",
      functionMode: "omni_reference",
      sceneOptions: JSON.stringify([sceneOption]),
    });

    // 根据模型和素材类型决定 benefit_type
    // 包含视频素材时追加 _with_video 后缀（仅对 FAST 模型适用）
    const hasVideoMaterial = orderedEntries.some(e => e.type === "video");
    const omniBenefitTypeBase = is40 ? OMNI_BENEFIT_TYPE_FAST : OMNI_BENEFIT_TYPE;
    const omniBenefitType = (is40 && hasVideoMaterial)
      ? `${omniBenefitTypeBase}_with_video`
      : omniBenefitTypeBase;

    requestData = {
      params: {
        aigc_features: "app_lip_sync",
        web_version: "7.5.0",
        da_version: DRAFT_VERSION_OMNI,
      },
      data: {
        extend: {
          root_model: model,
          m_video_commerce_info: {
            benefit_type: omniBenefitType,
            resource_id: "generate_video",
            resource_id_type: "str",
            resource_sub_type: "aigc",
          },
          m_video_commerce_info_list: [{
            benefit_type: omniBenefitType,
            resource_id: "generate_video",
            resource_id_type: "str",
            resource_sub_type: "aigc",
          }],
        },
        submit_id: submitId,
        metrics_extra: metricsExtra,
        draft_content: JSON.stringify({
          type: "draft",
          id: util.uuid(),
          min_version: DRAFT_VERSION_OMNI,
          min_features: ["AIGC_Video_UnifiedEdit"],
          is_from_tsn: true,
          version: DRAFT_VERSION_OMNI,
          main_component_id: componentId,
          component_list: [{
            type: "video_base_component",
            id: componentId,
            min_version: "1.0.0",
            aigc_mode: "workbench",
            metadata: {
              type: "",
              id: util.uuid(),
              created_platform: 3,
              created_platform_version: "",
              created_time_in_ms: Date.now().toString(),
              created_did: "",
            },
            generate_type: "gen_video",
            abilities: {
              type: "",
              id: util.uuid(),
              gen_video: {
                id: util.uuid(),
                type: "",
                text_to_video_params: {
                  type: "",
                  id: util.uuid(),
                  video_gen_inputs: [{
                    type: "",
                    id: util.uuid(),
                    min_version: DRAFT_VERSION_OMNI,
                    prompt: "",
                    video_mode: 2,
                    fps: 24,
                    duration_ms: durationMs,
                    unified_edit_input: {
                      type: "",
                      id: util.uuid(),
                      material_list,
                      meta_list,
                    },
                    idip_meta_list: [],
                  }],
                  video_aspect_ratio: ratio,
                  seed: Math.floor(Math.random() * 4294967296),
                  model_req_key: model,
                  priority: 0,
                },
                video_task_extra: metricsExtra,
              },
            },
            process_type: 1,
          }],
        }),
        http_common_info: {
          aid: getAssistantId(regionInfo),
        },
      },
    };
  } else {
    // ========== first_last_frames 分支（原有逻辑） ==========
    let first_frame_image = undefined;
    let end_frame_image = undefined;
    let uploadIDs: string[] = [];

    // 优先处理本地上传的文件
    const uploadedFiles = _.flatten(_.values(files)).filter(Boolean);
    if (uploadedFiles && uploadedFiles.length > 0) {
      logger.info(`检测到 ${uploadedFiles.length} 个本地上传文件，优先处理`);
      for (let i = 0; i < uploadedFiles.length; i++) {
        const file = uploadedFiles[i];
        if (!file) continue;
        try {
          logger.info(`开始上传第 ${i + 1} 张本地图片: ${file.originalFilename}`);
          const imgResult = await uploadImageFromFile(file, refreshToken, regionInfo);
          if (imgResult) {
            await checkImageContent(imgResult.uri, refreshToken, regionInfo);
            uploadIDs.push(imgResult.uri);
            logger.info(`第 ${i + 1} 张本地图片上传成功: ${imgResult.uri}`);
          } else {
            logger.error(`第 ${i + 1} 张本地图片上传失败: 未获取到 image_uri`);
          }
        } catch (error: any) {
          logger.error(`第 ${i + 1} 张本地图片上传失败: ${error.message}`);
          if (i === 0) {
            throw new APIException(EX.API_REQUEST_FAILED, `首帧图片上传失败: ${error.message}`);
          }
        }
      }
    } else if (filePaths && filePaths.length > 0) {
      logger.info(`未检测到本地上传文件，处理 ${filePaths.length} 个图片URL`);
      for (let i = 0; i < filePaths.length; i++) {
        const filePath = filePaths[i];
        if (!filePath) {
          logger.warn(`第 ${i + 1} 个图片URL为空，跳过`);
          continue;
        }
        try {
          logger.info(`开始上传第 ${i + 1} 个URL图片: ${filePath}`);
          const imgResult = await uploadImageFromUrl(filePath, refreshToken, regionInfo);
          if (imgResult) {
            await checkImageContent(imgResult.uri, refreshToken, regionInfo);
            uploadIDs.push(imgResult.uri);
            logger.info(`第 ${i + 1} 个URL图片上传成功: ${imgResult.uri}`);
          } else {
            logger.error(`第 ${i + 1} 个URL图片上传失败: 未获取到 image_uri`);
          }
        } catch (error: any) {
          logger.error(`第 ${i + 1} 个URL图片上传失败: ${error.message}`);
          if (i === 0) {
            throw new APIException(EX.API_REQUEST_FAILED, `首帧图片上传失败: ${error.message}`);
          }
        }
      }
    } else {
      logger.info(`未提供图片文件或URL，将进行纯文本视频生成`);
    }

    if (uploadIDs.length > 0) {
      logger.info(`图片上传完成，共成功 ${uploadIDs.length} 张`);
      if (uploadIDs[0]) {
        first_frame_image = {
          format: "", height: 0, id: util.uuid(), image_uri: uploadIDs[0],
          name: "", platform_type: 1, source_from: "upload", type: "image", uri: uploadIDs[0], width: 0,
        };
        logger.info(`设置首帧图片: ${uploadIDs[0]}`);
      }
      if (uploadIDs[1]) {
        end_frame_image = {
          format: "", height: 0, id: util.uuid(), image_uri: uploadIDs[1],
          name: "", platform_type: 1, source_from: "upload", type: "image", uri: uploadIDs[1], width: 0,
        };
        logger.info(`设置尾帧图片: ${uploadIDs[1]}`);
      }
    }

    const componentId = util.uuid();
    const originSubmitId = util.uuid();
    const flFunctionMode = "first_last_frames";

    const sceneOption = {
      type: "video",
      scene: "BasicVideoGenerateButton",
      ...(supportsResolution ? { resolution } : {}),
      modelReqKey: model,
      videoDuration: actualDuration,
      reportParams: {
        enterSource: "generate",
        vipSource: "generate",
        extraVipFunctionKey: supportsResolution ? `${model}-${resolution}` : model,
        useVipFunctionDetailsReporterHoc: true,
      },
    };

    const metricsExtra = JSON.stringify({
      promptSource: "custom",
      isDefaultSeed: 1,
      originSubmitId,
      isRegenerate: false,
      enterFrom: "click",
      functionMode: flFunctionMode,
      sceneOptions: JSON.stringify([sceneOption]),
    });

    const hasImageInput = uploadIDs.length > 0;
    if (hasImageInput && ratio !== "1:1") {
      logger.warn(`图生视频模式下，ratio参数将被忽略（由输入图片的实际比例决定），但resolution参数仍然有效`);
    }

    logger.info(`视频生成模式: ${uploadIDs.length}张图片 (首帧: ${!!first_frame_image}, 尾帧: ${!!end_frame_image}), resolution: ${resolution}`);

    requestData = {
      params: {
        aigc_features: "app_lip_sync",
        web_version: "7.5.0",
        da_version: DRAFT_VERSION,
      },
      data: {
        extend: {
          root_model: model,
          m_video_commerce_info: {
            benefit_type: getVideoBenefitType(model),
            resource_id: "generate_video",
            resource_id_type: "str",
            resource_sub_type: "aigc",
          },
          m_video_commerce_info_list: [{
            benefit_type: getVideoBenefitType(model),
            resource_id: "generate_video",
            resource_id_type: "str",
            resource_sub_type: "aigc",
          }],
        },
        submit_id: util.uuid(),
        metrics_extra: metricsExtra,
        draft_content: JSON.stringify({
          type: "draft",
          id: util.uuid(),
          min_version: "3.0.5",
          min_features: [],
          is_from_tsn: true,
          version: DRAFT_VERSION,
          main_component_id: componentId,
          component_list: [{
            type: "video_base_component",
            id: componentId,
            min_version: "1.0.0",
            aigc_mode: "workbench",
            metadata: {
              type: "",
              id: util.uuid(),
              created_platform: 3,
              created_platform_version: "",
              created_time_in_ms: Date.now().toString(),
              created_did: "",
            },
            generate_type: "gen_video",
            abilities: {
              type: "",
              id: util.uuid(),
              gen_video: {
                id: util.uuid(),
                type: "",
                text_to_video_params: {
                  type: "",
                  id: util.uuid(),
                  video_gen_inputs: [{
                    type: "",
                    id: util.uuid(),
                    min_version: "3.0.5",
                    prompt,
                    video_mode: 2,
                    fps: 24,
                    duration_ms: durationMs,
                    ...(supportsResolution ? { resolution } : {}),
                    first_frame_image,
                    end_frame_image,
                    idip_meta_list: [],
                  }],
                  video_aspect_ratio: ratio,
                  seed: Math.floor(Math.random() * 4294967296),
                  model_req_key: model,
                  priority: 0,
                },
                video_task_extra: metricsExtra,
              },
            },
            process_type: 1,
          }],
        }),
        http_common_info: {
          aid: getAssistantId(regionInfo),
        },
      },
    };
  }

  // 发送请求
  // Seedance 模型（is40 / is40Pro）通过浏览器代理发送，绕过 shark a_bogus 反爬拦截
  // 其他模型直接使用 axios 请求
  let aigc_data: any;
  if (is40 || is40Pro) {
    // 构建完整 URL（CN 专用，Seedance 不支持国际站）
    const { token: sessionToken } = parseProxyFromToken(refreshToken);
    const generateQueryParams = new URLSearchParams({
      aid: String(DEFAULT_ASSISTANT_ID_CN),
      device_platform: "web",
      region: REGION_CN,
      webId: String(WEB_ID),
      da_version: requestData.params.da_version,
      web_component_open_flag: "1",
      web_version: requestData.params.web_version || WEB_VERSION,
      aigc_features: requestData.params.aigc_features || "app_lip_sync",
    });
    const generateUrl = `${BASE_URL_CN}/mweb/v1/aigc_draft/generate?${generateQueryParams.toString()}`;

    logger.info(`Seedance: 通过浏览器代理发送 generate 请求...`);
    const generateResult = await browserService.fetch(sessionToken, generateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestData.data),
    });

    const { ret, errmsg, data: generateData } = generateResult;
    if (ret !== undefined && Number(ret) !== 0) {
      if (Number(ret) === 5000) {
        throw new APIException(EX.API_IMAGE_GENERATION_FAILED,
          `[无法生成视频]: 即梦积分可能不足，${errmsg}`);
      }
      throw new APIException(EX.API_REQUEST_FAILED, `[请求jimeng失败]: ${errmsg}`);
    }
    aigc_data = generateData?.aigc_data || generateResult.aigc_data;
  } else {
    const videoReferer = regionInfo.isCN
      ? "https://jimeng.jianying.com/ai-tool/generate?type=video"
      : "https://dreamina.capcut.com/ai-tool/generate?type=video";
    const result = await request(
      "post",
      "/mweb/v1/aigc_draft/generate",
      refreshToken,
      {
        ...requestData,
        headers: { Referer: videoReferer },
      }
    );
    aigc_data = result.aigc_data;
  }

  const historyId = aigc_data?.history_record_id;
  if (!historyId)
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  logger.info(`视频生成任务已提交，history_id: ${historyId}，等待生成完成...`);

  return historyId;
}


/**
 * 通过 get_local_item_list API 获取高质量视频下载 URL
 * 比直接从历史记录响应中提取的预览 URL 码率更高
 *
 * @param itemId 视频 item_id
 * @param refreshToken 刷新令牌
 * @returns 高质量视频 URL，失败时返回 null
 */
async function fetchHighQualityVideoUrl(itemId: string, refreshToken: string): Promise<string | null> {
  try {
    logger.info(`尝试获取高质量视频URL，itemId: ${itemId}`);
    const result = await request("post", "/mweb/v1/get_local_item_list", refreshToken, {
      data: {
        item_id_list: [itemId],
        pack_item_opt: { scene: 1, need_data_integrity: true },
        is_for_video_download: true,
      },
    });

    // 策略1: 从结构化字段提取 video.transcoded_video.origin.video_url
    const items = result?.item_list || result?.items || [];
    for (const item of items) {
      const url = item?.video?.transcoded_video?.origin?.video_url;
      if (url && url.includes("jimeng.com")) {
        logger.info(`策略1: 获取到高质量URL: ${url}`);
        return url;
      }
    }

    // 策略2: 正则匹配 dreamnia.jimeng.com 高质量 URL
    const responseStr = JSON.stringify(result);
    const dreamUrl = responseStr.match(/https?:\/\/[^"'\s]*dreamnia\.jimeng\.com[^"'\s]*/);
    if (dreamUrl) {
      logger.info(`策略2: 获取到高质量URL: ${dreamUrl[0]}`);
      return dreamUrl[0];
    }

    // 策略3: 匹配任意 jimeng.com 视频 URL
    const jimengUrl = responseStr.match(/https?:\/\/[^"'\s]*jimeng\.com[^"'\s]*\.mp4[^"'\s]*/);
    if (jimengUrl) {
      logger.info(`策略3: 获取到视频URL: ${jimengUrl[0]}`);
      return jimengUrl[0];
    }

    // 策略4: 兜底匹配 vlabvod/jimeng 域名
    const fallbackUrl = responseStr.match(/https:\/\/v[0-9]+-artist\.vlabvod\.com\/[^"'\s]+/);
    if (fallbackUrl) {
      logger.info(`策略4: 获取到兜底URL: ${fallbackUrl[0]}`);
      return fallbackUrl[0];
    }

    logger.warn(`fetchHighQualityVideoUrl: 未能从响应中提取视频URL`);
    return null;
  } catch (err: any) {
    logger.warn(`fetchHighQualityVideoUrl 调用失败（不影响主流程）: ${err.message}`);
    return null;
  }
}


/**
 * 轮询视频生成结果
 *
 * @param historyId 即梦 history_record_id
 * @param refreshToken 刷新令牌
 * @param onProgress 可选的进度回调
 * @returns 视频URL
 */
async function pollVideoResult(
  historyId: string,
  refreshToken: string,
  onProgress?: (status: number, progressText: string, pollCount: number, elapsedSeconds: number) => void
): Promise<{ videoUrl: string; pollCount: number; elapsedTime: number }> {
  // 首次查询前等待，让服务器有时间处理请求
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // 使用 SmartPoller 进行智能轮询
  const maxPollCount = 1000; // 增加轮询次数，支持更长的生成时间
  let pollAttempts = 0;
  const startTime = Date.now();

  const poller = new SmartPoller({
    maxPollCount,
    pollInterval: 20000, // 20秒基础间隔
    expectedItemCount: 1,
    type: 'video',
    timeoutSeconds: 3600 // 60分钟超时
  });

  const { result: pollingResult, data: finalHistoryData } = await poller.poll(async () => {
    pollAttempts++;
    const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);

    // 使用标准API请求方式
    const result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
      data: {
        history_ids: [historyId],
      },
    });

    // 尝试直接从响应中提取视频URL
    const responseStr = JSON.stringify(result);
    const videoUrlMatch = responseStr.match(/https:\/\/v[0-9]+-artist\.vlabvod\.com\/[^"\s]+/);
    if (videoUrlMatch && videoUrlMatch[0]) {
      logger.info(`从API响应中直接提取到视频URL: ${videoUrlMatch[0]}`);
      onProgress?.(10, STATUS_CODE_MAP[10], pollAttempts, elapsedSeconds);
      // 构造成功状态并返回
      return {
        status: {
          status: 10,
          itemCount: 1,
          historyId
        } as PollingStatus,
        data: {
          status: 10,
          item_list: [{
            video: {
              transcoded_video: {
                origin: {
                  video_url: videoUrlMatch[0]
                }
              }
            }
          }]
        }
      };
    }

    // 检查响应中是否有该 history_id 的数据
    // 由于 API 存在最终一致性，早期轮询可能暂时获取不到记录，返回处理中状态继续轮询
    if (!result[historyId]) {
      logger.warn(`API未返回历史记录 (轮询第${pollAttempts}次)，historyId: ${historyId}，继续等待...`);
      onProgress?.(20, STATUS_CODE_MAP[20], pollAttempts, elapsedSeconds);
      return {
        status: {
          status: 20, // PROCESSING
          itemCount: 0,
          historyId
        } as PollingStatus,
        data: { status: 20, item_list: [] }
      };
    }

    const historyData = result[historyId];

    const currentStatus = historyData.status;
    const currentFailCode = historyData.fail_code;
    const currentItemList = historyData.item_list || [];
    const finishTime = historyData.task?.finish_time || 0;

    // 更新进度回调
    onProgress?.(currentStatus, STATUS_CODE_MAP[currentStatus] || 'UNKNOWN', pollAttempts, elapsedSeconds);

    // 记录详细信息
    if (currentItemList.length > 0) {
      const tempVideoUrl = currentItemList[0]?.video?.transcoded_video?.origin?.video_url ||
                          currentItemList[0]?.video?.play_url ||
                          currentItemList[0]?.video?.download_url ||
                          currentItemList[0]?.video?.url;
      if (tempVideoUrl) {
        logger.info(`检测到视频URL: ${tempVideoUrl}`);
      }
    }

    return {
      status: {
        status: currentStatus,
        failCode: currentFailCode,
        itemCount: currentItemList.length,
        finishTime,
        historyId
      } as PollingStatus,
      data: historyData
    };
  }, historyId);

  const item_list = finalHistoryData.item_list || [];

  // 提取视频URL
  let videoUrl = item_list?.[0] ? extractVideoUrl(item_list[0]) : null;

  // 尝试获取高质量视频 URL（通过 get_local_item_list API）
  const itemId = item_list?.[0]?.item_id
    || item_list?.[0]?.id
    || item_list?.[0]?.local_item_id
    || item_list?.[0]?.common_attr?.id;
  if (itemId) {
    const highQualityUrl = await fetchHighQualityVideoUrl(itemId, refreshToken);
    if (highQualityUrl) {
      videoUrl = highQualityUrl;
    }
  }

  // 如果无法获取视频URL，抛出异常
  if (!videoUrl) {
    logger.error(`未能获取视频URL，item_list: ${JSON.stringify(item_list)}`);
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "未能获取视频URL，请稍后查看");
  }

  logger.info(`视频生成成功，URL: ${videoUrl}，总耗时: ${pollingResult.elapsedTime}秒`);
  return { videoUrl, pollCount: pollingResult.pollCount, elapsedTime: pollingResult.elapsedTime };
}


/**
 * 生成视频（同步模式）
 *
 * @param _model 模型名称
 * @param prompt 提示词
 * @param options 选项
 * @param refreshToken 刷新令牌
 * @returns 视频URL
 */
export async function generateVideo(
  _model: string,
  prompt: string,
  options: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    files?: any;
    functionMode?: string;
  },
  refreshToken: string
) {
  const historyId = await prepareAndSubmitVideo(_model, prompt, options, refreshToken);
  const { videoUrl } = await pollVideoResult(historyId, refreshToken);
  return videoUrl;
}


/**
 * 异步提交视频生成任务
 * 提交任务后在后台轮询，结果写入数据库
 */
export async function submitVideoTaskAsync(
  taskId: string,
  _model: string,
  prompt: string,
  options: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    files?: any;
    functionMode?: string;
  },
  refreshToken: string
): Promise<void> {
  try {
    const historyId = await prepareAndSubmitVideo(_model, prompt, options, refreshToken);

    // 更新任务状态为 processing
    taskStore.updateTaskSubmitted(taskId, historyId);
    logger.info(`异步视频任务 ${taskId} 已提交，history_id: ${historyId}，开始后台轮询...`);

    // 后台轮询，通过 onProgress 回调更新数据库
    const { videoUrl, pollCount, elapsedTime } = await pollVideoResult(
      historyId,
      refreshToken,
      (status, progressText, pollCount, elapsedSeconds) => {
        taskStore.updateTaskProgress(taskId, status, progressText, pollCount, elapsedSeconds);
      }
    );

    // 标记任务完成
    taskStore.completeTask(taskId, videoUrl, pollCount, elapsedTime);
    logger.info(`异步视频任务 ${taskId} 完成，URL: ${videoUrl}`);
  } catch (error: any) {
    logger.error(`异步视频任务 ${taskId} 失败: ${error.message}`);
    taskStore.failTask(taskId, error.errmsg || error.message || '未知错误');
  }
}


/**
 * 查询视频任务状态
 */
export function queryVideoTask(taskId: string) {
  return taskStore.getTask(taskId);
}
