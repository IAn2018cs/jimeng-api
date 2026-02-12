# 异步视频生成 API 文档

本文档面向 AI Agent 调用方，说明如何使用异步模式生成视频并查询任务进度。重点介绍 `jimeng-video-seedance-2.0` 和 `jimeng-video-seedance-2.0-fast` 模型。

## 概述

异步模式下，提交视频生成请求后 **立即返回 `task_id`**，无需长时间保持 HTTP 连接。调用方可随时通过 `task_id` 查询任务进度和结果。任务记录保留 3 天，过期自动删除。

**流程：**

```
1. POST /v1/videos/generations  (async: true)  →  获得 task_id
2. GET  /v1/videos/generations/:task_id         →  轮询进度
3. 当 status 为 "completed" 时，从 data[0].url 获取视频地址
```

---

## 1. 提交异步任务

**POST** `/v1/videos/generations`

### 请求头

| Header          | 必填 | 说明                                              |
|-----------------|------|---------------------------------------------------|
| `Authorization` | 是   | `Bearer YOUR_SESSION_ID`，支持多 token 逗号分隔随机选用 |
| `Content-Type`  | 是   | `application/json` 或 `multipart/form-data`        |

### 请求参数

| 参数              | 类型     | 必填 | 默认值                   | 说明                                              |
|-------------------|----------|------|--------------------------|---------------------------------------------------|
| `model`           | string   | 否   | `jimeng-video-3.5-pro`   | 视频模型名称，推荐 `jimeng-video-seedance-2.0` 或 `jimeng-video-seedance-2.0-fast`（更快） |
| `prompt`          | string   | 是   | -                        | 视频内容的文本描述                                 |
| `async`           | boolean  | 否   | `false`                  | **设为 `true` 启用异步模式**                       |
| `ratio`           | string   | 否   | `"1:1"`                  | 视频比例（图生视频时被输入图片比例覆盖）            |
| `duration`        | number   | 否   | `5`                      | 视频时长（秒），seedance-2.0/2.0-fast 支持 4~15 任意整数秒 |
| `file_paths`      | string[] | 否   | `[]`                     | 图片/视频 URL 数组，首尾帧模式最多2个，全能模式最多12个(9图片+3视频) |
| `filePaths`       | string[] | 否   | `[]`                     | 同 `file_paths`，兼容驼峰命名                      |
| `functionMode`    | string   | 否   | `"first_last_frames"`    | 生成模式：`first_last_frames`=首尾帧，`omni_reference`=全能参考模式（仅 seedance-2.0/2.0-fast） |

### `ratio` 可选值

| 值      | 说明   |
|---------|--------|
| `1:1`   | 正方形 |
| `4:3`   | 横屏   |
| `3:4`   | 竖屏   |
| `16:9`  | 宽屏   |
| `9:16`  | 竖屏   |
| `21:9`  | 超宽屏 |

### `duration` 取值范围（seedance-2.0/2.0-fast）

支持 **4~15 任意整数秒**，默认 `5` 秒。

---

## 生成模式说明

### 首尾帧模式（`functionMode: "first_last_frames"`，默认）

| 图片数量 | 模式             | 说明                                    |
|----------|------------------|-----------------------------------------|
| 0 张     | 文生视频         | 纯文本描述生成视频                       |
| 1 张     | 图生视频         | 图片作为首帧                             |
| 2 张     | 首尾帧视频       | 第1张=首帧，第2张=尾帧                   |

支持通过 `file_paths`（URL 数组）或 `multipart/form-data` 上传本地文件。

### 全能参考模式（`functionMode: "omni_reference"`，仅 seedance-2.0/2.0-fast）

omni_reference 模式支持**图片和视频混合参考**，通过以下方式提供素材文件：

**方式一：`file_paths` URL 数组（JSON 或 multipart）**

```json
{
  "file_paths": ["https://example.com/character.jpg", "https://example.com/dance.mp4"]
}
```

**方式二：`multipart/form-data` 文件上传（任意字段名，如 `file_paths`、`file` 等）**

系统会自动根据文件扩展名或 MIME 类型判断是图片还是视频。

**方式三（兼容）：`multipart/form-data` 具名字段上传**

| 字段名          | 类型 | 说明                    |
|-----------------|------|-------------------------|
| `image_file_1`  | 文件 | 第1张参考图片（可选）    |
| `image_file_2`  | 文件 | 第2张参考图片（可选）    |
| `video_file`    | 文件 | 参考视频（可选，≤15秒）  |

使用具名字段时，类型由字段名决定，prompt 中用 `@image_file_1`/`@video_file` 引用。

**支持的视频格式：** `.mp4`, `.mov`, `.avi`, `.mkv`, `.webm`, `.flv`, `.wmv`, `.m4v`
**其他格式默认识别为图片。**

**限制：**
- 至少提供 1 个文件，最多 12 个文件（9图片 + 3视频）
- 视频时长不超过 15 秒

**prompt 中引用素材：**

使用 `@file_N`（按顺序编号）或 `@原始文件名` 引用已上传的素材：

```
@file_1作为首帧，@file_2作为尾帧，运动动作模仿@file_3
```

也可以用原始文件名引用：
```
@character.jpg作为角色，运动风格模仿@dance.mp4
```

如果 prompt 中没有 `@` 引用，整个 prompt 作为纯文本描述。

---

### 请求示例

```bash
# 文生视频（异步模式，seedance-2.0，12秒，16:9）
curl -X POST http://localhost:5100/v1/videos/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -d '{
    "model": "jimeng-video-seedance-2.0",
    "prompt": "一只猫在草地上奔跑，电影质感，慢动作",
    "ratio": "16:9",
    "duration": 12,
    "async": true
  }'

# 图生视频（异步模式，使用图片URL作为首帧）
curl -X POST http://localhost:5100/v1/videos/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -d '{
    "model": "jimeng-video-seedance-2.0",
    "prompt": "人物缓缓转头微笑",
    "duration": 8,
    "file_paths": ["https://example.com/portrait.jpg"],
    "async": true
  }'

# 本地图片上传（multipart/form-data，异步模式）
curl -X POST http://localhost:5100/v1/videos/generations \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -F "model=jimeng-video-seedance-2.0" \
  -F "prompt=花朵绽放的过程" \
  -F "duration=10" \
  -F "async=true" \
  -F "image=@/path/to/flower.jpg"

# 全能参考模式（omni_reference）— 使用 file_paths URL
curl -X POST http://localhost:5100/v1/videos/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -d '{
    "model": "jimeng-video-seedance-2.0",
    "prompt": "@file_1作为角色，运动风格模仿@file_2",
    "functionMode": "omni_reference",
    "duration": 8,
    "async": true,
    "file_paths": ["https://example.com/character.jpg", "https://example.com/dance.mp4"]
  }'

# 全能参考模式 — multipart 文件上传（使用 file_paths 字段名）
curl -X POST http://localhost:5100/v1/videos/generations \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -F "model=jimeng-video-seedance-2.0" \
  -F "prompt=@file_1作为角色，运动风格模仿@file_2" \
  -F "functionMode=omni_reference" \
  -F "duration=8" \
  -F "async=true" \
  -F "file_paths=@/path/to/character.jpg" \
  -F "file_paths=@/path/to/dance.mp4"

# 全能参考模式 — 双图片参考
curl -X POST http://localhost:5100/v1/videos/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -d '{
    "model": "jimeng-video-seedance-2.0",
    "prompt": "@file_1的角色走进@file_2的场景",
    "functionMode": "omni_reference",
    "duration": 10,
    "async": true,
    "file_paths": ["https://example.com/character.jpg", "https://example.com/scene.jpg"]
  }'
```

### 响应示例

```json
{
  "task_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "pending",
  "message": "视频生成任务已提交，请使用 task_id 查询进度",
  "created": 1739260800
}
```

---

## 2. 查询任务进度

**GET** `/v1/videos/generations/:task_id`

### 请求头

| Header          | 必填 | 说明                          |
|-----------------|------|-------------------------------|
| `Authorization` | 是   | `Bearer YOUR_SESSION_ID`      |

### 请求示例

```bash
curl -X GET http://localhost:5100/v1/videos/generations/a1b2c3d4-e5f6-7890-abcd-ef1234567890 \
  -H "Authorization: Bearer YOUR_SESSION_ID"
```

### 任务状态流转

```
pending  →  processing  →  completed
                        →  failed
```

| 状态         | 说明                                   |
|--------------|----------------------------------------|
| `pending`    | 任务已创建，等待提交到上游              |
| `processing` | 已提交到上游，正在生成中                |
| `completed`  | 生成完成，`data` 字段包含视频 URL       |
| `failed`     | 生成失败，`error` 字段包含错误信息      |

### 响应字段说明

| 字段                        | 类型   | 说明                                     |
|-----------------------------|--------|------------------------------------------|
| `task_id`                   | string | 任务唯一标识                              |
| `status`                    | string | 任务状态：pending / processing / completed / failed |
| `progress.upstream_status`  | number | 上游状态码（20=处理中, 42=后处理, 10=完成）|
| `progress.progress_text`    | string | 进度描述文本                              |
| `progress.poll_count`       | number | 已轮询次数                                |
| `progress.elapsed_seconds`  | number | 已耗时（秒）                              |
| `data`                      | array  | 仅 completed 时存在，包含视频结果         |
| `data[0].url`               | string | 视频下载地址                              |
| `data[0].revised_prompt`    | string | 原始提示词                                |
| `error`                     | object | 仅 failed 时存在                          |
| `error.message`             | string | 错误信息                                  |
| `created_at`                | number | 任务创建时间（Unix 秒）                   |
| `updated_at`                | number | 最后更新时间（Unix 秒）                   |
| `expires_at`                | number | 过期时间（Unix 秒，创建后 3 天）          |

### 响应示例

**处理中（processing）：**

```json
{
  "task_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "processing",
  "progress": {
    "upstream_status": 20,
    "progress_text": "PROCESSING",
    "poll_count": 45,
    "elapsed_seconds": 90
  },
  "created_at": 1739260800,
  "updated_at": 1739260890,
  "expires_at": 1739520000
}
```

**已完成（completed）：**

```json
{
  "task_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "completed",
  "progress": {
    "upstream_status": 10,
    "progress_text": "SUCCESS",
    "poll_count": 120,
    "elapsed_seconds": 240
  },
  "data": [
    {
      "url": "https://v3-artist.vlabvod.com/xxx/video.mp4",
      "revised_prompt": "一只猫在草地上奔跑，电影质感，慢动作"
    }
  ],
  "created_at": 1739260800,
  "updated_at": 1739261040,
  "expires_at": 1739520000
}
```

**失败（failed）：**

```json
{
  "task_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "failed",
  "progress": {
    "upstream_status": 50,
    "progress_text": "FAILED",
    "poll_count": 30,
    "elapsed_seconds": 60
  },
  "error": {
    "message": "积分不足且无法自动收取"
  },
  "created_at": 1739260800,
  "updated_at": 1739260860,
  "expires_at": 1739520000
}
```

---

## 3. Agent 调用建议

### 推荐轮询策略

```
提交任务后等待 10 秒再开始首次查询
前 2 分钟：每 5 秒查询一次
2~5 分钟：每 10 秒查询一次
5 分钟以上：每 15 秒查询一次
最长等待 20 分钟，超时则认为失败
```

### 伪代码示例

```python
import requests, time

API_BASE = "http://localhost:5100"
HEADERS = {
    "Authorization": "Bearer YOUR_SESSION_ID",
    "Content-Type": "application/json"
}

# 1. 提交异步任务
resp = requests.post(f"{API_BASE}/v1/videos/generations", headers=HEADERS, json={
    "model": "jimeng-video-seedance-2.0",
    "prompt": "一只猫在草地上奔跑，电影质感",
    "ratio": "16:9",
    "duration": 10,
    "async": True
})
task_id = resp.json()["task_id"]

# 2. 轮询查询进度
time.sleep(10)  # 首次等待 10 秒
for i in range(240):  # 最多 20 分钟
    resp = requests.get(
        f"{API_BASE}/v1/videos/generations/{task_id}",
        headers=HEADERS
    )
    result = resp.json()
    status = result["status"]

    if status == "completed":
        video_url = result["data"][0]["url"]
        print(f"视频生成完成: {video_url}")
        break
    elif status == "failed":
        print(f"视频生成失败: {result['error']['message']}")
        break
    else:
        elapsed = result.get("progress", {}).get("elapsed_seconds", 0)
        print(f"生成中... 已耗时 {elapsed}s")
        # 自适应轮询间隔
        if elapsed < 120:
            time.sleep(5)
        elif elapsed < 300:
            time.sleep(10)
        else:
            time.sleep(15)
```

### 错误处理

| HTTP 状态码 | 错误码  | 说明                     |
|-------------|---------|--------------------------|
| 400         | -2001   | 请求参数不合法            |
| 404         | -2010   | 任务不存在或已过期（3天） |
| 500         | -2008   | 视频生成失败              |

### 注意事项

1. `jimeng-video-seedance-2.0` 和 `jimeng-video-seedance-2.0-fast` **仅国内站支持**，token 不要加 `us-`/`hk-` 等前缀
2. 任务记录 **3 天后自动过期删除**，请及时获取结果
3. 图生视频时 `ratio` 参数会被输入图片的实际比例覆盖
4. 同一个 `task_id` 可以无限次查询，直到过期
5. 全能参考模式（`functionMode: "omni_reference"`）仅 `jimeng-video-seedance-2.0` 和 `jimeng-video-seedance-2.0-fast` 支持，支持 `file_paths` URL 数组、multipart 文件上传、以及旧版具名字段（`image_file_1`/`image_file_2`/`video_file`），最多 9 张图片 + 3 段视频
6. 全能参考模式下，通用上传用 `@file_1`/`@file_2` 引用素材，具名字段用 `@image_file_1`/`@video_file` 引用，也支持 `@原始文件名`
7. 系统根据文件扩展名（.mp4/.mov 等为视频）或 MIME 类型自动判断图片/视频
8. 图片上传后会进行内容安全检测（仅国内站），违规内容会被拒绝
