import dotenv from "dotenv";
import express from "express";
import rateLimit from "express-rate-limit";
import pLimit from "p-limit";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { createClient } from "redis";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 8787);
const APP_TOKEN = process.env.APP_TOKEN;
const KIE_API_KEY = process.env.KIE_API_KEY;
const KIE_BASE_URL = process.env.KIE_BASE_URL || "https://api.kie.ai";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://your-domain.com";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6380";
const TASK_TTL_SECONDS = Number(process.env.TASK_TTL_SECONDS || 60 * 60 * 24 * 7);
const FILES_DIR = process.env.FILES_DIR || path.resolve(process.cwd(), "files");
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.resolve(process.cwd(), "uploads");
const PUBLIC_FILES_PATH = process.env.PUBLIC_FILES_PATH || "/files";
const NORMALIZED_FILES_PATH = PUBLIC_FILES_PATH.startsWith("/")
  ? PUBLIC_FILES_PATH
  : `/${PUBLIC_FILES_PATH}`;

if (!APP_TOKEN) {
  console.warn("APP_TOKEN is not set; all requests will be rejected.");
}

if (!KIE_API_KEY) {
  console.warn("KIE_API_KEY is not set; video requests will fail.");
}

const redisClient = createClient({ url: REDIS_URL });
redisClient.on("error", (error) => {
  console.error("Redis error", error);
});

const taskKey = (localTaskId) => `aiVideo:task:${localTaskId}`;
const mapKey = (kieTaskId) => `aiVideo:map:${kieTaskId}`;
const recentKey = "aiVideo:recent";

const buildPublicVideoUrl = (localTaskId) => {
  const base = PUBLIC_BASE_URL.replace(/\/+$/, "");
  return `${base}${NORMALIZED_FILES_PATH}/${localTaskId}.mp4`;
};

const parseTask = (raw) => {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`Failed to parse task payload: ${error.message}`);
    return null;
  }
};

const getTask = async (localTaskId) => {
  const raw = await redisClient.get(taskKey(localTaskId));
  return parseTask(raw);
};

const saveTask = async (task, { refreshRecent = false } = {}) => {
  const multi = redisClient.multi();
  multi.set(taskKey(task.localTaskId), JSON.stringify(task), { EX: TASK_TTL_SECONDS });
  if (task.kieTaskId) {
    multi.set(mapKey(task.kieTaskId), task.localTaskId, { EX: TASK_TTL_SECONDS });
  }
  if (refreshRecent) {
    const score = Number(new Date(task.createdAt)) || Date.now();
    multi.zAdd(recentKey, [{ score, value: task.localTaskId }]);
    multi.expire(recentKey, TASK_TTL_SECONDS);
  }
  await multi.exec();
};

const ensureFilesDir = async () => {
  await fs.promises.mkdir(FILES_DIR, { recursive: true });
};

const ensureUploadsDir = () => {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
};

const downloadVideo = async (localTaskId, originUrl) => {
  const response = await fetch(originUrl);
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}`);
  }
  await ensureFilesDir();
  const filePath = path.join(FILES_DIR, `${localTaskId}.mp4`);
  if (!response.body) {
    throw new Error("Download response missing body");
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(filePath));
  return buildPublicVideoUrl(localTaskId);
};

const downloadAndPersistVideo = async (localTaskId, originUrl) => {
  try {
    const videoUrl = await downloadVideo(localTaskId, originUrl);
    const task = await getTask(localTaskId);
    if (!task) {
      return;
    }
    task.video_url = videoUrl;
    await saveTask(task);
  } catch (error) {
    console.warn(`Failed to download video for task ${localTaskId}: ${error.message}`);
    const task = await getTask(localTaskId);
    if (!task) {
      return;
    }
    task.error = task.error || `Failed to download video: ${error.message}`;
    await saveTask(task);
  }
};

const parseResultVideoUrl = (rawResultJson) => {
  if (!rawResultJson) {
    return null;
  }
  let payload = rawResultJson;
  if (typeof rawResultJson === "string") {
    try {
      payload = JSON.parse(rawResultJson);
    } catch (error) {
      if (rawResultJson.startsWith("http")) {
        return rawResultJson;
      }
      console.warn(`Failed to parse resultJson: ${error.message}`);
      return null;
    }
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const resultUrls = payload.resultUrls || payload.resultUrl;
  if (Array.isArray(resultUrls)) {
    return resultUrls[0] || null;
  }
  if (typeof resultUrls === "string") {
    return resultUrls;
  }
  return null;
};

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(NORMALIZED_FILES_PATH, express.static(FILES_DIR));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded" }
});

const aspectRatioMap = {
  "16:9": "landscape",
  "9:16": "portrait",
  "1:1": "square",
  landscape: "landscape",
  portrait: "portrait",
  square: "square"
};

const frameMap = {
  5: "10",
  10: "10",
  15: "15"
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        ensureUploadsDir();
        cb(null, UPLOADS_DIR);
      } catch (error) {
        cb(error);
      }
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const safeName = file.originalname ? path.basename(file.originalname) : "upload";
      cb(null, `${uniqueSuffix}-${safeName}`);
    }
  })
});

class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const resolveImageUrls = (image_url, image_urls) => {
  if (Array.isArray(image_urls)) {
    return image_urls.filter(Boolean);
  }
  if (image_url) {
    return [image_url];
  }
  return [];
};

const kieClient = {
  async createTask(payload) {
    const response = await fetch(`${KIE_BASE_URL}/api/v1/jobs/createTask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KIE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new ApiError(502, `Kie API error: ${errorText}`);
    }

    const data = await response.json();
    if (data?.code !== 200 || !data?.data?.taskId) {
      throw new ApiError(502, data?.msg || "Kie API error");
    }

    return data.data.taskId;
  }
};

const createOne = async (job = {}) => {
  const {
    mode,
    prompt,
    image_url,
    image_urls,
    duration = 5,
    aspect_ratio = "16:9",
    character_id_list,
    batchCount = 1
  } = job;
  const remove_watermark = true;

  if (!mode || !prompt) {
    throw new ApiError(400, "Missing required fields");
  }

  if (!["t2v", "i2v"].includes(mode)) {
    throw new ApiError(400, "Invalid mode");
  }

  const resolvedImageUrls = resolveImageUrls(image_url, image_urls);

  if (mode === "i2v" && resolvedImageUrls.length === 0) {
    throw new ApiError(400, "image_url or image_urls is required for i2v");
  }

  const resolvedAspectRatio = aspectRatioMap[aspect_ratio];
  if (!resolvedAspectRatio) {
    throw new ApiError(400, "Invalid aspect_ratio");
  }

  const resolvedFrames = frameMap[Number(duration)];
  if (!resolvedFrames) {
    throw new ApiError(400, "Invalid duration");
  }

  const t2vModel = process.env.KIE_T2V_MODEL || "sora-2-text-to-video";
  const i2vModel = process.env.KIE_I2V_MODEL || "sora-2-image-to-video";
  const model = mode === "i2v" ? i2vModel : t2vModel;

  const normalizedBatchCount = Math.min(Math.max(Number(batchCount) || 1, 1), 20);

  const input = {
    prompt,
    aspect_ratio: resolvedAspectRatio,
    n_frames: resolvedFrames,
    remove_watermark: true
  };

  if (mode === "i2v") {
    input.image_urls = resolvedImageUrls;
  }

  if (Array.isArray(character_id_list) && character_id_list.length > 0) {
    input.character_id_list = character_id_list;
  }

  const taskPayload = {
    model,
    callBackUrl: `${PUBLIC_BASE_URL}/api/callback`,
    input
  };

  const kieTaskIds = await Promise.all(
    Array.from({ length: normalizedBatchCount }, () => kieClient.createTask(taskPayload))
  );

  const tasks = await Promise.all(
    kieTaskIds.map(async (kieTaskId) => {
      const localTaskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = new Date().toISOString();
      const task = {
        localTaskId,
        createdAt,
        mode,
        prompt,
        status: "queued",
        progress: 0,
        video_url: null,
        origin_video_url: null,
        error: null,
        kieTaskId,
        params: {
          mode,
          prompt,
          image_url,
          image_urls,
          duration,
          aspect_ratio,
          remove_watermark,
          character_id_list,
          batchCount: normalizedBatchCount
        }
      };

      await saveTask(task, { refreshRecent: true });
      console.log(`Created task localTaskId=${localTaskId} kieTaskId=${kieTaskId}`);
      return { localTaskId, kieTaskId, status: task.status };
    })
  );

  return { tasks };
};

app.use((req, res, next) => {
  if (!req.path.startsWith("/api")) {
    return next();
  }

  if (req.path === "/api/callback") {
    return next();
  }

  const token = req.header("X-APP-TOKEN");
  if (!APP_TOKEN || token !== APP_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
});

app.post("/api/video/create", limiter, async (req, res) => {
  try {
    const { tasks } = await createOne(req.body);
    return res.json({
      task_ids: tasks.map((task) => task.localTaskId),
      tasks
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ error: error.message || "Failed to create video task" });
  }
});

app.post("/api/video/batch_create", limiter, async (req, res) => {
  const { concurrency, jobs } = req.body || {};

  if (!Array.isArray(jobs)) {
    return res.status(400).json({ error: "jobs must be an array" });
  }

  const normalizedConcurrency = Math.min(Math.max(Number(concurrency) || 10, 1), 30);
  const limit = pLimit(normalizedConcurrency);

  const results = await Promise.all(
    jobs.map((job, index) =>
      limit(async () => {
        try {
          const { tasks } = await createOne(job);
          return {
            index,
            ok: true,
            task_ids: tasks.map((task) => task.localTaskId),
            tasks
          };
        } catch (error) {
          return {
            index,
            ok: false,
            error: error.message || "Failed to create task"
          };
        }
      })
    )
  );

  return res.json({
    accepted: jobs.length,
    concurrency: normalizedConcurrency,
    results
  });
});

app.post("/api/upload", limiter, upload.single("file"), async (req, res) => {
  let responseSent = false;
  try {
    if (!KIE_API_KEY) {
      responseSent = true;
      return res.status(500).json({ ok: false, error: "KIE_API_KEY is not set" });
    }

    if (!req.file) {
      responseSent = true;
      return res.status(400).json({ ok: false, error: "file is required" });
    }

    const formData = new FormData();
    formData.append("file", fs.createReadStream(req.file.path), {
      filename: req.file.originalname || "upload",
      contentType: req.file.mimetype
    });
    formData.append("uploadPath", "ai-video-uploads");

    const fileName = req.body?.fileName;
    if (fileName) {
      formData.append("fileName", fileName);
    }

    const response = await axios.post(
      "https://kieai.redpandaai.co/api/file-stream-upload",
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${KIE_API_KEY}`
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: () => true
      }
    );

    if (response.status < 200 || response.status >= 300) {
      const message =
        response.data?.msg ||
        response.data?.message ||
        `Upload failed with status ${response.status}`;
      responseSent = true;
      return res.status(502).json({ ok: false, error: message });
    }

    const responseBody = response.data || {};
    const fileUrl =
      responseBody.data?.downloadUrl ||
      responseBody.downloadUrl ||
      responseBody.data?.fileUrl ||
      responseBody.fileUrl;
    if (!fileUrl) {
      responseSent = true;
      return res.status(502).json({ ok: false, error: "Upload response missing fileUrl" });
    }

    responseSent = true;
    return res.json({ ok: true, fileUrl });
  } catch (error) {
    console.error("Upload failed", error);
    const message =
      error.response?.data?.msg || error.response?.data?.message || error.message || "Upload failed";
    if (!responseSent) {
      responseSent = true;
      return res.status(500).json({ ok: false, error: message });
    }
    return undefined;
  } finally {
    if (req.file?.path) {
      try {
        await fs.promises.unlink(req.file.path);
      } catch (error) {
        console.warn(`Failed to remove temp upload: ${error.message}`);
      }
    }
  }
});

app.get("/api/video/status", async (req, res) => {
  const { task_id } = req.query;

  if (!task_id) {
    return res.status(400).json({ error: "task_id is required" });
  }

  const task = await getTask(task_id);
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }

  return res.json({
    status: task.status,
    progress: task.progress,
    video_url: task.video_url,
    error: task.error
  });
});

app.get("/api/video/list", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const ids = await redisClient.zRange(recentKey, 0, limit - 1, { REV: true });
  if (ids.length === 0) {
    return res.json({ tasks: [] });
  }
  const rawTasks = await redisClient.mGet(ids.map((id) => taskKey(id)));
  const tasks = [];
  const missingIds = [];

  rawTasks.forEach((raw, index) => {
    if (!raw) {
      missingIds.push(ids[index]);
      return;
    }
    const task = parseTask(raw);
    if (!task) {
      missingIds.push(ids[index]);
      return;
    }
    tasks.push({
      localTaskId: task.localTaskId,
      createdAt: task.createdAt,
      mode: task.mode,
      prompt: task.prompt,
      status: task.status,
      progress: task.progress,
      video_url: task.video_url || null,
      origin_video_url: task.origin_video_url || null,
      error: task.error || null
    });
  });

  if (missingIds.length > 0) {
    await redisClient.zRem(recentKey, missingIds);
  }

  return res.json({ tasks });
});

app.delete("/api/tasks/:id", async (req, res) => {
  const localTaskId = req.params.id;
  if (!localTaskId) {
    return res.status(400).json({ error: "Task id is required" });
  }

  const task = await getTask(localTaskId);
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }

  const multi = redisClient.multi();
  multi.del(taskKey(localTaskId));
  multi.zRem(recentKey, localTaskId);
  if (task.kieTaskId) {
    multi.del(mapKey(task.kieTaskId));
  }

  await multi.exec();
  return res.json({ success: true, id: localTaskId });
});

app.post("/api/callback", async (req, res) => {
  const kieTaskId = req.body?.data?.taskId;
  const state = req.body?.data?.state;
  const progress = req.body?.data?.progress;

  if (!kieTaskId) {
    return res.status(400).json({ error: "Missing taskId" });
  }

  const localTaskId = await redisClient.get(mapKey(kieTaskId));
  if (!localTaskId) {
    console.warn(`Callback task not found for kieTaskId=${kieTaskId}`);
    return res.json({ ok: true });
  }

  const task = await getTask(localTaskId);
  if (!task) {
    console.warn(`Callback local task missing for kieTaskId=${kieTaskId}`);
    return res.json({ ok: true });
  }

  console.log(`Callback received kieTaskId=${kieTaskId} state=${state}`);
  if (state) {
    task.status = state;
  }
  const normalizedProgress = Number(progress);
  if (!Number.isNaN(normalizedProgress)) {
    task.progress = normalizedProgress;
  }

  if (state === "success") {
    task.progress = 100;
    const originUrl = parseResultVideoUrl(req.body?.data?.resultJson);
    if (originUrl) {
      task.origin_video_url = originUrl;
    } else {
      task.error = task.error || "Missing origin video url in callback";
    }
    await saveTask(task);
    if (originUrl) {
      void downloadAndPersistVideo(localTaskId, originUrl);
    }
    return res.json({ ok: true });
  }

  if (state === "fail") {
    task.error =
      req.body?.data?.failMsg ||
      req.body?.data?.msg ||
      req.body?.data?.failCode ||
      "Kie task failed";
  }

  await saveTask(task);
  return res.json({ ok: true });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

const startServer = async () => {
  try {
    await redisClient.connect();
    await ensureFilesDir();
    app.listen(PORT, () => {
      console.log(`AI video server listening on port ${PORT}`);
    });
  } catch (error) {
    console.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
};

startServer();
