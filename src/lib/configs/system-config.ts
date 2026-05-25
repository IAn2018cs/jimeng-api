import path from 'path';

import fs from 'fs-extra';
import yaml from 'yaml';
import _ from 'lodash';

import environment from '../environment.ts';

const CONFIG_PATH = path.join(path.resolve(), 'configs/', environment.env, "/system.yml");

/**
 * 系统配置
 */
export class SystemConfig {

    /** 是否开启请求日志 */
    requestLog: boolean;
    /** 临时目录路径 */
    tmpDir: string;
    /** 日志目录路径 */
    logDir: string;
    /** 日志写入间隔（毫秒） */
    logWriteInterval: number;
    /** 日志文件有效期（毫秒） */
    logFileExpires: number;
    /** 临时文件有效期（毫秒） */
    tmpFileExpires: number;
    /** 请求体配置 */
    requestBody: any;
    /** 是否调试模式 */
    debug: boolean;
    /** 日志级别 */
    log_level: string;
    /** 存储类型（local_mount / none） */
    storageType: string;
    /** NAS 挂载路径（Docker volume 挂载目录） */
    nasMountPath: string;
    /** NAS 文件 URL 前缀（文件服务访问地址） */
    nasFileUrlPrefix: string;
    /** 火山引擎 ARK API Key（Seedance 备用渠道） */
    arkApiKey: string;
    /** 火山引擎 ARK Agent Plan API Key（优先使用） */
    arkAgentPlanApiKey: string;
    /** 火山引擎 ARK Pro 模型 ID */
    arkModel: string;
    /** 火山引擎 ARK Fast 模型 ID */
    arkFastModel: string;
    /** 火山引擎 TOS Access Key ID */
    tosAccessKeyId: string;
    /** 火山引擎 TOS Access Key Secret */
    tosAccessKeySecret: string;
    /** 火山引擎 TOS 区域 */
    tosRegion: string;
    /** 火山引擎 TOS 端点 */
    tosEndpoint: string;
    /** 火山引擎 TOS 存储桶 */
    tosBucket: string;

    constructor(options?: any) {
        const { requestLog, tmpDir, logDir, logWriteInterval, logFileExpires, tmpFileExpires, requestBody, debug, log_level, storageType, nasMountPath, nasFileUrlPrefix, arkApiKey, arkAgentPlanApiKey, arkModel, arkFastModel, tosAccessKeyId, tosAccessKeySecret, tosRegion, tosEndpoint, tosBucket } = options || {};
        this.requestLog = _.defaultTo(requestLog, false);
        this.tmpDir = _.defaultTo(tmpDir, './tmp');
        this.logDir = _.defaultTo(logDir, './logs');
        this.logWriteInterval = _.defaultTo(logWriteInterval, 200);
        this.logFileExpires = _.defaultTo(logFileExpires, 2626560000);
        this.tmpFileExpires = _.defaultTo(tmpFileExpires, 86400000);
        this.requestBody = Object.assign(requestBody || {}, {
            enableTypes: ['form', 'text', 'xml'],  // 移除 json，由自定义中间件处理
            encoding: 'utf-8',
            formLimit: '100mb',
            jsonLimit: '100mb',
            textLimit: '100mb',
            xmlLimit: '100mb',
            formidable: {
                maxFileSize: '100mb'
            },
            multipart: true,
            parsedMethods: ['POST', 'PUT', 'PATCH']
        });
        this.debug = _.defaultTo(debug, true);
        this.log_level = _.defaultTo(log_level, 'info');
        this.storageType = _.defaultTo(storageType, process.env.STORAGE_TYPE || '');
        this.nasMountPath = _.defaultTo(nasMountPath, process.env.NAS_MOUNT_PATH || '');
        this.nasFileUrlPrefix = _.defaultTo(nasFileUrlPrefix, process.env.NAS_FILE_URL_PREFIX || '');
        this.arkApiKey = _.defaultTo(arkApiKey, process.env.ARK_API_KEY || '');
        this.arkAgentPlanApiKey = _.defaultTo(arkAgentPlanApiKey, process.env.ARK_AGENT_PLAN_API_KEY || '');
        this.arkModel = _.defaultTo(arkModel, process.env.ARK_MODEL || 'doubao-seedance-2-0-260128');
        this.arkFastModel = _.defaultTo(arkFastModel, process.env.ARK_FAST_MODEL || 'doubao-seedance-2-0-fast-260128');
        this.tosAccessKeyId = _.defaultTo(tosAccessKeyId, process.env.TOS_ACCESS_KEY_ID || '');
        this.tosAccessKeySecret = _.defaultTo(tosAccessKeySecret, process.env.TOS_ACCESS_KEY_SECRET || '');
        this.tosRegion = _.defaultTo(tosRegion, process.env.TOS_REGION || '');
        this.tosEndpoint = _.defaultTo(tosEndpoint, process.env.TOS_ENDPOINT || '');
        this.tosBucket = _.defaultTo(tosBucket, process.env.TOS_BUCKET || '');
    }

    get rootDirPath() {
        return path.resolve();
    }

    get tmpDirPath() {
        return path.resolve(this.tmpDir);
    }

    get logDirPath() {
        return path.resolve(this.logDir);
    }

    static load() {
        if (!fs.pathExistsSync(CONFIG_PATH)) return new SystemConfig();
        const data = yaml.parse(fs.readFileSync(CONFIG_PATH).toString());
        return new SystemConfig(data);
    }

}

export default SystemConfig.load();