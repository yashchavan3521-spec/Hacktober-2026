import { useEffect, useRef, useState } from "react";

const API_URL = (
  import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? "http://127.0.0.1:8000" : "")
).replace(/\/+$/, "");
const modelOptions = [
  { id: "gemma3", label: "Gemma 3", description: "Multimodal chat" },
  { id: "qwen2.5", label: "Qwen 2.5", description: "Reasoning & tools" },
];

async function api(path, token, options = {}) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(apiEndpoint(path), { ...options, headers });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      message = body.detail || message;
    } catch {
      // Keep the status message when the server response is not JSON.
    }
    throw new Error(message);
  }
  return response;
}

function apiEndpoint(path) {
  if (!API_URL) {
    throw new Error("Set VITE_API_URL to your deployed FastAPI backend URL.");
  }
  return `${API_URL}${path}`;
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem("sova-token") || "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [model, setModel] = useState(modelOptions[0].id);
  const [mode, setMode] = useState("chat");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedMessage, setSelectedMessage] = useState(null);
  const fileInput = useRef(null);
  const endOfChat = useRef(null);

  useEffect(() => {
    if (!token) return;
    api("/documents", token)
      .then((response) => response.json())
      .then(setDocuments)
      .catch((cause) => {
        setError(cause.message);
        if (cause.message.includes("token")) signOut();
      });
  }, [token]);

  useEffect(() => {
    endOfChat.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  function signOut() {
    localStorage.removeItem("sova-token");
    setToken("");
    setMessages([]);
    setDocuments([]);
  }

  async function signIn(event) {
    event.preventDefault();
    setLoginError("");
    try {
      const response = await fetch(apiEndpoint("/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail || "Sign in failed");
      localStorage.setItem("sova-token", body.access_token);
      setToken(body.access_token);
      setPassword("");
    } catch (cause) {
      setLoginError(cause.message);
    }
  }

  async function uploadFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await api("/upload", token, { method: "POST", body: form });
      const uploaded = await response.json();
      setDocuments((current) => [uploaded, ...current]);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  }

  function updateMessage(id, update) {
    setMessages((current) =>
      current.map((message) => (message.id === id ? { ...message, ...update } : message)),
    );
  }

  async function sendMessage(event) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || busy) return;
    setPrompt("");
    setError("");
    setBusy(true);
    const userMessage = { id: crypto.randomUUID(), role: "user", content: text };
    const assistantId = crypto.randomUUID();
    setMessages((current) => [
      ...current,
      userMessage,
      { id: assistantId, role: "assistant", content: "", sources: [], steps: [], pending: true },
    ]);

    try {
      if (mode === "chat") {
        await streamChat(text, assistantId);
      } else {
        const path = mode === "ask" ? "/ask" : "/agent";
        const body = mode === "ask" ? { question: text, model } : { task: text, model };
        const response = await api(path, token, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const result = await response.json();
        const message = { ...result, pending: false };
        updateMessage(assistantId, message);
        setSelectedMessage(message);
      }
    } catch (cause) {
      setError(cause.message);
      updateMessage(assistantId, { content: "The request could not be completed.", pending: false });
    } finally {
      setBusy(false);
    }
  }

  function streamChat(text, assistantId) {
    return new Promise((resolve, reject) => {
      const socketUrl = apiEndpoint("/chat").replace(/^http/, "ws");
      const socket = new WebSocket(socketUrl);
      let settled = false;
      socket.onopen = () => {
        socket.send(JSON.stringify({ token }));
        socket.send(JSON.stringify({ message: text, model }));
      };
      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "token") {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? { ...message, content: message.content + data.content }
                : message,
            ),
          );
        } else if (data.type === "done") {
          updateMessage(assistantId, { pending: false });
          socket.close();
          settled = true;
          resolve();
        } else if (data.type === "error") {
          socket.close();
          settled = true;
          reject(new Error(data.message));
        }
      };
      socket.onerror = () => {
        if (!settled) reject(new Error("Could not connect to the local chat service"));
      };
      socket.onclose = (event) => {
        if (!settled) reject(new Error(event.reason || "Chat connection closed unexpectedly"));
      };
    });
  }

  async function downloadExport(format, message) {
    try {
      const response = await api(`/export/${format}`, token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answer: message.content || message.answer,
          sources: message.sources || [],
        }),
      });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `sova-answer.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause.message);
    }
  }

  if (!token) {
    return (
      <main className="login-page">
        <form className="login-card" onSubmit={signIn}>
          <Brand />
          <p className="eyebrow">PRIVATE BY DESIGN</p>
          <h1>Your local AI workspace.</h1>
          <p className="muted">Sign in to chat with your on-premise models and documents.</p>
          <label>
            Username
            <input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {loginError && <p className="error">{loginError}</p>}
          <button className="primary-button" type="submit">Sign in</button>
          <p className="login-footnote">Credentials are configured by your local administrator.</p>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="privacy-badge"><span className="status-dot" /> LOCAL · NO INTERNET</div>
        <div className="sidebar-heading">
          <span>KNOWLEDGE BASE</span>
          <span className="count">{documents.length}</span>
        </div>
        <button className="upload-button" onClick={() => fileInput.current?.click()} disabled={uploading}>
          <span className="plus">+</span>{uploading ? "Processing document…" : "Add a document"}
        </button>
        <input
          ref={fileInput}
          className="visually-hidden"
          type="file"
          accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp"
          onChange={uploadFile}
        />
        <div className="document-list">
          {documents.length === 0 && <p className="empty-docs">Your local library is empty. Add a file to ask questions with sources.</p>}
          {documents.map((document) => (
            <div className="document-item" key={document.id}>
              <span className="document-icon">▤</span>
              <span className="document-name" title={document.filename}>{document.filename}</span>
            </div>
          ))}
        </div>
        <div className="sidebar-bottom">
          <div className="local-note"><span className="lock-icon">⌑</span><span>Documents stay in your configured data folder.</span></div>
          <button className="text-button signout" onClick={signOut}>Sign out</button>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <div className="eyebrow">SOVEREIGN AI WORKSPACE</div>
            <h1>What are we working on?</h1>
          </div>
          <label className="model-select">
            <span>MODEL</span>
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              {modelOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
        </header>

        <section className="workspace">
          {messages.length === 0 ? (
            <div className="welcome">
              <div className="welcome-mark">S</div>
              <p className="eyebrow">YOUR PRIVATE ASSISTANT</p>
              <h2>Knowledge stays<br />where it belongs.</h2>
              <p className="muted">Chat with a local model, or ask questions grounded in your documents.</p>
              <div className="suggestion-row">
                <button onClick={() => { setMode("ask"); setPrompt("What are the key points in my documents?"); }}>⌕ <span>Ask your documents</span></button>
                <button onClick={() => { setMode("agent"); setPrompt("Summarize the most important information in my documents."); }}>✳ <span>Summarize with an agent</span></button>
              </div>
            </div>
          ) : (
            <div className="conversation">
              {messages.map((message) => (
                <article className={`message ${message.role}`} key={message.id}>
                  <div className="avatar">{message.role === "user" ? "YOU" : "S"}</div>
                  <div className="message-body">
                    <div className="message-label">{message.role === "user" ? "You" : "SOVA"}{message.pending && <span className="typing"> · thinking</span>}</div>
                    <p className="message-text">{message.content || (message.pending ? " " : "")}</p>
                    {message.sources?.length > 0 && (
                      <button className="source-pill" onClick={() => setSelectedMessage(message)}>
                        ◈ {message.sources.length} source{message.sources.length === 1 ? "" : "s"}
                      </button>
                    )}
                    {message.steps?.length > 0 && (
                      <button className="source-pill" onClick={() => setSelectedMessage(message)}>
                        ✳ {message.steps.length} agent steps
                      </button>
                    )}
                    {!message.pending && message.role === "assistant" && message.content && (
                      <div className="export-actions">
                        <button onClick={() => downloadExport("docx", message)}>Export DOCX</button>
                        <button onClick={() => downloadExport("xlsx", message)}>Export XLSX</button>
                      </div>
                    )}
                  </div>
                </article>
              ))}
              <div ref={endOfChat} />
            </div>
          )}
          {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError("")}>Dismiss</button></div>}
        </section>

        <footer className="composer-wrap">
          <div className="mode-tabs" role="tablist" aria-label="Assistant mode">
            {[["chat", "Chat"], ["ask", "Ask documents"], ["agent", "Agent"]].map(([id, label]) => (
              <button key={id} className={mode === id ? "active" : ""} onClick={() => setMode(id)}>{label}</button>
            ))}
          </div>
          <form className="composer" onSubmit={sendMessage}>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form.requestSubmit();
                }
              }}
              placeholder={mode === "chat" ? "Message your local assistant…" : mode === "ask" ? "Ask a question about your files…" : "Describe a task for your agent…"}
              rows="2"
            />
            <button type="submit" className="send-button" disabled={busy || !prompt.trim()} aria-label="Send message">↑</button>
          </form>
          <div className="composer-caption">Local models can make mistakes. Verify important information.</div>
        </footer>
      </main>

      <aside className="details-panel">
        <div className="details-heading"><span>RESPONSE DETAILS</span><span className="spark">✳</span></div>
        {!selectedMessage ? (
          <div className="details-empty"><span>◈</span><p>Sources and agent activity will appear here when available.</p></div>
        ) : (
          <>
            <section className="detail-section">
              <h3>Sources <span>{selectedMessage.sources?.length || 0}</span></h3>
              {(selectedMessage.sources || []).length === 0
                ? <p className="detail-empty-copy">No document sources for this response.</p>
                : selectedMessage.sources.map((source, index) => (
                  <div className="source-card" key={`${source.document_id || source.filename}-${index}`}>
                    <div className="source-card-title"><span>{String(index + 1).padStart(2, "0")}</span>{source.filename}</div>
                    {source.excerpt && <p>{source.excerpt}</p>}
                    {source.chunk_index !== undefined && <small>Passage {source.chunk_index + 1}</small>}
                  </div>
                ))}
            </section>
            <section className="detail-section">
              <h3>Agent activity <span>{selectedMessage.steps?.length || 0}</span></h3>
              {(selectedMessage.steps || []).length === 0
                ? <p className="detail-empty-copy">No tools used for this response.</p>
                : selectedMessage.steps.map((step, index) => (
                  <div className="step-card" key={`${step.tool}-${index}`}>
                    <span className="step-check">✓</span>
                    <div><strong>{step.tool.replaceAll("_", " ")}</strong><p>{step.detail}</p></div>
                  </div>
                ))}
            </section>
          </>
        )}
        <div className="details-footer">PROCESSING ON CONFIGURED OLLAMA INSTANCE</div>
      </aside>
    </div>
  );
}

function Brand() {
  return <div className="brand"><span className="brand-mark">S</span><span>SOVA<small>LOCAL AI</small></span></div>;
}

export default App;
