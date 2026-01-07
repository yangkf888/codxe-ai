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
- 后端持有 `OPENAI_API_KEY`，负责调用 OpenAI 视频生成接口。
- `/api/video/create` 创建任务，返回 `task_id`。
- `/api/video/status` 轮询任务状态。
- 内存 Map 保存任务状态，服务重启后可接受丢失。

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
  "duration": 5 | 10 | 15,
  "aspect_ratio": "16:9" | "9:16" | "1:1"
}
```

返回：

```json
{ "task_id": "string" }
```

### GET /api/video/status?task_id=xxx

返回：

```json
{
  "status": "queued" | "running" | "succeeded" | "failed",
  "progress": 0.0,
  "video_url": "string (可选)",
  "error": "string (可选)"
}
```

## 部署步骤（Linux 服务器）

> 假设部署目录为 `/var/www/ai-video`，Node.js 已安装，Nginx 可用。

### 1) 获取代码

```bash
git clone <your-repo> /var/www/ai-video
cd /var/www/ai-video
```

### 2) 配置后端环境变量

```bash
cp server/.env.example server/.env
```

编辑 `server/.env`：

```
OPENAI_API_KEY=...
APP_TOKEN=...
PORT=8787
```

### 3) 安装依赖并启动后端

```bash
cd /var/www/ai-video/server
npm install
npm run start
```

建议使用 systemd（见 `deploy/ai-video.service`）进行守护运行。

### 4) 构建前端并放置到 Nginx 静态目录

```bash
cd /var/www/ai-video/web
npm install
npm run build
```

将 `web/dist` 作为 Nginx 静态目录。

### 5) 配置 Nginx

复制 `deploy/nginx.conf` 并根据域名修改：

```bash
sudo cp /var/www/ai-video/deploy/nginx.conf /etc/nginx/conf.d/ai-video.conf
sudo nginx -t
sudo systemctl reload nginx
```

Nginx 将提供：

- `/` -> `web/dist`
- `/api` -> `http://127.0.0.1:8787`

### 6) 使用 systemd 启动后端（可选）

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

## 备注

- OpenAI 视频接口端点默认为 `https://api.openai.com/v1/videos`。
- 如果 API 端点不同，可通过环境变量 `OPENAI_BASE_URL` 或 `OPENAI_VIDEO_MODEL` 覆盖。
