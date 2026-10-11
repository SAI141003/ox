const API_BASE = '/api';
const WS_PROTO = location.protocol === 'https:' ? 'wss' : 'ws';
const WS_URL = `${WS_PROTO}://${location.host}`;

const state = {
  models: [],
  agents: [],
  tasks: [],
  theme: localStorage.getItem('theme') || 'dark',
};

function init() {
  applyTheme();
  initThemeToggle();
  connectWebSocket();
  fetchModels();
  fetchAgents();
  fetchTasks();
  fetchServerInfo();
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  localStorage.setItem('theme', state.theme);
}

function initThemeToggle() {
  const toggle = document.getElementById('themeToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
    });
  }
}

function connectWebSocket() {
  const statusEl = document.getElementById('connectionStatus');
  const dot = statusEl?.querySelector('.status-dot');
  const text = statusEl?.querySelector('.status-text');

  const ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    if (dot) dot.className = 'status-dot online';
    if (text) text.textContent = 'Connected';
  });

  ws.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWebSocketMessage(data);
    } catch (e) {
      console.error('WS parse error:', e);
    }
  });

  ws.addEventListener('close', () => {
    if (dot) dot.className = 'status-dot offline';
    if (text) text.textContent = 'Disconnected';
    setTimeout(connectWebSocket, 5000);
  });

  ws.addEventListener('error', (err) => {
    console.error('WS error:', err);
  });
}

function handleWebSocketMessage(data) {
  if (data.type === 'models-update') {
    state.models = data.payload || [];
    updateModelStatus();
  } else if (data.type === 'agents-update') {
    state.agents = data.payload || [];
  } else if (data.type === 'tasks-update') {
    state.tasks = data.payload || [];
  }
}

async function fetchModels() {
  try {
    const res = await fetch(`${API_BASE}/models`);
    const data = await res.json();
    state.models = data.data || data || [];
    updateStat('statModels', state.models.length);
    updateModelStatus();
  } catch (err) {
    console.error('Failed to fetch models:', err);
  }
}

async function fetchAgents() {
  try {
    const res = await fetch(`${API_BASE}/agents`);
    const data = await res.json();
    state.agents = data.data || data || [];
    updateStat('statAgents', state.agents.length);
  } catch (err) {
    console.error('Failed to fetch agents:', err);
  }
}

async function fetchTasks() {
  try {
    const res = await fetch(`${API_BASE}/tasks`);
    const data = await res.json();
    state.tasks = data.data || data || [];
    updateStat('statTasks', state.tasks.length);
  } catch (err) {
    console.error('Failed to fetch tasks:', err);
  }
}

async function fetchServerInfo() {
  try {
    const res = await fetch(`${API_BASE}/info`);
    const data = await res.json();
    const versionEl = document.getElementById('serverVersion');
    if (versionEl && data.version) {
      versionEl.textContent = data.version;
    }
    if (data.cost !== undefined) {
      updateStat('statCost', `$${data.cost.toFixed(2)}`);
    }
  } catch (err) {
    console.error('Failed to fetch server info:', err);
  }
}

function updateStat(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function updateModelStatus() {
  const grid = document.getElementById('modelStatus');
  if (!grid) return;

  if (!state.models.length) {
    grid.innerHTML = '<div class="loading">No models available</div>';
    return;
  }

  grid.innerHTML = state.models.map(model => `
    <div class="model-card">
      <h3>${escapeHtml(model.name || model.id || 'Unnamed')}</h3>
      <div class="model-meta">
        <span class="model-status ${model.active !== false ? 'active' : 'inactive'}">
          ${model.active === false ? 'Inactive' : 'Active'}
        </span>
        <span>${escapeHtml(model.provider || 'unknown')}</span>
      </div>
    </div>
  `).join('');
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

document.addEventListener('DOMContentLoaded', init);
