import dotenv from "dotenv";
import express from "express";
import rateLimit from "express-rate-limit";
import pLimit from "p-limit";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 8787);
const APP_TOKEN = process.env.APP_TOKEN;
const KIE_API_KEY = process.env.KIE_API_KEY;
const KIE_BASE_URL = process.env.KIE_BASE_URL || "https://api.kie.ai";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://your-domain.com";

if (!APP_TOKEN) {
  console.warn("APP_TOKEN is not set; all requests will be rejected.");
}

if (!KIE_API_KEY) {
  console.warn("KIE_API_KEY is not set; video requests will fail.");
}

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

// In-memory storage; mappings will be lost if the server restarts.
const taskStore = new Map();
const kieToLocal = new Map();

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
  10: "20",
  15: "30"
};

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

const createOne = async (job = {}) => {
  const {
    mode,
    prompt,
    image_url,
    image_urls,
    duration = 5,
    aspect_ratio = "16:9",
    remove_watermark,
    character_id_list
  } = job;

  if (!mode || !prompt) {
    throw new ApiError(400, "Missing required fields");
  }

  if (![
    "t2v",
    "i2v"
  ].includes(mode)) {
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

  const localTaskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();

  const input = {
    prompt,
    aspect_ratio: resolvedAspectRatio,
    n_frames: resolvedFrames
  };

  if (mode === "i2v") {
    input.image_urls = resolvedImageUrls;
  }

  if (typeof remove_watermark === "boolean") {
    input.remove_watermark = remove_watermark;
  }

  if (Array.isArray(character_id_list) && character_id_list.length > 0) {
    input.character_id_list = character_id_list;
  }

  const response = await fetch(`${KIE_BASE_URL}/api/v1/jobs/createTask`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${KIE_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      callBackUrl: `${PUBLIC_BASE_URL}/api/callback`,
      input
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new ApiError(502, `Kie API error: ${errorText}`);
  }

  const data = await response.json();
  if (data?.code !== 200 || !data?.data?.taskId) {
    throw new ApiError(502, data?.msg || "Kie API error");
  }

  const kieTaskId = data.data.taskId;
  const task = {
    id: localTaskId,
    createdAt,
    params: { mode, prompt, image_url, image_urls, duration, aspect_ratio },
    status: "queued",
    progress: 0,
    video_url: null,
    error: null,
    kieTaskId
  };

  taskStore.set(localTaskId, task);
  kieToLocal.set(kieTaskId, localTaskId);
  console.log(`Created task localTaskId=${localTaskId} kieTaskId=${kieTaskId}`);

  return { localTaskId, kieTaskId, status: task.status };
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
    const { localTaskId } = await createOne(req.body);
    return res.json({ task_id: localTaskId });
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
          const { localTaskId, kieTaskId, status } = await createOne(job);
          return {
            index,
            task_id: localTaskId,
            kie_task_id: kieTaskId,
            status
          };
        } catch (error) {
          return {
            index,
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

app.get("/api/video/status", async (req, res) => {
  const { task_id } = req.query;

  if (!task_id) {
    return res.status(400).json({ error: "task_id is required" });
  }

  const task = taskStore.get(task_id);
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

app.post("/api/callback", (req, res) => {
  const kieTaskId = req.body?.data?.taskId;
  const state = req.body?.data?.state;

  if (!kieTaskId) {
    return res.status(400).json({ error: "Missing taskId" });
  }

  const localTaskId = kieToLocal.get(kieTaskId);
  if (!localTaskId) {
    console.warn(`Callback task not found for kieTaskId=${kieTaskId}`);
    return res.status(404).json({ error: "Task not found" });
  }

  const task = taskStore.get(localTaskId);
  if (!task) {
    console.warn(`Callback local task missing for kieTaskId=${kieTaskId}`);
    return res.status(404).json({ error: "Task not found" });
  }

  console.log(`Callback received kieTaskId=${kieTaskId} state=${state}`);
  if (state) {
    task.status = state;
  }

  if (state === "success") {
    task.progress = 100;
    const rawResultJson = req.body?.data?.resultJson;
    let resultPayload = rawResultJson;

    if (typeof rawResultJson === "string") {
      try {
        resultPayload = JSON.parse(rawResultJson);
      } catch (error) {
        console.warn(`Failed to parse resultJson for kieTaskId=${kieTaskId}: ${error.message}`);
      }
    }

    const resultUrls = resultPayload?.resultUrls || resultPayload?.resultUrl;
    if (Array.isArray(resultUrls)) {
      task.video_url = resultUrls[0] || null;
    } else if (typeof resultUrls === "string") {
      task.video_url = resultUrls;
    }
  }

  if (state === "fail") {
    task.error = req.body?.data?.failMsg || req.body?.data?.msg || req.body?.data?.failCode || "Kie task failed";
  }

  return res.json({ ok: true });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`AI video server listening on port ${PORT}`);
});
