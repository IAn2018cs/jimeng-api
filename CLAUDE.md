# CLAUDE.md

## 项目概述

jimeng-api 是一个基于即梦 AI 逆向工程实现的图像和视频生成 API 服务，提供与 OpenAI API 兼容的接口格式。

## 技术栈

- **运行时**: Node.js 18+, TypeScript (ESM)
- **构建**: tsup (输出 CJS + ESM)
- **Web 框架**: Koa + koa-router
- **数据库**: better-sqlite3 (任务存储)
- **浏览器自动化**: playwright-core (绕过反爬)
- **路径别名**: `@/*` → `src/*`

## 常用命令

```bash
npm run dev       # 开发模式（watch + 自动重启）
npm run build     # 构建生产版本
npm run start     # 运行构建产物
npm run type-check  # TypeScript 类型检查（有已知的第三方类型错误，忽略 logger.ts / koa-body / image-uploader 等报错）
```

## 项目结构

```
src/
├── index.ts                    # 入口：初始化存储、挂载路由、启动服务器
├── api/
│   ├── routes/                 # API 路由（images, videos, models, token, ping）
│   ├── controllers/            # 业务逻辑（视频生成、图像生成、通用请求）
│   ├── consts/                 # 常量（模型映射、异常码、Dreamina 配置）
│   └── builders/               # Payload 构建器
└── lib/
    ├── config.ts               # 配置入口（导出 service + system）
    ├── configs/                # 配置加载（service-config.ts, system-config.ts）
    ├── environment.ts          # 环境变量 + 命令行参数
    ├── volcengine-video.ts     # 火山引擎 Seedance API（备用视频生成渠道）
    ├── file-storage.ts         # 文件存储（NAS 挂载）
    ├── task-store.ts           # 异步任务 SQLite 存储
    ├── task-queue.ts           # 并发队列（max 5）
    ├── smart-poller.ts         # 智能轮询器
    ├── error-handler.ts        # 错误处理 + 重试
    ├── browser-service.ts      # Playwright 浏览器代理
    ├── image-uploader.ts       # 图片上传到即梦
    ├── video-uploader.ts       # 视频上传到 VOD
    └── server.ts               # Koa 服务器
```

## API 端点

- `POST /v1/images/generations` — 图像生成
- `POST /v1/images/compositions` — 图像合成
- `POST /v1/videos/generations` — 视频生成（同步/异步）
- `GET /v1/videos/generations/:task_id` — 查询异步任务
- `GET /v1/models` — 模型列表
- `GET /ping` — 健康检查

## 配置管理

- 优先级：环境变量 > YAML 配置文件 (`configs/{env}/`) > 代码默认值
- `.env` 文件通过 docker-compose `env_file` 传入容器
- 关键环境变量见 `.env.example`

## 视频生成架构

1. 优先通过即梦 API 生成（需要 refresh_token 认证）
2. Seedance 2.0 系列模型有火山引擎备用渠道（需配置 `ARK_API_KEY`）
3. 生成完成后自动下载保存到 NAS 防止链接失效
4. 异步模式：任务入队 → 后台轮询 → SQLite 记录状态

## 开发注意事项

- Seedance 模型通过 browserService（Playwright）发送请求，绕过 a_bogus 反爬签名
- import 路径必须带 `.ts` 后缀（ESM + NodeNext 模块解析）
- 端口默认 5100（dev），Docker 映射为 12015
