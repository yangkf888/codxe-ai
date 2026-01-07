import dotenv from "dotenv";
import express from "express";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 8787);
const APP_TOKEN = process.env.APP_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com";
const OPENAI_VIDEO_MODEL = process.env.OPENAI_VIDEO_MODEL || "gpt-4o-mini";

if (!APP_TOKEN) {
  console.warn("APP_TOKEN is not set; all requests will be rejected.");
}

if (!OPENAI_API_KEY) {
  console.warn("OPENAI_API_KEY is not set; video requests will fail.");
}

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

const taskStore = new Map();

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

  const token = req.header("X-APP-TOKEN");
  if (!APP_TOKEN || token !== APP_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
});

app.post("/api/video/create", limiter, async (req, res) => {
  const { mode, prompt, image_url, duration, aspect_ratio } = req.body || {};

  if (!mode || !prompt || !duration || !aspect_ratio) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!['t2v', 'i2v'].includes(mode)) {
    return res.status(400).json({ error: "Invalid mode" });
  }

  if (mode === "i2v" && !image_url) {
    return res.status(400).json({ error: "image_url is required for i2v" });
  }

  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();

  const task = {
    id: taskId,
    createdAt,
    params: { mode, prompt, image_url, duration, aspect_ratio },
    status: "queued",
    progress: 0,
    video_url: null,
    error: null,
    openai_task_id: null
  };

  taskStore.set(taskId, task);

  try {
    const response = await fetch(`${OPENAI_BASE_URL}/v1/videos`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_VIDEO_MODEL,
        mode,
        prompt,
        image_url,
        duration,
        aspect_ratio
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      task.status = "failed";
      task.error = `OpenAI API error: ${errorText}`;
      return res.status(500).json({ error: "Failed to create video task" });
    }

    const data = await response.json();
    task.openai_task_id = data.id || data.task_id || taskId;
    task.status = data.status || "queued";
    task.progress = data.progress ?? 0;
    task.video_url = data.video_url || null;
    task.error = data.error || null;

    return res.json({ task_id: taskId });
  } catch (error) {
    task.status = "failed";
    task.error = error.message;
    return res.status(500).json({ error: "Failed to create video task" });
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

  const terminalStates = new Set(["succeeded", "failed"]);

  if (!terminalStates.has(task.status) && task.openai_task_id) {
    try {
      const response = await fetch(`${OPENAI_BASE_URL}/v1/videos/${task.openai_task_id}`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      });

      if (response.ok) {
        const data = await response.json();
        task.status = data.status || task.status;
        task.progress = data.progress ?? task.progress;
        task.video_url = data.video_url || task.video_url;
        task.error = data.error || task.error;
      }
    } catch (error) {
      task.error = error.message;
    }
  }

  return res.json({
    status: task.status,
    progress: task.progress,
    video_url: task.video_url,
    error: task.error
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`AI video server listening on port ${PORT}`);
});
