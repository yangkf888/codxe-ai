import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

const initialForm = {
  mode: "t2v",
  prompt: "",
  image_url: "",
  duration: "10",
  aspect_ratio: "9:16"
};

const statusLabels = {
  queued: "排队中",
  running: "生成中",
  success: "已完成",
  fail: "失败",
  succeeded: "已完成",
  failed: "失败"
};

const terminalStatuses = new Set(["success", "fail", "succeeded", "failed"]);

const durations = [
  { value: "10", label: "10 秒" },
  { value: "15", label: "15 秒" }
];

const aspectRatios = [
  { value: "9:16", label: "竖屏 (9:16)" },
  { value: "16:9", label: "横屏 (16:9)" }
];

const formatProgress = (value) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return null;
  }
  const numeric = Number(value);
  const normalized = numeric <= 1 ? numeric * 100 : numeric;
  return Math.min(Math.max(Math.round(normalized), 0), 100);
};

const formatPrompt = (prompt) => prompt || "(无提示词)";

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
  const [simulatedProgress, setSimulatedProgress] = useState(0);
  const [batchMode, setBatchMode] = useState(false);
  const [batchCount, setBatchCount] = useState(1);
  const [batchResult, setBatchResult] = useState(null);
  const [token, setToken] = useState("");
  const [history, setHistory] = useState([]);
  const [currentTask, setCurrentTask] = useState(null);
  const [activeTab, setActiveTab] = useState("generate");
  const [previewVideo, setPreviewVideo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState("");
  const [copiedPromptId, setCopiedPromptId] = useState(null);
  const [copiedPreviewPrompt, setCopiedPreviewPrompt] = useState(false);
  const [uploadState, setUploadState] = useState({
    status: "idle",
    message: "",
    fileName: ""
  });
  const imageUploadRef = useRef(null);
  const copiedPromptTimeoutRef = useRef(null);
  const copiedPreviewTimeoutRef = useRef(null);

  const shouldPoll = useMemo(
    () => history.some((task) => !terminalStatuses.has(task.status)),
    [history]
  );

  const fetchHistory = useCallback(
    async (silent = false) => {
      if (!token) {
        if (!silent) {
          setHistoryLoading(false);
        }
        return;
      }
      if (!silent) {
        setHistoryLoading(true);
      }
      try {
        const response = await fetch("/api/video/list?limit=50", {
          headers: { "X-APP-TOKEN": token }
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "加载历史记录失败");
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
    const isActiveStatus = currentTask?.status === "running" || currentTask?.status === "queued";
    if (!isActiveStatus || simulatedProgress >= 95) {
      return undefined;
    }

    const interval = setInterval(() => {
      setSimulatedProgress((prev) => {
        if (prev >= 95) {
          return prev;
        }
        const increment = 1 + Math.random();
        return Math.min(prev + increment, 95);
      });
    }, 500);

    return () => clearInterval(interval);
  }, [currentTask?.status, simulatedProgress]);

  useEffect(() => {
    if (!currentTask) {
      return;
    }
    const latestTask = history.find(
      (task) => task.localTaskId === currentTask.localTaskId
    );
    if (latestTask) {
      setCurrentTask(latestTask);
    }
  }, [currentTask, history]);

  useEffect(() => {
    return () => {
      if (copiedPromptTimeoutRef.current) {
        clearTimeout(copiedPromptTimeoutRef.current);
      }
      if (copiedPreviewTimeoutRef.current) {
        clearTimeout(copiedPreviewTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!shouldPoll) {
      return undefined;
    }

    const interval = setInterval(() => {
      fetchHistory(true);
    }, 5000);

    return () => clearInterval(interval);
  }, [fetchHistory, shouldPoll]);

  const pollTaskStatus = useCallback(
    async (taskId) => {
      if (!taskId) {
        return;
      }

      try {
        const response = await fetch(
          `/api/video/status?task_id=${encodeURIComponent(taskId)}`,
          {
            headers: token ? { "X-APP-TOKEN": token } : {}
          }
        );
        if (!response.ok) {
          return;
        }
        const data = await response.json();
        setHistory((prev) =>
          prev.map((task) =>
            task.localTaskId === taskId
              ? {
                  ...task,
                  status: data.status ?? task.status,
                  progress: data.progress ?? task.progress,
                  video_url: data.video_url ?? task.video_url,
                  error: data.error ?? task.error
                }
              : task
          )
        );
        setCurrentTask((prev) =>
          prev && prev.localTaskId === taskId
            ? {
                ...prev,
                status: data.status ?? prev.status,
                progress: data.progress ?? prev.progress,
                video_url: data.video_url ?? prev.video_url,
                error: data.error ?? prev.error
              }
            : prev
        );
        if (data.status === "succeeded") {
          setSimulatedProgress(100);
        }
      } catch (err) {
        return;
      }
    },
    [token]
  );

  useEffect(() => {
    if (!currentTask || terminalStatuses.has(currentTask.status)) {
      return;
    }

    pollTaskStatus(currentTask.localTaskId);
    const interval = setInterval(() => {
      pollTaskStatus(currentTask.localTaskId);
    }, 5000);

    return () => clearInterval(interval);
  }, [currentTask, pollTaskStatus]);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
    if (name === "image_url") {
      setUploadState({ status: "idle", message: "", fileName: "" });
    }
  };

  const handleCopy = async (value, onSuccess) => {
    if (!value) {
      return false;
    }
    try {
      await navigator.clipboard.writeText(value);
      onSuccess?.();
      return true;
    } catch (err) {
      setError(err.message || "复制失败");
      return false;
    }
  };

  const handleCopyPrompt = async (task) => {
    if (!task?.prompt) {
      return;
    }
    await handleCopy(task.prompt, () => {
      setCopiedPromptId(task.localTaskId);
      if (copiedPromptTimeoutRef.current) {
        clearTimeout(copiedPromptTimeoutRef.current);
      }
      copiedPromptTimeoutRef.current = setTimeout(() => {
        setCopiedPromptId(null);
      }, 2000);
    });
  };

  const handleCopyPreviewPrompt = async (prompt) => {
    if (!prompt) {
      return;
    }
    await handleCopy(prompt, () => {
      setCopiedPreviewPrompt(true);
      if (copiedPreviewTimeoutRef.current) {
        clearTimeout(copiedPreviewTimeoutRef.current);
      }
      copiedPreviewTimeoutRef.current = setTimeout(() => {
        setCopiedPreviewPrompt(false);
      }, 2000);
    });
  };

  const handleDeleteTask = async (taskId) => {
    if (!taskId || !token) {
      return;
    }
    if (!window.confirm("确定要删除这条记录吗？")) {
      return;
    }
    setError("");
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: "DELETE",
        headers: { "X-APP-TOKEN": token }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "删除失败");
      }
      await fetchHistory();
    } catch (err) {
      setError(err.message || "删除失败");
    }
  };

  const handleDownload = (url) => {
    if (!url) {
      return;
    }
    const link = document.createElement("a");
    link.href = url;
    link.download = "";
    link.rel = "noreferrer";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      setUploadState({ status: "idle", message: "", fileName: "" });
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    setUploadState({ status: "uploading", message: "上传中...", fileName: file.name });
    setError("");

    try {
      const response = await fetch("/api/upload", {
        method: "POST",
        headers: token ? { "X-APP-TOKEN": token } : {},
        body: formData
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "上传图片失败");
      }
      const data = await response.json();
      const fileUrl = data?.fileUrl || data?.data?.fileUrl || data?.url;
      if (fileUrl) {
        setForm((prev) => ({ ...prev, image_url: fileUrl }));
        setUploadState({ status: "success", message: "上传完成", fileName: file.name });
        setError("");
      } else {
        setUploadState({ status: "error", message: "上传失败", fileName: file.name });
      }
    } catch (err) {
      setError(err.message || "上传图片失败");
      setUploadState({ status: "error", message: "上传失败", fileName: file.name });
    } finally {
      event.target.value = "";
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setBatchResult(null);
    setSimulatedProgress(0);

    if (!form.prompt.trim()) {
      setError("请输入提示词。");
      return;
    }

    if (form.mode === "i2v" && !form.image_url.trim()) {
      setError("图生视频模式需要上传图片。");
      return;
    }

    setLoading(true);

    try {
      if (batchMode) {
        const jobs = Array.from({ length: batchCount }, () => ({
          mode: form.mode,
          prompt: form.prompt.trim(),
          image_url: form.mode === "i2v" ? form.image_url : undefined,
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
            batchCount,
            jobs
          })
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "批量任务创建失败");
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
          setCurrentTask(newTasks[0]);
        }

        setBatchResult({
          total: jobs.length,
          successCount: successes.length,
          failureCount: failures.length,
          failures: failures.map((failure) => ({
            index: failure.index,
            error: failure.error || "任务提交失败"
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
          throw new Error(data.error || "任务创建失败");
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
        setCurrentTask(newTask);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const latestVideo = useMemo(
    () => history.find((task) => task.video_url || task.origin_video_url),
    [history]
  );
  const previewUrl = latestVideo?.video_url || latestVideo?.origin_video_url;
  const previewPrompt = latestVideo?.prompt;

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="logo-block">
          <div className="logo">YKF-AI</div>
          <p className="logo-subtitle">AI 视频生成平台</p>
        </div>
        <div className="token-card">
          <label htmlFor="token">访问令牌</label>
          <input
            id="token"
            type="password"
            placeholder="请输入 APP_TOKEN"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <small>仅保存在当前页面，用于访问后端接口。</small>
        </div>
        <nav className="nav">
          <button
            type="button"
            className={`nav-item ${activeTab === "generate" ? "is-active" : ""}`}
            onClick={() => setActiveTab("generate")}
          >
            视频生成
          </button>
          <button
            type="button"
            className={`nav-item ${activeTab === "history" ? "is-active" : ""}`}
            onClick={() => setActiveTab("history")}
          >
            历史记录
          </button>
        </nav>
      </aside>

      <div className="main-content-wrapper">
        <header className="app-header">YKF-AI 视频生成平台</header>
        <main className="main-content">
          {activeTab === "generate" ? (
            <section className="generate-view">
              <div className="generate-left">
                <form className="form form-section" onSubmit={handleSubmit}>
                  <div className="field">
                    <label htmlFor="mode">生成模式</label>
                    <select id="mode" name="mode" value={form.mode} onChange={handleChange}>
                      <option value="t2v">文生视频</option>
                      <option value="i2v">图生视频</option>
                    </select>
                  </div>

                  <div className="field">
                    <label htmlFor="prompt">提示词</label>
                    <textarea
                      id="prompt"
                      name="prompt"
                      rows="4"
                      placeholder="描述你想生成的视频内容，例如：可爱的小狗在海边奔跑"
                      value={form.prompt}
                      onChange={handleChange}
                    />
                  </div>

                {form.mode === "i2v" && (
                  <div className="field">
                    <label htmlFor="image_upload">参考图上传</label>
                    <div className="upload">
                      <input
                        id="image_upload"
                        name="image_upload"
                        type="file"
                        accept="image/*"
                        onChange={handleUpload}
                        disabled={uploadState.status === "uploading"}
                        ref={imageUploadRef}
                        className="upload-input"
                      />
                      {form.image_url ? (
                        <div className="image-preview">
                          <img src={form.image_url} alt="上传预览" />
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => imageUploadRef.current?.click()}
                            disabled={uploadState.status === "uploading"}
                          >
                            更换图片
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="upload-dropzone"
                          onClick={() => imageUploadRef.current?.click()}
                          disabled={uploadState.status === "uploading"}
                        >
                          点击上传图片
                        </button>
                      )}
                    </div>
                  </div>
                )}

                  <div className="grid">
                    <div className="field">
                      <label>视频时长</label>
                      <div className="segmented-control" role="group" aria-label="视频时长">
                        {durations.map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            className={`segment ${
                              form.duration === option.value ? "is-active" : ""
                            }`}
                            onClick={() =>
                              setForm((prev) => ({ ...prev, duration: option.value }))
                            }
                            aria-pressed={form.duration === option.value}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="field">
                      <label>画面比例</label>
                      <div className="segmented-control" role="group" aria-label="画面比例">
                        {aspectRatios.map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            className={`segment ${
                              form.aspect_ratio === option.value ? "is-active" : ""
                            }`}
                            onClick={() =>
                              setForm((prev) => ({ ...prev, aspect_ratio: option.value }))
                            }
                            aria-pressed={form.aspect_ratio === option.value}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="batch-toggle">
                    <div>
                      <span className="toggle-title">批量模式</span>
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

                  {batchMode && (
                    <div className="field">
                      <label htmlFor="batch_count">生成数量 (Batch Size)</label>
                      <input
                        id="batch_count"
                        name="batch_count"
                        type="range"
                        min="1"
                        max="20"
                        value={batchCount}
                        onChange={(event) => setBatchCount(Number(event.target.value))}
                      />
                      <small className="helper">当前数量: {batchCount}</small>
                    </div>
                  )}

                  {error && <p className="error">{error}</p>}

                  {batchResult && (
                    <div className="batch-result">
                      <p>
                        批量提交完成：成功 {batchResult.successCount} 条，失败{" "}
                        {batchResult.failureCount} 条。
                      </p>
                      {batchResult.failureCount > 0 && (
                        <ul>
                          {batchResult.failures.map((failure) => (
                            <li key={failure.index}>
                              任务 #{failure.index + 1}: {failure.error}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  <button className="primary" type="submit" disabled={loading}>
                    {loading
                      ? batchMode
                        ? "批量提交中..."
                        : "生成中..."
                      : batchMode
                        ? "提交批量任务"
                        : "立即生成"}
                  </button>
                </form>
            </div>
            <div className="generate-right">
              <div className="preview-section">
                <div className="preview-header">
                  <div>
                    <h2>视频预览</h2>
                    <p className="muted">展示最近生成的视频结果。</p>
                  </div>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => fetchHistory()}
                    disabled={historyLoading || !token}
                  >
                    {historyLoading ? "刷新中..." : "刷新"}
                  </button>
                </div>
                {latestVideo ? (
                  <video controls src={previewUrl} className="preview-player" />
                ) : (
                  <div className="preview-empty">
                    <p className="muted">暂无可预览的视频，生成完成后会出现在这里。</p>
                  </div>
                )}
                <div className="preview-actions">
                  <button
                    className="preview-action"
                    type="button"
                    onClick={() => handleDownload(previewUrl)}
                    disabled={!previewUrl}
                  >
                    下载视频
                  </button>
                  <button
                    className="preview-action"
                    type="button"
                    onClick={() => handleCopyPreviewPrompt(previewPrompt)}
                    disabled={!previewPrompt}
                  >
                    {copiedPreviewPrompt ? "✅ 已复制" : "复制提示词"}
                  </button>
                </div>
              </div>
            </div>
          </section>
        ) : (
          <section className="history-view">
            <div className="history-header">
              <div>
                <h2>历史记录</h2>
                <p className="muted">查看最近的生成记录与视频结果。</p>
              </div>
              <button
                className="ghost"
                type="button"
                onClick={() => fetchHistory()}
                disabled={historyLoading || !token}
              >
                {historyLoading ? "刷新中..." : "刷新"}
              </button>
            </div>

            {history.length === 0 ? (
              <p className="muted">暂无生成记录，先提交任务试试吧。</p>
            ) : (
              <div className="history-table">
                <div className="history-row history-row-head">
                  <div>缩略图</div>
                  <div>提示词</div>
                  <div>状态</div>
                  <div>操作</div>
                </div>
                {history.map((task) => {
                  const actualProgress = formatProgress(task.progress);
                  const simulatedValue =
                    task.localTaskId === currentTask?.localTaskId
                      ? Math.round(simulatedProgress)
                      : null;
                  const progress =
                    simulatedValue !== null
                      ? Math.max(actualProgress ?? 0, simulatedValue)
                      : actualProgress;
                  const taskPreviewUrl = task.origin_video_url || task.video_url;
                  return (
                    <div key={task.localTaskId} className="history-row">
                      <div className="history-thumb">
                        {taskPreviewUrl ? (
                          <video src={taskPreviewUrl} muted playsInline />
                        ) : (
                          <div className="history-thumb-empty">暂无预览</div>
                        )}
                      </div>
                      <div className="history-prompt">
                        <div className="task-id">{task.localTaskId}</div>
                        <p className="prompt">{formatPrompt(task.prompt)}</p>
                        <div className="task-meta-line">
                          <span>{formatTimestamp(task.createdAt)}</span>
                          <span className="chip">{task.mode}</span>
                          {progress !== null && <span>进度 {progress}%</span>}
                          {task.error && <span className="error">{task.error}</span>}
                        </div>
                      </div>
                      <div className={`status status-${task.status}`}>
                        {statusLabels[task.status] || task.status}
                      </div>
                      <div className="history-actions">
                        <button
                          className="secondary"
                          type="button"
                          onClick={() => setPreviewVideo(taskPreviewUrl)}
                          disabled={!taskPreviewUrl}
                        >
                          预览
                        </button>
                        <button
                          className="secondary"
                          type="button"
                          onClick={() => handleDownload(taskPreviewUrl)}
                          disabled={!taskPreviewUrl}
                        >
                          下载视频
                        </button>
                        <button
                          className="secondary"
                          type="button"
                          onClick={() => handleCopyPrompt(task)}
                          disabled={!task.prompt}
                        >
                          {copiedPromptId === task.localTaskId ? "✅ 已复制" : "复制提示词"}
                        </button>
                        <button
                          className="btn-delete"
                          type="button"
                          onClick={() => handleDeleteTask(task.localTaskId)}
                          disabled={!token}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}
        </main>
      </div>

      {previewVideo && (
        <div className="modal-overlay" onClick={() => setPreviewVideo(null)}>
          <div className="modal-content" onClick={(event) => event.stopPropagation()}>
            <video
              className="history-preview-video"
              controls
              autoPlay
              src={previewVideo}
            />
          </div>
        </div>
      )}
    </div>
  );
}
