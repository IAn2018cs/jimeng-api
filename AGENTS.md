# AGENTS.md

## 项目概述

jimeng-api — 即梦 AI 逆向工程 API 服务，OpenAI 兼容接口。支持文生图、图生图、视频生成（同步/异步），备用火山引擎 Seedance 渠道。

## 工程地图

详细架构、流程、数据流见 → [PROJECT_MAP.md](PROJECT_MAP.md)

| 章节 | 内容 |
|------|------|
| 一、核心业务链路 | 文生图/图生图/视频生成完整请求链路 |
| 二、关键模块详解 | Token系统、反爬、轮询器、任务系统、文件上传、错误处理 |
| 三、模型映射关系 | 模型名 → 内部标识对照表 |
| 四、配置约定 | 环境变量、YAML、优先级 |
| 五、常改入口速查 | 需求 → 该改哪个文件 |
| 六、数据流图 | 异步视频全链路图示 |

## 技术栈

Node.js 18 / TypeScript (ESM) / Koa / better-sqlite3 / playwright-core / tsup

## 常用命令

```bash
npm run dev          # 开发（watch + 热重启）
npm run build        # 构建
npm run start        # 运行生产版本
npm run type-check   # 类型检查（忽略已知第三方类型错误）
```

## 快速定位 (grep/路径)

```bash
# 模型映射表
grep -n "MODEL" src/api/consts/common.ts

# 异常码定义
grep -n "API_" src/api/consts/exceptions.ts

# 区域检测逻辑
grep -n "parseRegion" src/lib/region-utils.ts

# 火山引擎备用渠道
src/lib/volcengine-video.ts

# 轮询配置
grep -n "maxPollCount\|pollInterval\|timeoutSeconds" src/lib/smart-poller.ts

# 任务队列并发数
grep -n "maxConcurrency" src/lib/task-queue.ts

# 请求重试配置
grep -n "MAX_RETRY\|RETRY_DELAY" src/api/consts/common.ts

# 配置加载入口
src/lib/config.ts → src/lib/configs/system-config.ts
```

## 关键约定

- **import 路径必须带 `.ts` 后缀**（ESM + NodeNext 模块解析）
- **端口**: dev=5100, Docker 映射=12015
- **配置优先级**: 环境变量 > YAML (`configs/{env}/`) > 代码默认值
- **Seedance 模型走 Playwright** 绕过 a_bogus 签名
- **异步视频**: 最多 5 并发, SQLite 持久化, 任务 3 天过期自动清理
- **文件存储**: 生成完成后下载到 NAS 防止源链接失效 (需配置 STORAGE_TYPE=local_mount)

## API 端点

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | /v1/images/generations | 文生图 |
| POST | /v1/images/compositions | 图生图 |
| POST | /v1/videos/generations | 视频生成 (async参数控制同步/异步) |
| GET | /v1/videos/generations/:task_id | 查询异步任务状态 |
| GET | /v1/models | 模型列表 |
| POST | /token/check | Token存活检查 |
| GET | /ping | 健康检查 |

## 活文档约定

每次改功能时同步更新 PROJECT_MAP.md 中对应段落。AGENTS.md 只维护索引和约定，不放流程细节。
