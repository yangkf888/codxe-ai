# AI 视频生成 Web 工具

该仓库提供一个可部署的 AI 视频生成 Web 工具，包含前端（Vite + React）、后端（Node.js + Express）以及部署示例（Nginx + systemd）。

## 目录结构

```
./
├── deploy/          # 部署配置示例
├── server/          # 后端 API
└── web/             # 前端页面
```

## 功能概览

- 前端不包含任何 API Key，仅调用同域 `/api`。
- 后端持有 `KIE_API_KEY`，负责调用 Kie AI 视频生成接口。
- `/api/video/create` 创建任务，返回 `task_id`。
- `/api/video/batch_create` 批量创建任务并支持并发限制。
- `/api/video/status` 轮询任务状态。
- `/api/video/list` 获取最近任务列表（用于历史记录）。
- `/api/callback` 接收 Kie AI 回调更新任务状态；回调成功后下载视频到本地并保存 7 天。
- Redis 持久化任务状态与 `kieTaskId -> localTaskId` 映射，服务重启后仍可恢复。

## 后端 API 约定

### Header

```
X-APP-TOKEN: <必须匹配环境变量 APP_TOKEN，否则 401>
```

### POST /api/video/create

```json
{
  "mode": "t2v" | "i2v",
  "prompt": "string",
  "image_url": "string (可选)",
  "image_urls": ["string"],
  "duration": 5 | 10 | 15,
  "aspect_ratio": "16:9" | "9:16" | "1:1" | "landscape" | "portrait" | "square",
  "remove_watermark": true,
  "character_id_list": ["string"]
}
```

返回：

```json
{ "task_id": "string" }
```

说明：

- `task_id` 为本地生成的 `localTaskId`，用于前端轮询。
- Kie 侧返回的 `kieTaskId` 仅用于回调映射，不会返回给前端。
- 回调地址由 `PUBLIC_BASE_URL` 拼接为 `${PUBLIC_BASE_URL}/api/callback`。
- `duration` 默认 5（对应 `n_frames="10"`）。
- `aspect_ratio` 默认 16:9（等价 `landscape`）。
- `i2v` 必须提供 `image_url` 或 `image_urls`。

### POST /api/video/batch_create

请求：

```json
{
  "concurrency": 10,
  "jobs": [
    {
      "mode": "t2v",
      "prompt": "a cinematic shot",
      "duration": 5,
      "aspect_ratio": "16:9"
    },
    {
      "mode": "i2v",
      "prompt": "anime style",
      "image_urls": ["https://example.com/01.png"],
      "duration": 10,
      "aspect_ratio": "portrait",
      "remove_watermark": true
    }
  ]
}
```

返回：

```json
{
  "accepted": 2,
  "concurrency": 10,
  "results": [
    { "index": 0, "ok": true, "task_id": "..." },
    { "index": 1, "ok": false, "error": "..." }
  ]
}
```

说明：

- `concurrency` 默认 10，最大 30；建议 10~20。
- `jobs` 内字段与 `/api/video/create` 相同。
- `results` 按 `jobs` 顺序返回对应结果。

示例：

```bash
curl -X POST https://your-domain.com/api/video/batch_create \
  -H "Content-Type: application/json" \
  -H "X-APP-TOKEN: <your-token>" \
  -d '{
    "concurrency": 12,
    "jobs": [
      {
        "mode": "t2v",
        "prompt": "cinematic clouds",
        "duration": 5,
        "aspect_ratio": "16:9"
      },
      {
        "mode": "i2v",
        "prompt": "anime city",
        "image_url": "https://example.com/source.png"
      }
    ]
  }'
```

### GET /api/video/status?task_id=xxx

返回：

```json
{
  "status": "queued" | "running" | "success" | "fail",
  "progress": 0.0,
  "video_url": "string (可选)",
  "error": "string (可选)"
}
```

### GET /api/video/list?limit=50

返回：

```json
{
  "tasks": [
    {
      "localTaskId": "string",
      "createdAt": "2024-01-01T00:00:00Z",
      "mode": "t2v",
      "prompt": "string",
      "status": "queued" | "running" | "success" | "fail",
      "progress": 0,
      "video_url": "https://your-domain.com/files/task_xxx.mp4",
      "origin_video_url": "https://kie.ai/...",
      "error": null
    }
  ]
}
```

说明：

- `limit` 默认 50，最大 200。
- `video_url` 为本地可访问链接（如果下载完成），否则为 `null`。
- `origin_video_url` 为 Kie 原始链接（回调成功时写入）。

### Kie 回调与重试

Kie 会向 `/api/callback` 发送任务状态变更，其中 `body.data.taskId` 为 `kieTaskId`。
后端通过 `kieTaskId -> localTaskId` 映射更新任务状态。
回调成功后将视频下载到本地目录并保存 7 天，失败也会返回 `200 ok`，避免平台重试风暴。

## Docker 一键部署

> 适用于全新服务器，一次性完成环境变量配置与容器启动。

### 1) 获取代码

```bash
git clone <your-repo> /var/www/ai-video
cd /var/www/ai-video
```

### 2) 运行一键脚本

```bash
./setup.sh
```

脚本会引导填写以下配置并生成 `.env`：

- `PUBLIC_BASE_URL`
- `KIE_API_KEY`
- `APP_TOKEN`

完成后自动执行 `docker-compose up -d --build`。

### 3) 后续启动

如果已有 `.env`，再次执行 `./setup.sh` 会直接启动服务。

## 传统部署步骤（Linux 服务器）

> 假设部署目录为 `/var/www/ai-video`，Node.js 已安装，Nginx 可用。

### 1) 获取代码

```bash
git clone <your-repo> /var/www/ai-video
cd /var/www/ai-video
```

### 2) 启动 Redis（独立容器）

```bash
docker run -d \
  --name ai-video-redis \
  -p 127.0.0.1:6380:6379 \
  --restart unless-stopped \
  redis:7
```

### 3) 配置后端环境变量

```bash
cp server/.env.example server/.env
```

编辑 `server/.env`：

```
KIE_API_KEY=...
APP_TOKEN=...
PORT=8787
PUBLIC_BASE_URL=https://your-domain.com
REDIS_URL=redis://127.0.0.1:6380
TASK_TTL_SECONDS=604800
FILES_DIR=/var/www/ai-video/server/files
PUBLIC_FILES_PATH=/files
KIE_T2V_MODEL=sora-2-text-to-video
KIE_I2V_MODEL=sora-2-image-to-video
```

### 4) 创建本地视频目录

```bash
sudo mkdir -p /var/www/ai-video/server/files
sudo chown -R $USER:$USER /var/www/ai-video/server/files
```

### 5) 安装依赖并启动后端

```bash
cd /var/www/ai-video/server
npm install
npm run start
```

建议使用 systemd（见 `deploy/ai-video.service`）进行守护运行。

### 6) 构建前端并放置到 Nginx 静态目录

```bash
cd /var/www/ai-video/web
npm install
npm run build
```

将 `web/dist` 作为 Nginx 静态目录。

### 7) 配置 Nginx

复制 `deploy/nginx.conf` 并根据域名修改：

```bash
sudo cp /var/www/ai-video/deploy/nginx.conf /etc/nginx/conf.d/ai-video.conf
sudo nginx -t
sudo systemctl reload nginx
```

Nginx 将提供：

- `/` -> `web/dist`
- `/api` -> `http://127.0.0.1:8787`
- `/files` -> 建议走后端静态，也可改为 Nginx 直接指向 `/var/www/ai-video/server/files`

如需 Nginx 直接托管 `/files`，增加：

```
location /files/ {
  alias /var/www/ai-video/server/files/;
  add_header Cache-Control "public, max-age=86400";
}
```

### 8) 使用 systemd 启动后端（可选）

```bash
sudo cp /var/www/ai-video/deploy/ai-video.service /etc/systemd/system/ai-video.service
sudo systemctl daemon-reload
sudo systemctl enable ai-video
sudo systemctl start ai-video
```

## 本地开发

### 后端

```bash
cd server
npm install
npm run dev
```

### 前端

```bash
cd web
npm install
npm run dev
```

前端请求默认走同域 `/api`，本地调试可使用 Nginx 或自行代理。

## 常用 curl 示例

### 创建单个任务

```bash
curl -X POST http://localhost:8787/api/video/create \
  -H "Content-Type: application/json" \
  -H "X-APP-TOKEN: <your-token>" \
  -d '{
    "mode": "t2v",
    "prompt": "a sunset over the ocean",
    "duration": 5,
    "aspect_ratio": "16:9"
  }'
```

### 批量创建任务

```bash
curl -X POST http://localhost:8787/api/video/batch_create \
  -H "Content-Type: application/json" \
  -H "X-APP-TOKEN: <your-token>" \
  -d '{
    "concurrency": 8,
    "jobs": [
      {
        "mode": "t2v",
        "prompt": "cinematic clouds",
        "duration": 5
      },
      {
        "mode": "i2v",
        "prompt": "anime city",
        "image_url": "https://example.com/source.png"
      }
    ]
  }'
```

### 获取任务列表

```bash
curl -X GET "http://localhost:8787/api/video/list?limit=20" \
  -H "X-APP-TOKEN: <your-token>"
```

### 查询任务状态

```bash
curl -X GET "http://localhost:8787/api/video/status?task_id=task_xxx" \
  -H "X-APP-TOKEN: <your-token>"
```

## 备注

- 不要在前端暴露 `KIE_API_KEY`。
- `/api/callback` 放行，不需要 `X-APP-TOKEN`。
- `FILES_DIR` 如果使用相对路径，默认是 `server/files`。
