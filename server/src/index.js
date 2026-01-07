import dotenv from "dotenv";
import express from "express";
import rateLimit from "express-rate-limit";

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
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded" }
});

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
  const { mode, prompt, image_url, image_urls, duration, aspect_ratio } = req.body || {};

  if (!mode || !prompt || !duration || !aspect_ratio) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!["t2v", "i2v"].includes(mode)) {
    return res.status(400).json({ error: "Invalid mode" });
  }

  const resolvedImageUrls = Array.isArray(image_urls)
    ? image_urls.filter(Boolean)
    : image_url
      ? [image_url]
      : [];

  if (mode === "i2v" && resolvedImageUrls.length === 0) {
    return res.status(400).json({ error: "image_url or image_urls is required for i2v" });
  }

  const localTaskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();

  try {
    const t2vModel = process.env.KIE_T2V_MODEL || "sora-2-text-to-video";
    const i2vModel = process.env.KIE_I2V_MODEL || "sora-2-image-to-video";
    const model = mode === "i2v" ? i2vModel : t2vModel;
    const ratioMap = {
      "16:9": "landscape",
      "9:16": "portrait",
      "1:1": "square"
    };
    const frameMap = {
      5: 10,
      10: 20,
      15: 30
    };

    const response = await fetch(`${KIE_BASE_URL}/api/v1/jobs/createTask`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${KIE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        prompt,
        aspect_ratio: ratioMap[aspect_ratio],
        n_frames: frameMap[Number(duration)],
        image_urls: mode === "i2v" ? resolvedImageUrls : undefined,
        callBackUrl: `${PUBLIC_BASE_URL}/api/callback`
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(502).json({ error: `Kie API error: ${errorText}` });
    }

    const data = await response.json();
    if (data?.code !== 200 || !data?.data?.taskId) {
      return res.status(502).json({ error: data?.msg || "Kie API error" });
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

    return res.json({ task_id: localTaskId });
  } catch (error) {
    return res.status(500).json({ error: `Failed to create video task: ${error.message}` });
  }
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
