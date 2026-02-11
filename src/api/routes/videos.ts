import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { tokenSplit } from '@/api/controllers/core.ts';
import { generateVideo, submitVideoTaskAsync, queryVideoTask, DEFAULT_MODEL } from '@/api/controllers/videos.ts';
import APIException from '@/lib/exceptions/APIException.ts';
import EX from '@/api/consts/exceptions.ts';
import taskStore from '@/lib/task-store.ts';
import util from '@/lib/util.ts';
import logger from '@/lib/logger.ts';

export default {

    prefix: '/v1/videos',

    post: {

        '/generations': async (request: Request) => {
            const contentType = request.headers['content-type'] || '';
            const isMultiPart = contentType.startsWith('multipart/form-data');

            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.prompt', _.isString)
                .validate('body.ratio', v => _.isUndefined(v) || _.isString(v))
                .validate('body.resolution', v => _.isUndefined(v) || _.isString(v))
                .validate('body.duration', v => {
                    if (_.isUndefined(v)) return true;
                    // 支持的时长范围: 4~15 (seedance 2.0 支持任意整数秒)
                    let num: number;
                    if (isMultiPart && typeof v === 'string') {
                        num = parseInt(v);
                    } else if (_.isFinite(v)) {
                        num = v as number;
                    } else {
                        return false;
                    }
                    return Number.isInteger(num) && num >= 4 && num <= 15;
                })
                // 限制图片URL数量最多5个（Seedance 2.0 多图模式支持3-5张）
                .validate('body.file_paths', v => _.isUndefined(v) || (_.isArray(v) && v.length <= 5))
                .validate('body.filePaths', v => _.isUndefined(v) || (_.isArray(v) && v.length <= 5))
                .validate('body.response_format', v => _.isUndefined(v) || _.isString(v))
                .validate('body.image_mode', v => _.isUndefined(v) || (_.isString(v) && ['keyframe', 'reference'].includes(v)))
                .validate('body.async', v => _.isUndefined(v) || _.isBoolean(v) || (isMultiPart && (v === 'true' || v === 'false')))
                .validate('headers.authorization', _.isString);

            // 限制上传文件数量最多5个（Seedance 2.0 参考模式支持3-5个文件，包括图片和视频）
            const uploadedFiles = request.files ? _.values(request.files) : [];
            if (uploadedFiles.length > 5) {
                throw new Error('最多只能上传5个文件');
            }

            // refresh_token切分
            const tokens = tokenSplit(request.headers.authorization);
            // 随机挑选一个refresh_token
            const token = _.sample(tokens);

            const {
                model = DEFAULT_MODEL,
                prompt,
                ratio = "1:1",
                resolution = "720p",
                duration = 5,
                file_paths = [],
                filePaths = [],
                image_mode = "keyframe",
                response_format = "url",
                async: isAsync = false
            } = request.body;

            // 如果是 multipart/form-data，需要将字符串转换为对应类型
            const finalDuration = isMultiPart && typeof duration === 'string'
                ? parseInt(duration)
                : duration;
            const finalAsync = isMultiPart && typeof isAsync === 'string'
                ? isAsync === 'true'
                : isAsync;

            // 兼容两种参数名格式：file_paths 和 filePaths
            const finalFilePaths = filePaths.length > 0 ? filePaths : file_paths;

            // === 异步模式 ===
            if (finalAsync) {
                const taskId = taskStore.createTask({
                    model, prompt, ratio, resolution,
                    duration: finalDuration, filePaths: finalFilePaths, image_mode
                });

                // 后台启动任务（不 await）
                submitVideoTaskAsync(
                    taskId, model, prompt,
                    { ratio, resolution, duration: finalDuration, filePaths: finalFilePaths, files: request.files, imageMode: image_mode },
                    token
                ).catch(err => {
                    logger.error(`异步任务 ${taskId} 未捕获异常: ${err.message}`);
                });

                return {
                    task_id: taskId,
                    status: 'pending',
                    message: '视频生成任务已提交，请使用 task_id 查询进度',
                    created: util.unixTimestamp()
                };
            }

            // === 同步模式（原有逻辑不变） ===
            const videoUrl = await generateVideo(
                model,
                prompt,
                {
                    ratio,
                    resolution,
                    duration: finalDuration,
                    filePaths: finalFilePaths,
                    files: request.files, // 传递上传的文件
                    imageMode: image_mode,
                },
                token
            );

            // 根据response_format返回不同格式的结果
            if (response_format === "b64_json") {
                // 获取视频内容并转换为BASE64
                const videoBase64 = await util.fetchFileBASE64(videoUrl);
                return {
                    created: util.unixTimestamp(),
                    data: [{
                        b64_json: videoBase64,
                        revised_prompt: prompt
                    }]
                };
            } else {
                // 默认返回URL
                return {
                    created: util.unixTimestamp(),
                    data: [{
                        url: videoUrl,
                        revised_prompt: prompt
                    }]
                };
            }
        }

    },

    get: {

        '/generations/:task_id': async (request: Request) => {
            request.validate('headers.authorization', _.isString);

            const { task_id } = request.params;
            if (!task_id || typeof task_id !== 'string') {
                throw new APIException(EX.API_REQUEST_PARAMS_INVALID, '缺少 task_id 参数');
            }

            const task = queryVideoTask(task_id);
            if (!task) {
                throw new APIException(EX.API_VIDEO_TASK_NOT_FOUND, `任务 ${task_id} 不存在或已过期`);
            }

            const response: any = {
                task_id: task.task_id,
                status: task.status,
                progress: {
                    upstream_status: task.upstream_status,
                    progress_text: task.progress_text,
                    poll_count: task.poll_count,
                    elapsed_seconds: task.elapsed_seconds,
                },
                created_at: task.created_at,
                updated_at: task.updated_at,
                expires_at: task.expires_at,
            };

            if (task.status === 'completed' && task.video_url) {
                response.data = [{
                    url: task.video_url,
                    revised_prompt: JSON.parse(task.request_params).prompt
                }];
            }

            if (task.status === 'failed' && task.error_message) {
                response.error = {
                    message: task.error_message
                };
            }

            return response;
        }

    }

}
