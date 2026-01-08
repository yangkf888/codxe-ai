import React, { useState } from "react";

export default function Login({ onLogin }) {
  const [form, setForm] = useState({ username: "", password: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!form.username || !form.password) {
      setError("请输入管理员账号和密码。");
      return;
    }
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: form.username,
          password: form.password
        })
      });
      if (!response.ok) {
        throw new Error("账号或密码错误。");
      }
      const data = await response.json();
      if (!data?.token) {
        throw new Error("登录失败，缺少访问令牌。");
      }
      localStorage.setItem("app_token", data.token);
      onLogin?.(data.token);
    } catch (err) {
      setError(err.message || "登录失败，请重试。");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-header">
          <p className="eyebrow">YKF-AI</p>
          <h1>管理员登录</h1>
          <p className="muted">请输入管理员账号密码以进入平台。</p>
        </div>
        <form className="login-form" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="username">管理员账号</label>
            <input
              id="username"
              name="username"
              placeholder="admin"
              value={form.username}
              onChange={handleChange}
              autoComplete="username"
            />
          </div>
          <div className="field">
            <label htmlFor="password">管理员密码</label>
            <input
              id="password"
              name="password"
              type="password"
              placeholder="请输入密码"
              value={form.password}
              onChange={handleChange}
              autoComplete="current-password"
            />
          </div>
          {error && <p className="error">{error}</p>}
          <button className="primary" type="submit" disabled={loading}>
            {loading ? "登录中..." : "登录"}
          </button>
        </form>
        <p className="login-help muted">首次部署默认账号：admin / 123456</p>
      </div>
    </div>
  );
}
