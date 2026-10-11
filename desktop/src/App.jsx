import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { diffLines, applyHunks, parseFileToolEvent } from "./diff.js";
import ModelPicker from "./ModelPicker.jsx";

// --- Model catalog ---------------------------------------------------------
// Loaded once from the Rust bridge (which shells to src/models.js, the same
// registry the CLI uses). Falls back to a static hint list when the bridge
// is unreachable (e.g. `vite dev` without Tauri), so the UI never bricks.

const FALLBACK_MODELS = [
  { id: "ox-grok", provider: "xai", model: "grok-4.6", desc: "xAI Grok flagship", requires_key: "XAI_API_KEY", hasKey: false, available: false, pricing: { in: 2, out: 6 } },
  { id: "ox-claude", provider: "anthropic", model: "claude-sonnet-5", desc: "Anthropic Sonnet", requires_key: "ANTHROPIC_API_KEY", hasKey: false, available: false, pricing: { in: 2, out: 10 } },
  { id: "ox-gpt", provider: "openai", model: "gpt-5.6-sol", desc: "OpenAI GPT-5.6 Sol", requires_key: "OPENAI_API_KEY", hasKey: false, available: false, pricing: { in: 4, out: 20 } },
  { id: "ox-gemini", provider: "gemini", model: "gemini-3.1-pro-preview", desc: "Google Gemini Pro", requires_key: "GEMINI_API_KEY", hasKey: false, available: false, pricing: { in: 2, out: 12 } },
  { id: "ox-ollama", provider: "ollama", model: "qwen2.5:0.5b", desc: "local Ollama (no key needed)", requires_key: null, hasKey: true, available: true, keyless: true, pricing: null },
];

function priceLabel(m) {
  if (!m.pricing) return "free · local";
  return `$${m.pricing.in}/$${m.pricing.out} per Mtok`;
}

function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState([]);
  const [plans, setPlans] = useState([]);
  const [history, setHistory] = useState([]);
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(false);
  const [openFile, setOpenFile] = useState(null);
  const [fileContent, setFileContent] = useState("");
  const [fileModified, setFileModified] = useState(false);
  const [pendingDiff, setPendingDiff] = useState(null);
  // Model picker state
  const [models, setModels] = useState(FALLBACK_MODELS);
  const [providers, setProviders] = useState([]);
  const [withheld, setWithheld] = useState([]);
  const [selectedModel, setSelectedModel] = useState(null);
  const [sessionKeys, setSessionKeys] = useState({}); // {ENV_NAME: value} for this session only
  const [showModels, setShowModels] = useState(false);
  const [keyDrafts, setKeyDrafts] = useState({}); // per-provider input buffer
  // Local scan state
  const [local, setLocal] = useState(null);
  const [scanning, setScanning] = useState(false);
  // Sidebar / status
  const [leftTab, setLeftTab] = useState("files"); // files | plan | history
  const [status, setStatus] = useState("idle");
  const [stats, setStats] = useState({ turns: 0, tools: 0, filesTouched: [] });
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    loadFiles();
    loadModels();
    loadDefaultBot();
  }, []);

  useEffect(() => {
    if (!loading) inputRef.current?.focus();
  }, [loading]);

  const activeModel = useMemo(
    () => models.find((m) => m.id === selectedModel) ?? models.find((m) => m.available) ?? models[0] ?? null,
    [models, selectedModel]
  );

  const readyToChat = useMemo(() => {
    if (!activeModel) return false;
    if (activeModel.available) return true;
    // A session key pasted in the picker unlocks the model for this session.
    return Boolean(activeModel.requires_key && sessionKeys[activeModel.requires_key]);
  }, [activeModel, sessionKeys]);

  async function loadModels() {
    try {
      const raw = await invoke("ox_models");
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(data.models) && data.models.length) {
        setModels(data.models);
        setProviders(Array.isArray(data.providers) ? data.providers : []);
        setWithheld(Array.isArray(data.withheld) ? data.withheld : []);
      }
    } catch (e) {
      console.warn("ox_models bridge unavailable, using fallback list:", e);
    }
  }

  async function loadDefaultBot() {
    try {
      const raw = await invoke("ox_default_bot");
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (data?.defaultBot) setSelectedModel(data.defaultBot);
    } catch {
      // bridge unavailable (vite dev) — leave auto-select to activeModel memo
    }
  }

  async function handleScanLocal() {
    setScanning(true);
    try {
      const raw = await invoke("ox_local_scan");
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      setLocal(data);
    } catch (e) {
      setMessages((prev) => [...prev, { role: "error", content: `Local scan failed: ${e}` }]);
    } finally {
      setScanning(false);
    }
  }

  function handleSaveKey(provider, keyEnv) {
    const v = (keyDrafts[provider] ?? "").trim();
    if (!v) return;
    setSessionKeys((prev) => ({ ...prev, [keyEnv]: v }));
    setKeyDrafts((prev) => ({ ...prev, [provider]: "" }));
    // Refresh availability optimistically — the bridge reads process env,
    // which the desktop cannot mutate, so we mark locally instead.
    setModels((prev) => prev.map((m) => (m.requires_key === keyEnv ? { ...m, hasKey: true, available: true } : m)));
    setMessages((prev) => [...prev, { role: "system", content: `API key set for ${provider} (this session only — never written to disk).` }]);
  }

  function handleClearKey(keyEnv) {
    setSessionKeys((prev) => {
      const next = { ...prev };
      delete next[keyEnv];
      return next;
    });
    setModels((prev) =>
      prev.map((m) => (m.requires_key === keyEnv ? { ...m, hasKey: false, available: m.keyless === true } : m))
    );
  }

  async function loadFiles() {
    try {
      const result = await invoke("ox_list_files", { path: "." });
      setFiles(result);
    } catch (e) {
      console.error("Failed to load files:", e);
    }
  }

  async function loadPlans() {
    try {
      const result = await invoke("ox_load_plan", { id: "current" });
      setPlans(result ? [result] : []);
    } catch (e) {
      console.error("Failed to load plan:", e);
    }
  }

  async function loadHistory() {
    try {
      const result = await invoke("ox_get_procedural");
      setHistory(result ? [result] : []);
    } catch (e) {
      console.error("Failed to load history:", e);
    }
  }

  async function handleFileClick(filePath) {
    try {
      const content = await invoke("ox_read_file", { path: filePath });
      setOpenFile(filePath);
      setFileContent(content);
      setFileModified(false);
    } catch (e) {
      setMessages((prev) => [...prev, { role: "error", content: `Failed to open ${filePath}: ${e}` }]);
    }
  }

  async function handleSaveFile() {
    if (!openFile) return;
    try {
      await invoke("ox_write_file", { path: openFile, content: fileContent });
      setFileModified(false);
      setMessages((prev) => [...prev, { role: "system", content: `Saved ${openFile}` }]);
    } catch (e) {
      setMessages((prev) => [...prev, { role: "error", content: `Failed to save ${openFile}: ${e}` }]);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!input.trim() || loading) return;
    if (!readyToChat) {
      setShowModels(true);
      setMessages((prev) => [...prev, { role: "system", content: "Pick a model first — open the model picker above and connect a key or local endpoint." }]);
      return;
    }

    const prompt = input.trim();
    setInput("");
    setLoading(true);
    setStatus("thinking");

    setMessages((prev) => [...prev, { role: "user", content: prompt }]);

    let assistantText = "";
    let sawAssistant = false;

    try {
      // Pass the selected bot id as --target plus any session keys, so the
      // run uses exactly the model the picker shows. Keys travel in the
      // spawned process env only (see ox-acp-driver --set-env).
      const extraEnv = {};
      if (activeModel?.requires_key && sessionKeys[activeModel.requires_key]) {
        extraEnv[activeModel.requires_key] = sessionKeys[activeModel.requires_key];
        if (activeModel.provider === "ollama" || activeModel.keyless) {
          // keyless local models need nothing extra
        }
      }
      const ndjson = await invoke("ox_run", {
        prompt,
        target: activeModel ? activeModel.id : null,
        extraEnvJson: Object.keys(extraEnv).length ? JSON.stringify(extraEnv) : null,
      });
      const lines = ndjson.split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          // The ACP driver wraps agent events as {type:'event',data:ev} plus
          // a terminal {type:'final',events:[...]}. Unwrap both shapes here
          // so the UI works whether Tauri or a raw driver feeds it.
          const inner = event.type === "event" ? event.data ?? event : event;
          const kind = inner.type ?? event.type;
          switch (kind) {
            case "text-delta":
            case "text":
              assistantText += inner.text ?? inner.delta ?? "";
              sawAssistant = true;
              setStatus("streaming");
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.role === "assistant" && last.streaming) {
                  return [...prev.slice(0, -1), { role: "assistant", content: assistantText, streaming: true }];
                }
                return [...prev, { role: "assistant", content: assistantText, streaming: true }];
              });
              break;
            case "tool-start":
            case "tool_call":
            case "tool":
              setStatus("tool");
              setStats((s) => ({ ...s, tools: s.tools + 1 }));
              setTools((prev) => [
                ...prev,
                {
                  id: inner.id ?? `t-${prev.length}`,
                  name: inner.name ?? inner.tool ?? "tool",
                  args: safeParseArgs(inner.argsPreview ?? inner.args),
                  status: "running",
                },
              ]);
              break;
            case "tool-end":
            case "tool_result":
              setTools((prev) =>
                prev.map((t) =>
                  t.id === event.id
                    ? {
                        ...t,
                        status: event.isError ? "error" : "ok",
                        ms: event.ms,
                        bytes: event.bytes,
                      }
                    : t
                )
              );
              // Check for file tool diff
              const fileTool = parseFileToolEvent(event);
              if (fileTool) {
                const oldContent = fileTool.oldContent || "";
                const newContent = fileTool.newContent || "";
                const hunks = diffLines(oldContent, newContent);
                setPendingDiff({
                  path: fileTool.path,
                  hunks,
                  oldContent,
                  newContent,
                  accepted: new Set(hunks.map((_, i) => i)), // default all accepted
                });
              }
              break;
            case "final":
            case "result":
            case "assistant": {
              const events = event.events ?? inner.events ?? [];
              // Pull any trailing assistant text out of the batched events so
              // a non-streaming driver still renders an answer.
              if (!sawAssistant && events.length) {
                const tail = events
                  .map((e) => e?.text ?? e?.delta ?? e?.message?.content ?? "")
                  .filter(Boolean)
                  .join("");
                if (tail) assistantText = tail;
              }
              const touched = [];
              for (const e of events) {
                const p = e?.data?.args?.path ?? e?.args?.path;
                if (typeof p === "string" && p) touched.push(p);
              }
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                const finalMsg = { role: "assistant", content: assistantText || "(no text output)" };
                if (last && last.role === "assistant" && last.streaming) {
                  return [...prev.slice(0, -1), finalMsg];
                }
                // Avoid a duplicate when streaming already produced the text,
                // but never swallow an empty run silently.
                if (last && last.role === "assistant" && !last.streaming && assistantText) return prev;
                return [...prev, finalMsg];
              });
              setStats((s) => ({
                turns: s.turns + 1,
                tools: s.tools,
                filesTouched: [...new Set([...s.filesTouched, ...touched])].slice(0, 20),
              }));
              break;
            }
            case "error":
              setMessages((prev) => [...prev, { role: "error", content: String(inner.error ?? inner.message ?? "unknown error") }]);
              break;
            default:
              break;
          }
        } catch {
          // skip non-JSON lines
        }
      }
    } catch (err) {
      setMessages((prev) => [...prev, { role: "error", content: String(err) }]);
    } finally {
      setLoading(false);
      setStatus("idle");
    }
  }

  function safeParseArgs(argsPreview) {
    if (!argsPreview) return {};
    try {
      const parsed = JSON.parse(argsPreview);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  function handleDiffAccept() {
    if (!pendingDiff) return;
    const { path, hunks, accepted, newContent } = pendingDiff;
    // If all hunks accepted, just write newContent
    const finalContent = accepted.size === hunks.length
      ? newContent
      : applyHunks(pendingDiff.oldContent, hunks, accepted);
    invoke("ox_write_file", { path, content: finalContent })
      .then(() => {
        setMessages((prev) => [...prev, { role: "system", content: `Applied changes to ${path}` }]);
        if (openFile === path) {
          setFileContent(finalContent);
          setFileModified(false);
        }
        setPendingDiff(null);
      })
      .catch((e) => {
        setMessages((prev) => [...prev, { role: "error", content: `Failed to apply: ${e}` }]);
      });
  }

  function handleDiffReject() {
    setPendingDiff(null);
    setMessages((prev) => [...prev, { role: "system", content: "Changes rejected" }]);
  }

  function toggleHunkAccept(hunkIdx) {
    setPendingDiff((prev) => {
      if (!prev) return null;
      const newAccepted = new Set(prev.accepted);
      if (newAccepted.has(hunkIdx)) {
        newAccepted.delete(hunkIdx);
      } else {
        newAccepted.add(hunkIdx);
      }
      return { ...prev, accepted: newAccepted };
    });
  }

  const closePicker = useCallback(() => setShowModels(false), []);

  return (
    <div className="app">
      <aside className="left-panel">
        <div className="brand">
          <span className="brand-mark">◈</span>
          <span className="brand-name">ox</span>
          <span className="brand-sub">coding agent</span>
        </div>
        <div className="tabs">
          {["files", "plan", "history"].map((t) => (
            <button key={t} className={`tab ${leftTab === t ? "active" : ""}`} onClick={() => { setLeftTab(t); if (t === "plan") loadPlans(); if (t === "history") loadHistory(); }}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        {leftTab === "files" && (
          <div className="panel-section grow">
            <h3>Files</h3>
            <div className="file-tree">
              {files.length === 0 && <span className="empty">No files — open a project folder</span>}
              {files.map((f, i) => (
                <div key={i} className={`file-item ${openFile === f ? "active" : ""}`} onClick={() => handleFileClick(f)} title={f}>
                  {f}
                </div>
              ))}
            </div>
          </div>
        )}
        {leftTab === "plan" && (
          <div className="panel-section grow">
            <h3>Plan</h3>
            <div className="plan-view">
              {plans.length === 0 && <span className="empty">No active plan — ask ox to plan first</span>}
              {plans.map((p, i) => (
                <pre key={i} className="plan-content">{p}</pre>
              ))}
            </div>
          </div>
        )}
        {leftTab === "history" && (
          <div className="panel-section grow">
            <h3>History</h3>
            <div className="history-view">
              {history.length === 0 && <span className="empty">No procedural memory yet</span>}
              {history.map((h, i) => (
                <pre key={i} className="history-content">{h}</pre>
              ))}
            </div>
          </div>
        )}
        <div className="panel-section session-stats">
          <h3>Session</h3>
          <div className="stat-row"><span>Turns</span><strong>{stats.turns}</strong></div>
          <div className="stat-row"><span>Tools</span><strong>{stats.tools}</strong></div>
          <div className="stat-row"><span>Files touched</span><strong>{stats.filesTouched.length}</strong></div>
        </div>
      </aside>

      <main className="chat-panel">
        <div className="chat-header">
          <button className="model-pill" onClick={() => setShowModels(true)} title="Choose model / connect keys">
            <span className={`dot ${readyToChat ? "ok" : "warn"}`} />
            <span className="model-name">{activeModel ? activeModel.id : "no model"}</span>
            <span className="model-meta">{activeModel ? priceLabel(activeModel) : ""}</span>
            <span className="caret">▾</span>
          </button>
          <span className={`run-state run-${status}`}>{statusLabel(status, loading)}</span>
        </div>
        <div className="messages">
          {messages.length === 0 && (
            <div className="welcome">
              <div className="welcome-mark">◈</div>
              <h2>What should ox build?</h2>
              <p>Reads your code · edits behind approval gates · runs shell through a denylist · remembers across sessions.</p>
              <div className="welcome-chips">
                <button onClick={() => setInput("Explain this codebase: structure, entry points, how to run it")}>Explain codebase</button>
                <button onClick={() => setInput("Plan first: break the task into steps before touching code")}>Plan first</button>
                <button onClick={() => setShowModels(true)}>Connect a model</button>
              </div>
            </div>
          )}
          {!readyToChat && messages.length > 0 && (
            <div className="connect-banner">
              <strong>No model connected.</strong>
              <span>Connect a local endpoint or paste an API key — session-only, never on disk.</span>
              <button onClick={() => setShowModels(true)}>Connect a model</button>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`message message-${m.role}`}>
              <span className="role">{m.role}</span>
              <span className="content">{m.content}</span>
            </div>
          ))}
          {loading && <div className="message message-assistant"><span className="role">assistant</span><span className="content typing"><span className="spinner" />Working…</span></span></div>}
          <div ref={messagesEndRef} />
        </div>
        <form className="input-bar" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={readyToChat ? `Ask ox (${activeModel?.id})…` : "Connect a model above to start…"}
            disabled={loading}
          />
          <button type="submit" disabled={loading || !input.trim()}>{loading ? "…" : "Send"}</button>
        </form>
        <div className="chat-footer">
          <span>{activeModel ? `${activeModel.provider} · ${activeModel.model}` : "no model"}</span>
          <span>·</span>
          <span>{tools.length} tools this session</span>
          {stats.filesTouched.length > 0 && (<><span>·</span><span>{stats.filesTouched.length} files touched</span></>)}
        </div>
      </main>

      <aside className="right-panel">
        {pendingDiff ? (
          <DiffView
            diff={pendingDiff}
            onAccept={handleDiffAccept}
            onReject={handleDiffReject}
            onToggleHunk={toggleHunkAccept}
          />
        ) : openFile ? (
          <EditorView
            filePath={openFile}
            content={fileContent}
            onContentChange={(v) => { setFileContent(v); setFileModified(true); }}
            onSave={handleSaveFile}
            modified={fileModified}
          />
        ) : (
          <div className="panel-section grow">
            <h3>Tools</h3>
            <div className="tool-log">
              {tools.length === 0 && <span className="empty">No tools executed yet — tools appear here live as ox works</span>}
              {[...tools].reverse().map((t, i) => (
                <div key={i} className={`tool-item tool-${t.status}`}>
                  <div className="tool-head">
                    <strong>{t.name || "tool"}</strong>
                    {t.status && <span className="tool-status">{t.status}</span>}
                  </div>
                  <pre>{truncateArgs(t.args)}</pre>
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>

      {showModels && (
        <ModelPicker
          models={models}
          providers={providers}
          withheld={withheld}
          selected={activeModel?.id}
          sessionKeys={sessionKeys}
          keyDrafts={keyDrafts}
          onDraft={(p, v) => setKeyDrafts((prev) => ({ ...prev, [p]: v }))}
          onSaveKey={handleSaveKey}
          onClearKey={handleClearKey}
          onSelect={(id) => setSelectedModel(id)}
          onClose={closePicker}
          local={local}
          scanning={scanning}
          onScan={handleScanLocal}
        />
      )}
    </div>
  );
}

function truncateArgs(args) {
  try {
    const s = JSON.stringify(args || {}, null, 2);
    return s.length > 400 ? s.slice(0, 400) + "…" : s;
  } catch {
    return "";
  }
}

function statusLabel(status, loading) {
  if (!loading) return "idle";
  if (status === "streaming") return "streaming";
  if (status === "tool") return "running tools";
  return "thinking";
}

function EditorView({ filePath, content, onContentChange, onSave, modified }) {
  return (
    <div className="panel-section editor-panel">
      <div className="editor-header">
        <h3>{filePath}</h3>
        <div className="editor-actions">
          <span className={modified ? "modified" : ""}>{modified ? "●" : ""}</span>
          <button onClick={onSave} disabled={!modified} className="save-btn">
            Save
          </button>
        </div>
      </div>
      <textarea
        className="editor-textarea"
        value={content}
        onChange={(e) => onContentChange(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}

function DiffView({ diff, onAccept, onReject, onToggleHunk }) {
  const { path, hunks, accepted } = diff;
  return (
    <div className="panel-section diff-panel">
      <div className="diff-header">
        <h3>Diff: {path}</h3>
        <div className="diff-actions">
          <button onClick={onAccept} className="accept-btn">Accept All</button>
          <button onClick={onReject} className="reject-btn">Reject All</button>
        </div>
      </div>
      <div className="diff-content">
        {hunks.length === 0 && <span className="empty">No changes</span>}
        {hunks.map((hunk, hunkIdx) => (
          <div key={hunkIdx} className="diff-hunk">
            <div className="hunk-header">
              <span className={accepted.has(hunkIdx) ? "accepted" : "pending"}>
                {accepted.has(hunkIdx) ? "✓" : "○"} Hunk {hunkIdx + 1}
              </span>
              <button
                onClick={() => onToggleHunk(hunkIdx)}
                className="hunk-toggle"
              >
                {accepted.has(hunkIdx) ? "Reject hunk" : "Accept hunk"}
              </button>
            </div>
            <pre className="hunk-lines">
              {hunk.lines.map((line, lineIdx) => (
                <span key={lineIdx} className={`diff-line diff-${line.type}`}>
                  {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}{line.content}
                </span>
              ))}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
