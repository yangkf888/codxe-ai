import React, { useEffect, useMemo, useState } from "react";

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
  succeeded: "Succeeded",
  failed: "Failed"
};

export default function App() {
  const [form, setForm] = useState(initialForm);
  const [token, setToken] = useState("");
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const activeTaskIds = useMemo(
    () => tasks.filter((task) => !["succeeded", "failed"].includes(task.status)).map((task) => task.task_id),
    [tasks]
  );

  useEffect(() => {
    if (activeTaskIds.length === 0) {
      return undefined;
    }

    const interval = setInterval(() => {
      activeTaskIds.forEach((taskId) => {
        fetch(`/api/video/status?task_id=${taskId}` , {
          headers: token ? { "X-APP-TOKEN": token } : {}
        })
          .then((res) => res.json())
          .then((data) => {
            setTasks((prev) =>
              prev.map((task) =>
                task.task_id === taskId
                  ? {
                      ...task,
                      status: data.status || task.status,
                      progress: data.progress ?? task.progress,
                      video_url: data.video_url || task.video_url,
                      error: data.error || task.error
                    }
                  : task
              )
            );
          })
          .catch(() => null);
      });
    }, 2000);

    return () => clearInterval(interval);
  }, [activeTaskIds, token]);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
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
      setTasks((prev) => [
        {
          task_id: data.task_id,
          status: "queued",
          progress: 0,
          video_url: "",
          error: ""
        },
        ...prev
      ]);
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

        <section className="card">
          <h2>Tasks</h2>
          {tasks.length === 0 ? (
            <p className="muted">No tasks yet. Submit a prompt to get started.</p>
          ) : (
            <ul className="task-list">
              {tasks.map((task) => (
                <li key={task.task_id} className="task-item">
                  <div>
                    <div className="task-id">{task.task_id}</div>
                    <div className={`status status-${task.status}`}>{statusLabels[task.status] || task.status}</div>
                  </div>
                  <div className="task-meta">
                    {task.progress !== undefined && (
                      <span>Progress: {Math.round((task.progress || 0) * 100)}%</span>
                    )}
                    {task.video_url && (
                      <a href={task.video_url} target="_blank" rel="noreferrer">
                        View video
                      </a>
                    )}
                    {task.error && <span className="error">{task.error}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
