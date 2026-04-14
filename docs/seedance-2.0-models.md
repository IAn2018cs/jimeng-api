# Seedance 2.0 视频生成 — 模型与接口变更说明

> 变更日期：2026-04-14

## 一、接口地址（无变化）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/videos/generations` | 视频生成（同步/异步） |
| GET | `/v1/videos/generations/:task_id` | 异步任务查询 |

## 二、新增模型

| model 值 | 类型 | 说明 | 需要 VIP 账号 |
|----------|------|------|:---:|
| `seedance-2.0` | 别名 | 等同 `jimeng-video-seedance-2.0` | 否 |
| `seedance-2.0-pro` | 别名 | 等同 `jimeng-video-seedance-2.0` | 否 |
| `seedance-2.0-fast` | 别名 | 等同 `jimeng-video-seedance-2.0-fast` | 否 |
| `jimeng-video-seedance-2.0-fast-vip` | **新增** | 极速推理 VIP 通道 | **是** |
| `seedance-2.0-fast-vip` | **新增** | 同上（短别名） | **是** |
| `jimeng-video-seedance-2.0-vip` | **新增** | 主模态 VIP 通道 | **是** |
| `seedance-2.0-vip` | **新增** | 同上（短别名） | **是** |

## 三、完整模型列表（Seedance 系列）

| model | 速度 | VIP |
|-------|------|-----|
| `jimeng-video-seedance-2.0` / `seedance-2.0` / `seedance-2.0-pro` | 标准 | 否 |
| `jimeng-video-seedance-2.0-fast` / `seedance-2.0-fast` | 快速 | 否 |
| `jimeng-video-seedance-2.0-fast-vip` / `seedance-2.0-fast-vip` | 快速 | 是 |
| `jimeng-video-seedance-2.0-vip` / `seedance-2.0-vip` | 标准 | 是 |

## 四、请求参数（无变化）

所有 Seedance 模型共用相同的请求参数，VIP 模型无额外参数：

```jsonc
{
  "model": "seedance-2.0-fast-vip",  // 唯一区别：model 字段值
  "prompt": "描述文本",
  "ratio": "4:3",          // 可选，默认 1:1
  "duration": 5,           // 可选，4-15 秒整数，默认 5
  "file_paths": [],        // 可选，素材 URL 数组
  "functionMode": "omni_reference",  // 可选，omni_reference 或 first_last_frames
  "response_format": "url",          // 可选，url 或 b64_json
  "async": false           // 可选，true 为异步模式
}
```

## 五、响应格式（无变化）

同步模式：

```json
{
  "created": 1713100000,
  "data": [{ "url": "https://...", "revised_prompt": "..." }]
}
```

异步模式提交：

```json
{
  "task_id": "uuid",
  "status": "pending",
  "message": "视频生成任务已提交，请使用 task_id 查询进度",
  "created": 1713100000
}
```

## 六、注意事项

1. **VIP 模型需要 VIP 账号**：非 VIP 账号使用 VIP 模型会直接返回错误，不会自动降级到普通模型。
2. **Token 和 Header 无变化**：VIP 与非 VIP 的认证方式完全相同，`Authorization: Bearer <sessionid>`。
3. **仅国内版**：VIP 模型当前仅支持国内站 Token。
