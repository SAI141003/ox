import { useMemo, useState } from "react";
import { ModelsTab, KeysTab, LocalTab } from "./ModelPickerTabs.jsx";

const KNOWN_KEYS = [
  ["xai", "XAI_API_KEY"],
  ["anthropic", "ANTHROPIC_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
  ["gemini", "GEMINI_API_KEY"],
  ["groq", "GROQ_API_KEY"],
  ["openrouter", "OPENROUTER_API_KEY"],
  ["deepseek", "DEEPSEEK_API_KEY"],
  ["backboard", "BACKBOARD_API_KEY"],
];

export default function ModelPicker(props) {
  const { models, selected, sessionKeys } = props;
  const [tab, setTab] = useState("models");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) =>
      [m.id, m.provider, m.model, m.desc].filter(Boolean).join(" ").toLowerCase().includes(q)
    );
  }, [models, query]);

  const keyRows = useMemo(() => {
    const seen = new Map();
    for (const m of models) {
      if (m.requires_key && !seen.has(m.provider)) {
        seen.set(m.provider, { provider: m.provider, keyEnv: m.requires_key });
      }
    }
    for (const [provider, keyEnv] of KNOWN_KEYS) {
      if (!seen.has(provider)) seen.set(provider, { provider, keyEnv });
    }
    return [...seen.values()];
  }, [models]);

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>Connect a model</h2>
            <p>Local endpoints are free · API keys stay in this session only, never on disk.</p>
          </div>
          <button className="modal-close" onClick={props.onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-tabs">
          {[["models", "Models"], ["keys", "API keys"], ["local", "Local"]].map(([id, label]) => (
            <button key={id} className={`modal-tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
              {label}
              {id === "keys" && Object.keys(sessionKeys).length > 0 && (
                <span className="count">{Object.keys(sessionKeys).length}</span>
              )}
              {id === "local" && (props.local?.found?.length > 0) && (
                <span className="count">{props.local.found.length}</span>
              )}
            </button>
          ))}
        </div>
        {tab === "models" && (
          <ModelsTab models={filtered} query={query} setQuery={setQuery}
            selected={selected} sessionKeys={sessionKeys}
            onSelect={props.onSelect} withheld={props.withheld} />
        )}
        {tab === "keys" && (
          <KeysTab rows={keyRows} sessionKeys={sessionKeys} drafts={props.keyDrafts}
            onDraft={props.onDraft} onSave={props.onSaveKey} onClear={props.onClearKey} />
        )}
        {tab === "local" && (
          <LocalTab local={props.local} scanning={props.scanning} onScan={props.onScan} />
        )}
        <div className="modal-footer">
          <span className="hint">ox is open-source · zero telemetry · approvals stay fail-closed</span>
          <button className="primary" onClick={props.onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
