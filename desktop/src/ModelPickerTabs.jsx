export function priceLabel(m) {
  if (!m.pricing) return "free · local";
  return `$${m.pricing.in}/$${m.pricing.out} per Mtok`;
}

export function ModelsTab({ models, query, setQuery, selected, sessionKeys, onSelect, withheld }) {
  return (
    <div className="modal-body">
      <input className="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search models, providers…" />
      <div className="model-list">
        {models.map((m) => {
          const unlocked = m.available || (m.requires_key && sessionKeys[m.requires_key]);
          return (
            <button key={m.id} className={`model-row ${selected === m.id ? "selected" : ""} ${unlocked ? "" : "locked"}`} onClick={() => onSelect(m.id)}>
              <span className={`dot ${unlocked ? "ok" : "warn"}`} />
              <span className="model-main">
                <strong>{m.id}</strong>
                <span className="model-sub">{m.desc} · {m.provider}/{m.model}</span>
              </span>
              <span className="model-right">
                <span className="price">{priceLabel(m)}</span>
                <span className="avail">{unlocked ? "ready" : m.requires_key ? "needs key" : "unavailable"}</span>
              </span>
              {selected === m.id && <span className="check">✓</span>}
            </button>
          );
        })}
        {models.length === 0 && <span className="empty">No models match.</span>}
      </div>
      {withheld?.length > 0 && (
        <p className="hint">{withheld.length} bot{withheld.length === 1 ? "" : "s"} need an explicit model suffix and are hidden from serve.</p>
      )}
    </div>
  );
}

export function KeysTab({ rows, sessionKeys, drafts, onDraft, onSave, onClear }) {
  return (
    <div className="modal-body">
      <p className="hint">Paste a key to unlock that provider for this session. Persist with <code>export KEY=…</code> to keep it.</p>
      {rows.map(({ provider, keyEnv }) => {
        const set = Boolean(sessionKeys[keyEnv]);
        return (
          <div key={provider} className="key-row">
            <div className="key-info">
              <strong>{provider}</strong>
              <code>{keyEnv}</code>
              {set && <span className="avail ok-text">connected ✓</span>}
            </div>
            {set ? (
              <button className="ghost danger" onClick={() => onClear(keyEnv)}>Forget</button>
            ) : (
              <div className="key-input">
                <input type="password" value={drafts[provider] ?? ""}
                  onChange={(e) => onDraft(provider, e.target.value)}
                  placeholder={`paste ${keyEnv}`}
                  onKeyDown={(e) => { if (e.key === "Enter") onSave(provider, keyEnv); }} />
                <button onClick={() => onSave(provider, keyEnv)} disabled={!(drafts[provider] ?? "").trim()}>Connect</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function LocalTab({ local, scanning, onScan }) {
  return (
    <div className="modal-body">
      <div className="local-head">
        <p className="hint">Free, private, no key — Ollama, llama.cpp, vLLM, LM Studio.</p>
        <button onClick={onScan} disabled={scanning}>{scanning ? "Scanning…" : local ? "Rescan" : "Scan now"}</button>
      </div>
      {!local && !scanning && <span className="empty">Not scanned yet — one click, ~2 seconds.</span>}
      {local && (local.found ?? []).length === 0 && <span className="empty">No local servers found. Start Ollama (<code>ollama serve</code>) then rescan.</span>}
      {(local?.found ?? []).map((f, i) => (
        <div key={i} className="local-card">
          <div className="local-top">
            <strong>{f.runtime ?? f.protocol ?? "local server"}</strong>
            <span className="avail">{f.approved ? "trusted ✓" : "found — approve with `ox local approve`"}</span>
          </div>
          <code className="local-url">{f.baseUrl}</code>
          {(f.models ?? []).length > 0 && (
            <div className="local-models">
              {(f.models ?? []).slice(0, 6).map((m, j) => (
                <span key={j} className="chip">{m.name}{m.size ? ` · ${m.size}` : ""}</span>
              ))}
            </div>
          )}
        </div>
      ))}
      {local?.error && <p className="error-text">Scan error: {local.error}</p>}
    </div>
  );
}
