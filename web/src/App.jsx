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
  const [token, setToken] = useState("");
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState("");

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

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");

    if (!form.prompt.trim()) {
      setError("Prompt is required.");
      return;
    }

    if (form.mode === "i2v" && !form.image_url.trim()) {
      setError("Image URL is required for Image-to-Video.");
      return;
    }

    setLoading(true);

    try {
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
            <div className="field">
              <label htmlFor="mode">Mode</label>
              <select id="mode" name="mode" value={form.mode} onChange={handleChange}>
                <option value="t2v">Text-to-Video</option>
                <option value="i2v">Image-to-Video</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="prompt">Prompt</label>
              <textarea
                id="prompt"
                name="prompt"
                rows="4"
                placeholder="Describe the video you want..."
                value={form.prompt}
                onChange={handleChange}
              />
            </div>
            {form.mode === "i2v" && (
              <div className="field">
                <label htmlFor="image_url">Image URL</label>
                <input
                  id="image_url"
                  name="image_url"
                  type="url"
                  placeholder="https://example.com/image.jpg"
                  value={form.image_url}
                  onChange={handleChange}
                />
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
            {error && <p className="error">{error}</p>}
            <button className="primary" type="submit" disabled={loading}>
              {loading ? "Creating..." : "Generate"}
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
