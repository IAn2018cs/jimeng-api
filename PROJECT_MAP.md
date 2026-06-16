# PROJECT_MAP.md — 工程地图

## 一、核心业务链路

### 1.1 请求总链路

```
Client → Koa中间件栈 → 路由匹配 → Controller → 即梦/火山API → SmartPoller轮询 → 返回结果
```

**中间件执行顺序** (`src/lib/server.ts`):
1. CORS → 2. Range → 3. 异常拦截 → 4. JSON解析(自定义,修复格式) → 5. koa-body(multipart) → 6. 路由

### 1.2 文生图链路 (`POST /v1/images/generations`)

```
Controller: src/api/controllers/images.ts

Token解析 → 区域检测 → 模型映射 → 积分检查
    → buildCoreParam + buildGenerateRequest
    → POST /mweb/v1/aigc_draft/generate → historyId
    → SmartPoller轮询 /mweb/v1/get_history_by_ids (10s间隔, 900次上限)
    → extractImageUrls(item_list) → 4张图URL
    → [可选] fetchFileBASE64 → 返回
```

关键参数：model, prompt, negative_prompt, ratio, resolution, sample_strength, response_format

### 1.3 图生图链路 (`POST /v1/images/compositions`)

```
在文生图基础上增加：
  → 文件上传处理 (multipart/JSON URL)
  → uploadImageBuffer() / uploadImageFromUrl()
  → checkImageContent() (仅国内站)
  → buildBlendAbilityList() + buildPromptPlaceholderList()
  → mode: "img2img"
```

### 1.4 视频生成链路 (`POST /v1/videos/generations`)

```
Controller: src/api/controllers/videos.ts

共同前置：Token → 区域 → 模型映射 → 时长处理 → 积分检查

文件处理 (两种模式):
  A. first_last_frames: 最多2文件(首帧+末帧)
  B. omni_reference: 最多12文件(9图+3视频), parseOmniPrompt()解析@引用

提交: POST /mweb/v1/complete_request_draft → historyId

同步模式 (async=false):
  → SmartPoller轮询 (5s间隔) → videoUrl → 返回

异步模式 (async=true):
  → taskStore.createTask() → taskQueue.enqueue()
  → 立即返回 { task_id, status: 'pending' }
  → 后台: submitVideoTaskAsync()
      → 轮询 → fileStorage.downloadAndSave() → taskStore.completeTask()
```

### 1.5 火山引擎备用渠道

```
触发: Seedance 2.0模型 + 配置了 ARK_API_KEY 或 ARK_AGENT_PLAN_API_KEY
文件: src/lib/volcengine-video.ts

优先: Agent Plan 渠道 (ARK_AGENT_PLAN_API_KEY)
  POST https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks
回退: 标准渠道 (ARK_API_KEY)
  POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks

创建任务失败时自动回退（内容敏感错误不回退，直接抛出）
  → 30s间隔轮询 GET .../tasks/{id}
  → status: processing→succeed/failed
  → 提取mp4 URL返回
```

---

## 二、关键模块详解

### 2.1 Token与认证系统

```
格式: "[proxy_url@]token"
区域前缀: us- (美国) | hk-/jp-/sg- (国际) | 无前缀 (国内)
多Token: "Bearer token1,token2,token3" → 随机选取

相关函数 (src/lib/region-utils.ts + src/api/consts/dreamina.ts):
  tokenSplit()           — 分割多token
  parseProxyFromToken()  — 分离代理URL
  parseRegionFromToken() — 检测区域
  getAssistantId()       — 获取对应区域的aid
```

### 2.2 反爬伪装

```
文件: src/api/consts/dreamina.ts + src/lib/browser-service.ts

HTTP伪装:
  FAKE_HEADERS — Chrome 142 全套header
  DEVICE_ID / WEB_ID / USER_ID — 随机设备标识
  Sign = MD5签名 (uri后7位 + 平台 + 版本 + 时间)

Cookie: _tea_web_id, sid_tt, sessionid, sid_guard 等

Playwright (src/lib/browser-service.ts):
  → 懒启动Chromium → 每token独立context → 10分钟空闲清理
  → 屏蔽 image/font/stylesheet/media 资源
  → 等待 window.bdms SDK就绪 → 执行签名
```

### 2.3 智能轮询器 SmartPoller

```
文件: src/lib/smart-poller.ts

配置: maxPollCount=900, pollInterval=5000/10000ms, timeoutSeconds=900/1800s

状态码与间隔倍率:
  20 (PROCESSING)      → ×1
  42 (POST_PROCESSING) → ×1.2
  45 (FINALIZING)      → ×1.5
  50 (COMPLETED)       → ×0.5
  10/30 (成功/失败)    → 立即返回

退出条件: 成功/失败 | 结果完整 | 稳定5轮 | 超次数 | 超时
网络错误: 可重试则继续轮询
```

### 2.4 任务系统 (异步视频)

```
TaskQueue (src/lib/task-queue.ts):
  并发上限5, FIFO, Promise自动调度

TaskStore (src/lib/task-store.ts):
  SQLite (WAL模式), 预编译SQL
  表: video_tasks (task_id PK, status, history_id, video_url, channel, channel_task_id, refresh_token, ...)
  进度缓存: 内存Map (避免高频写入)
  定时清理: 每小时删除 >3天 过期任务
  终态幂等: completeTask/failTask 不会覆盖已完成/已失败状态

重启恢复 (src/lib/task-recovery.ts):
  时机: 所有存储初始化完成后、HTTP 服务启动前
  processing + channel_task_id 非空 → 恢复轮询 (jimeng 用 pollVideoResult, volcengine 用 pollUntilDone)
  pending + refresh_token 非空 + 无 multipart 文件 → 重新提交执行
  processing + channel_task_id 为空 / pending 无 token / pending 含临时文件 → 标记失败
  渠道字段在 updateTaskSubmitted 时原子写入，消除中间状态窗口
```

### 2.5 文件上传

```
图片 (src/lib/image-uploader.ts):
  getUploadToken(scene=2) → AWS签名(v4) → ApplyImageUpload → POST上传 → image_uri

视频 (src/lib/video-uploader.ts):
  getUploadToken(scene=1) → AWS签名(v4) → ApplyUploadInner → POST上传 → get_upload_video_meta → vid+meta

文件存储 (src/lib/file-storage.ts):
  条件: STORAGE_TYPE=local_mount + NAS_MOUNT_PATH + NAS_FILE_URL_PREFIX
  路径: {NAS_MOUNT_PATH}/YYYY/MM/DD/{uuid}.mp4
  URL: {NAS_FILE_URL_PREFIX}/YYYY/MM/DD/{uuid}.mp4
```

### 2.6 错误处理与重试

```
文件: src/lib/error-handler.ts + src/lib/exceptions/

APIException: code + message + statusCode
HTTP重试: 3次, 5秒间隔, 可重试错误类型: ECONNRESET/ETIMEDOUT/ENOTFOUND等

即梦API错误码映射:
  1015 → TOKEN_EXPIRES | 5000 → INSUFFICIENT_POINTS
  4001 → CONTENT_FILTERED | 5001 → GENERATION_FAILED
```

---

## 三、模型映射关系

```
文件: src/api/consts/common.ts

图像模型 (CN站):
  jimeng-4.5         → high_aes_general_v40l
  jimeng-4.5-pro     → high_aes_general_v40l_pro
  jimeng-3.0         → high_aes_general_v30l
  nanobanana         → nanobanana (外部, 强制1024x1024)
  nanobananapro      → nanobananapro (外部)

视频模型:
  jimeng-video-3.5-pro → 默认视频模型
  jimeng-video-4.0-pro → 40_pro系列 (4-15秒)
  seedance-2.0       → doubao-seedance-2-0 (火山引擎)
  seedance-2.0-fast  → doubao-seedance-2-0-fast
  veo3               → veo3 (固定8秒)
  sora2              → sora2 (4/8/12秒)
```

---

## 四、配置约定

### 优先级

环境变量 > YAML (`configs/{env}/service.yml`, `system.yml`) > 代码默认值

### 关键环境变量

| 变量 | 用途 | 默认 |
|------|------|------|
| SERVER_PORT | 监听端口 | 5100 |
| STORAGE_TYPE | 存储类型 | none |
| NAS_MOUNT_PATH | NAS挂载路径 | - |
| NAS_FILE_URL_PREFIX | NAS文件URL前缀 | - |
| ARK_AGENT_PLAN_API_KEY | 火山引擎Agent Plan Key（优先） | - |
| ARK_API_KEY | 火山引擎Key（回退） | - |
| ARK_MODEL | Seedance Pro模型 | doubao-seedance-2-0-260128 |
| ARK_FAST_MODEL | Seedance Fast模型 | doubao-seedance-2-0-fast-260128 |
| ARK_CREATE_TASK_TIMEOUT_MS | 火山引擎创建视频任务请求超时 | 1200000 |
| PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH | Chromium路径 | - |

### 配置加载链路

```
src/lib/environment.ts  — 解析命令行+env → environment对象
src/lib/configs/service-config.ts — 读 service.yml + environment覆盖
src/lib/configs/system-config.ts  — 读 system.yml + env覆盖 (ARK_*, NAS_*, STORAGE_*)
src/lib/config.ts — 统一导出 { service, system }
```

---

## 五、常改入口速查

| 需求 | 改哪里 |
|------|--------|
| 新增图像模型 | `src/api/consts/common.ts` (模型映射表) |
| 新增视频模型 | `src/api/consts/common.ts` + `src/api/controllers/videos.ts` (时长/特性判断) |
| 调整轮询策略 | `src/lib/smart-poller.ts` |
| 修改请求构建 | `src/api/builders/payload-builder.ts` |
| 新增API端点 | `src/api/routes/` 下新建 + `src/api/routes/index.ts` 注册 |
| 火山引擎渠道逻辑 | `src/lib/volcengine-video.ts` |
| Token/区域/反爬 | `src/api/consts/dreamina.ts` + `src/lib/region-utils.ts` |
| 文件上传逻辑 | `src/lib/image-uploader.ts` / `src/lib/video-uploader.ts` |
| 异步任务存储 | `src/lib/task-store.ts` |
| 配置新增字段 | `src/lib/configs/system-config.ts` + `configs/{env}/system.yml` |
| Docker/部署 | `Dockerfile` + `docker-compose.yml` |
| 错误码新增 | `src/api/consts/exceptions.ts` |

---

## 六、数据流图

### 异步视频全链路

```
┌─────────┐     POST /v1/videos/generations (async=true)
│  Client │─────────────────────────────────────────────────┐
└─────────┘                                                 │
                                                            ▼
┌──────────────────────────────────────────────────────────────┐
│ Controller                                                    │
│  1. 参数验证 + Token选取                                      │
│  2. taskStore.createTask() → SQLite INSERT                   │
│  3. taskQueue.enqueue(taskId)                                │
│  4. 返回 { task_id, status: 'pending' }                      │
└──────────────────────────────────────────────────────────────┘
                        │
                        ▼ (后台 max 5并发)
┌──────────────────────────────────────────────────────────────┐
│ submitVideoTaskAsync                                          │
│  1. 文件上传 (image/video → 即梦CDN)                          │
│  2. POST /mweb/v1/complete_request_draft → historyId         │
│  3. taskStore.updateTaskSubmitted()                           │
│  4. SmartPoller 轮询 (5s, 900次上限)                          │
│  5. 成功 → fileStorage.downloadAndSave() → NAS              │
│  6. taskStore.completeTask(finalUrl)                          │
└──────────────────────────────────────────────────────────────┘
                        │
┌─────────┐     GET /v1/videos/generations/:task_id
│  Client │─────────────────────────────────────────────────┐
└─────────┘                                                 │
                        ▼
         taskStore.getTask() → { status, data/error, progress }
```

---

## 七、开发备忘

- **import 路径必须带 `.ts` 后缀** (ESM + NodeNext)
- **type-check 有已知第三方类型错误**, 忽略 logger.ts / koa-body / image-uploader 相关
- **Seedance 模型走 Playwright** 绕过 a_bogus 签名, 非 Seedance 走普通 HTTP
- **端口**: dev=5100, Docker映射=12015
- **日志**: `src/lib/logger.ts`, 输出到 console + `./logs/`
- **临时文件**: `./tmp/` (multipart上传暂存)
