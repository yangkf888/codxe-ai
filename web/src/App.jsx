import React, { useCallback, useEffect, useMemo, useState } from "react";

const initialForm = {
  mode: "t2v",
  prompt: "",
  image_url: "",
  duration: "5",
  aspect_ratio: "16:9"
};

const statusLabels = {
  queued: "Queued",
  running: "Running",
  success: "Succeeded",
  fail: "Failed",
  succeeded: "Succeeded",
  failed: "Failed"
};

const terminalStatuses = new Set(["success", "fail", "succeeded", "failed"]);

const formatProgress = (value) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return null;
  }
  const numeric = Number(value);
  const normalized = numeric <= 1 ? numeric * 100 : numeric;
  return Math.min(Math.max(Math.round(normalized), 0), 100);
};

const formatPrompt = (prompt) => prompt || "(no prompt)";

const formatTimestamp = (value) => {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
};

export default function App() {
  const [form, setForm] = useState(initialForm);
  const [batchMode, setBatchMode] = useState(false);
  const [batchPrompt, setBatchPrompt] = useState("");
  const [batchImages, setBatchImages] = useState([]);
  const [batchConcurrency, setBatchConcurrency] = useState("5");
  const [batchResult, setBatchResult] = useState(null);
  const [token, setToken] = useState("");
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState("");
  const [uploadState, setUploadState] = useState({
    status: "idle",
    message: "",
    fileName: ""
  });

  const shouldPoll = useMemo(
    () => history.some((task) => !terminalStatuses.has(task.status)),
    [history]
  );

  const fetchHistory = useCallback(
    async (silent = false) => {
      if (!silent) {
        setHistoryLoading(true);
      }
      try {
        const response = await fetch("/api/video/list?limit=50", {
          headers: token ? { "X-APP-TOKEN": token } : {}
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "Failed to load history");
        }
        const data = await response.json();
        setHistory(data.tasks || []);
      } catch (err) {
        if (!silent) {
          setError(err.message);
        }
      } finally {
        if (!silent) {
          setHistoryLoading(false);
        }
      }
    },
    [token]
  );

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  useEffect(() => {
    if (!shouldPoll) {
      return undefined;
    }

    const interval = setInterval(() => {
      fetchHistory(true);
    }, 5000);

    return () => clearInterval(interval);
  }, [fetchHistory, shouldPoll]);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
    if (name === "image_url") {
      setUploadState({ status: "idle", message: "", fileName: "" });
    }
  };

  const handleCopy = async (value) => {
    if (!value) {
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
    } catch (err) {
      setError(err.message || "Failed to copy link");
    }
  };

  const handleBatchImageChange = async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) {
      setBatchImages([]);
      return;
    }

    try {
      const dataUrls = await Promise.all(
        files.map(
          (file) =>
            new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve({ name: file.name, dataUrl: reader.result });
              reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
              reader.readAsDataURL(file);
            })
        )
      );
      setBatchImages(dataUrls);
    } catch (err) {
      setError(err.message || "Failed to load batch images.");
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setBatchResult(null);

    if (!batchMode && !form.prompt.trim()) {
      setError("Prompt is required.");
      return;
    }

    if (!batchMode && form.mode === "i2v" && !form.image_url.trim()) {
      setError("Image URL is required for Image-to-Video.");
      return;
    }

    setLoading(true);

    try {
      if (batchMode) {
        const trimmedPrompts = batchPrompt
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const hasBatchImages = batchImages.length > 0;

        if (!hasBatchImages && trimmedPrompts.length === 0) {
          setError("Provide batch prompts or upload images for batch mode.");
          return;
        }

        if (hasBatchImages && form.mode !== "i2v") {
          setError("Batch image upload is only available for Image-to-Video.");
          return;
        }

        if (hasBatchImages && !form.prompt.trim()) {
          setError("Prompt is required when submitting image batches.");
          return;
        }

        if (!hasBatchImages && form.mode === "i2v") {
          setError("Batch prompt mode currently supports Text-to-Video only.");
          return;
        }

        const jobs = hasBatchImages
          ? batchImages.map((image) => ({
              mode: "i2v",
              prompt: form.prompt.trim(),
              image_url: image.dataUrl,
              duration: Number(form.duration),
              aspect_ratio: form.aspect_ratio
            }))
          : trimmedPrompts.map((prompt) => ({
              mode: "t2v",
              prompt,
              duration: Number(form.duration),
              aspect_ratio: form.aspect_ratio
            }));

        const response = await fetch("/api/video/batch_create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { "X-APP-TOKEN": token } : {})
          },
          body: JSON.stringify({
            concurrency: Number(batchConcurrency) || 5,
            jobs
          })
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "Failed to create batch tasks");
        }

        const data = await response.json();
        const results = data.results || [];
        const successes = results.filter((result) => result.ok);
        const failures = results.filter((result) => !result.ok);

        const newTasks = successes.map((result) => {
          const job = jobs[result.index] || {};
          return {
            localTaskId: result.task_id,
            createdAt: new Date().toISOString(),
            mode: job.mode || form.mode,
            prompt: job.prompt,
            status: "queued",
            progress: 0,
            video_url: null,
            origin_video_url: null,
            error: null
          };
        });

        if (newTasks.length > 0) {
          setHistory((prev) => [...newTasks, ...prev]);
        }

        setBatchResult({
          total: jobs.length,
          successCount: successes.length,
          failureCount: failures.length,
          failures: failures.map((failure) => ({
            index: failure.index,
            error: failure.error || "Failed to submit task"
          }))
        });
      } else {
        const response = await fetch("/api/video/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { "X-APP-TOKEN": token } : {})
          },
          body: JSON.stringify({
            mode: form.mode,
            prompt: form.prompt,
            image_url: form.mode === "i2v" ? form.image_url : undefined,
            duration: Number(form.duration),
            aspect_ratio: form.aspect_ratio
          })
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "Failed to create task");
        }

        const data = await response.json();
        const newTask = {
          localTaskId: data.task_id,
          createdAt: new Date().toISOString(),
          mode: form.mode,
          prompt: form.prompt,
          status: "queued",
          progress: 0,
          video_url: null,
          origin_video_url: null,
          error: null
        };
        setHistory((prev) => [newTask, ...prev]);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">AI Video Generator</p>
          <h1>Generate videos from text or images</h1>
          <p className="subtitle">
            Submit a prompt, choose duration and aspect ratio, and let the backend handle the OpenAI video task.
          </p>
        </div>
        <div className="token-card">
          <label htmlFor="token">X-APP-TOKEN</label>
          <input
            id="token"
            type="password"
            placeholder="Enter your APP_TOKEN"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <small>Token is required for API access. Stored only in memory.</small>
        </div>
      </header>

      <main className="content">
        <section className="card">
          <h2>Create a task</h2>
          <form className="form" onSubmit={handleSubmit}>
            <div className="batch-toggle">
              <div>
                <span className="toggle-title">Batch Mode</span>
                <p className="muted">Submit multiple prompts or images in one request.</p>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={batchMode}
                  onChange={(event) => setBatchMode(event.target.checked)}
                />
                <span className="slider" />
              </label>
            </div>
            <div className="field">
              <label htmlFor="mode">Mode</label>
              <select id="mode" name="mode" value={form.mode} onChange={handleChange}>
                <option value="t2v">Text-to-Video</option>
                <option value="i2v">Image-to-Video</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="prompt">{batchMode ? "Base prompt" : "Prompt"}</label>
              <textarea
                id="prompt"
                name="prompt"
                rows="4"
                placeholder={
                  batchMode ? "Used for batch image uploads (one prompt for all images)." : "Describe the video you want..."
                }
                value={form.prompt}
                onChange={handleChange}
              />
              {batchMode && <small className="helper">Base prompt is required only for batch images.</small>}
            </div>
            {batchMode && (
              <div className="field">
                <label htmlFor="batch_prompt">Batch prompts (one per line)</label>
                <textarea
                  id="batch_prompt"
                  name="batch_prompt"
                  rows="5"
                  placeholder="Line 1 prompt\nLine 2 prompt\nLine 3 prompt"
                  value={batchPrompt}
                  onChange={(event) => setBatchPrompt(event.target.value)}
                />
                <small className="helper">Each non-empty line becomes a separate task.</small>
              </div>
            )}
            {batchMode && form.mode === "i2v" && (
              <div className="field">
                <label htmlFor="batch_images">Batch image upload</label>
                <input
                  id="batch_images"
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleBatchImageChange}
                />
                {batchImages.length > 0 ? (
                  <div className="file-list">
                    {batchImages.map((image, index) => (
                      <span key={`${image.name}-${index}`} className="file-chip">
                        {image.name}
                      </span>
                    ))}
                  </div>
                ) : (
                  <small className="helper">Upload images to create one task per image.</small>
                )}
              </div>
            )}
            {!batchMode && form.mode === "i2v" && (
              <div className="field">
                <label htmlFor="image_url">Image URL</label>
                <input
                  id="image_url"
                  name="image_url"
                  type="url"
                  placeholder="https://example.com/image.jpg"
                  value={form.image_url}
                  onChange={handleChange}
                  disabled={uploadState.status === "uploading"}
                />
                <div className="upload">
                  <input
                    id="image_upload"
                    name="image_upload"
                    type="file"
                    accept="image/*"
                    onChange={handleUpload}
                    disabled={uploadState.status === "uploading"}
                  />
                  <label className="muted" htmlFor="image_upload">
                    Upload an image instead of pasting a URL.
                  </label>
                </div>
                {uploadState.status !== "idle" && (
                  <p className={`upload-status upload-${uploadState.status}`}>
                    {uploadState.message}
                    {uploadState.fileName ? ` (${uploadState.fileName})` : ""}
                  </p>
                )}
              </div>
            )}
            <div className="grid">
              <div className="field">
                <label htmlFor="duration">Duration (sec)</label>
                <select id="duration" name="duration" value={form.duration} onChange={handleChange}>
                  <option value="5">5</option>
                  <option value="10">10</option>
                  <option value="15">15</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="aspect_ratio">Aspect ratio</label>
                <select
                  id="aspect_ratio"
                  name="aspect_ratio"
                  value={form.aspect_ratio}
                  onChange={handleChange}
                >
                  <option value="16:9">16:9</option>
                  <option value="9:16">9:16</option>
                  <option value="1:1">1:1</option>
                </select>
              </div>
            </div>
            {batchMode && (
              <div className="field">
                <label htmlFor="concurrency">Concurrency</label>
                <input
                  id="concurrency"
                  name="concurrency"
                  type="number"
                  min="1"
                  max="30"
                  value={batchConcurrency}
                  onChange={(event) => setBatchConcurrency(event.target.value)}
                />
                <small className="helper">Default 5; higher values submit in parallel.</small>
              </div>
            )}
            {error && <p className="error">{error}</p>}
            {batchResult && (
              <div className="batch-result">
                <p>
                  Batch submitted: {batchResult.successCount} succeeded, {batchResult.failureCount} failed.
                </p>
                {batchResult.failureCount > 0 && (
                  <ul>
                    {batchResult.failures.map((failure) => (
                      <li key={failure.index}>
                        Task #{failure.index + 1}: {failure.error}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <button className="primary" type="submit" disabled={loading}>
              {loading ? (batchMode ? "Submitting batch..." : "Creating...") : batchMode ? "Submit batch" : "Generate"}
            </button>
          </form>
        </section>

        <section className="card history">
          <div className="history-header">
            <h2>History</h2>
            <button className="ghost" type="button" onClick={() => fetchHistory()} disabled={historyLoading}>
              {historyLoading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
          {history.length === 0 ? (
            <p className="muted">No tasks yet. Submit a prompt to get started.</p>
          ) : (
            <ul className="history-list">
              {history.map((task) => {
                const progress = formatProgress(task.progress);
                return (
                  <li key={task.localTaskId} className="history-item">
                    <div className="history-top">
                      <div>
                        <div className="task-id">{task.localTaskId}</div>
                        <div className="task-meta-line">
                          <span>{formatTimestamp(task.createdAt)}</span>
                          <span className="chip">{task.mode}</span>
                        </div>
                      </div>
                      <div className={`status status-${task.status}`}>{statusLabels[task.status] || task.status}</div>
                    </div>
                    <p className="prompt">{formatPrompt(task.prompt)}</p>
                    <div className="task-meta">
                      {progress !== null && <span>Progress: {progress}%</span>}
                      {task.error && <span className="error">{task.error}</span>}
                    </div>
                    {task.video_url && (
                      <div className="preview">
                        <video controls src={task.video_url} />
                      </div>
                    )}
                    <div className="history-actions">
                      <a
                        className={`secondary ${task.video_url ? "" : "disabled"}`}
                        href={task.video_url || "#"}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => {
                          if (!task.video_url) {
                            event.preventDefault();
                          }
                        }}
                        download
                      >
                        Download
                      </a>
                      <button
                        className="secondary"
                        type="button"
                        onClick={() => handleCopy(task.video_url)}
                        disabled={!task.video_url}
                      >
                        Copy local link
                      </button>
                      <button
                        className="secondary"
                        type="button"
                        onClick={() => handleCopy(task.origin_video_url)}
                        disabled={!task.origin_video_url}
                      >
                        Copy origin link
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
