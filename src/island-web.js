// OX Island for Windows and Linux (and anywhere else Node runs).
//
// macOS has the native notch app (desktop/island). Everywhere else the island
// is this: a small server on 127.0.0.1 that
//   - marks the island as live (~/.ox/island.json), so ox runs open their
//     per-run IPC socket exactly as they do for the notch app;
//   - connects to every run's socket (named pipes on Windows) and folds its
//     events with the same reducer `ox ipc watch` uses;
//   - serves the island page (src/web/island.html), shown in an Edge/Chrome
//     app window pinned to the top of the screen.
//
// Every request must carry the per-launch token, and the Host header must be
// the loopback address: another web page in the browser cannot read the runs
// or answer an approval, even though the server is on localhost.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectIpcClient, listIpcSockets } from './ipc.js';
import { createWatchState, applyMessage, currentTool, pendingApprovals } from './ipc-watch.js';
import { islandFile } from './island.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OX_CLI = path.join(HERE, '..', 'bin', 'ox.js');
const PAGE = path.join(HERE, 'web', 'island.html');
export const SHELF_DIR = () => path.join(os.homedir(), '.ox', 'island', 'shelf');

// Small, read-only system snapshot for the Island's compact utility tiles.
// Each platform is best-effort: an unavailable OS API is represented as null,
// never as a guessed value.
export function systemSnapshot({ platform = process.platform, spawn = spawnSync } = {}) {
  const run = (cmd, args) => {
    try { const r = spawn(cmd, args, { encoding: 'utf8', timeout: 1500, windowsHide: true }); return r.status === 0 ? String(r.stdout ?? '').trim() : ''; } catch { return ''; }
  };
  let battery = null;
  if (platform === 'darwin') {
    const text = run('pmset', ['-g', 'batt']);
    const m = /([0-9]+)%/.exec(text); if (m) battery = { percent: Number(m[1]), charging: /AC Power|charging/i.test(text) };
  } else if (platform === 'win32') {
    const text = run('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress)']);
    try { const b = JSON.parse(text); if (b?.EstimatedChargeRemaining != null) battery = { percent: Number(b.EstimatedChargeRemaining), charging: [2,3,6,7,8,9].includes(Number(b.BatteryStatus)) }; } catch {}
  } else {
    const text = run('sh', ['-c', 'for f in /sys/class/power_supply/BAT*/capacity; do [ -r "$f" ] && cat "$f" && break; done']);
    if (/^\d+$/.test(text)) battery = { percent: Number(text), charging: null };
  }
  let volume = null;
  if (platform === 'darwin') { const m = /volume:(\d+)/i.exec(run('osascript', ['-e', 'output volume of (get volume settings)'])); if (m) volume = Number(m[1]); }
  else if (platform === 'win32') { volume = null; }
  else { const m = /\[(\d+)%\]/.exec(run('amixer', ['get', 'Master'])); if (m) volume = Number(m[1]); }
  const mediaText = platform === 'win32' ? run('tasklist', ['/FI', 'IMAGENAME eq Spotify.exe']) : platform === 'darwin' ? run('pgrep', ['-x', 'Spotify']) : run('pgrep', ['-x', 'spotify']);
  const media = platform === 'win32' ? /Spotify\.exe/i.test(mediaText) : Boolean(mediaText);
  return { battery, volume, media: { spotify: media }, tray: true };
}

// One run, as the island shows it.
export function summarize(sock, st) {
  const tool = currentTool(st);
  const tail = String(st.tail ?? '').trim().split('\n').filter(Boolean).at(-1) ?? '';
  return {
    socket: sock,
    project: st.cwd ? path.basename(st.cwd) : 'ox',
    model: st.servedModel ?? st.model ?? st.declaredModel ?? '',
    phase: st.phase,
    activity: tool ? `${tool.name} ${tool.preview ?? ''}`.trim() : st.phase === 'waiting' ? 'waiting for you' : st.phase,
    tokens: st.tokensUnknown ? null : (st.tokensIn ?? 0) + (st.tokensOut ?? 0),
    costUsd: st.costKnown ? st.costUsd : null,
    agents: st.agentsActive ?? 0,
    lastError: st.lastError ?? null,
    tail: tail.slice(-160),
    approvals: pendingApprovals(st).map((a) => ({ id: a.id, tool: a.tool, preview: String(a.argsPreview ?? '').slice(0, 200) })),
  };
}

export function createRunWatcher({ list = listIpcSockets, connect = connectIpcClient } = {}) {
  const runs = new Map(); // socket -> { client, state }
  function scan() {
    for (const sock of list()) {
      if (runs.has(sock)) continue;
      const client = connect({ socketPath: sock, clientId: `island-web-${process.pid}` });
      const entry = { client, state: createWatchState() };
      runs.set(sock, entry);
      // The server's `hello` marks the run connected and names its project.
      client.on('message', (msg) => { entry.state = applyMessage(entry.state, msg, { now: Date.now() }); });
      client.on('close', () => { runs.delete(sock); });
    }
  }
  return {
    scan,
    snapshot: () => [...runs.entries()].filter(([, r]) => r.state.connected).map(([s, r]) => summarize(s, r.state)),
    answer(sock, id, decision) {
      const r = runs.get(sock);
      return r ? r.client.answer(id, decision) : false;
    },
    close() { for (const r of runs.values()) { try { r.client.close(); } catch {} } runs.clear(); },
  };
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (d) => {
      n += d.length;
      if (n > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function runOx(args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [OX_CLI, ...args], { cwd, env: { ...process.env, OX_ISLAND: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => resolve({ code: 127, out: e.message }));
    p.on('close', (code) => resolve({ code, out }));
  });
}

const cleanAnswer = (s) => String(s).split('\n').filter((l) => !/^[·●✓] /.test(l)).join('\n').trim();

export function createIslandServer({
  port = 0,
  token = crypto.randomBytes(18).toString('base64url'),
  watcher = createRunWatcher(),
  transcribeAudio = null,
} = {}) {
  const shelf = SHELF_DIR();
  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    const host = String(req.headers.host ?? '');
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(403, { error: 'loopback only' });
    const url = new URL(req.url, `http://${host}`);
    const given = url.searchParams.get('t') ?? req.headers['x-ox-token'];
    const ok = typeof given === 'string' && given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
    if (!ok) return send(401, { error: 'missing or wrong token' });

    try {
      if (req.method === 'GET' && url.pathname === '/') {
        return send(200, fs.readFileSync(PAGE, 'utf8'), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        let files = [];
        try { files = fs.readdirSync(shelf).map((n) => ({ name: n, path: path.join(shelf, n) })); } catch {}
        const { listMods } = await import('./mods.js');
        return send(200, { runs: watcher.snapshot(), shelf: files, mods: listMods(), system: systemSnapshot(), platform: process.platform });
      }
      if (req.method === 'POST' && url.pathname === '/api/answer') {
        const b = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}');
        if (!['allow', 'deny', 'ask'].includes(b.decision)) return send(400, { error: 'decision must be allow, deny or ask' });
        return send(200, { ok: watcher.answer(String(b.socket), String(b.id), b.decision) });
      }
      if (req.method === 'POST' && url.pathname === '/api/shelf') {
        // A browser never hands out a dropped file's path, so the file itself
        // is copied onto the shelf folder, under a name that cannot escape it.
        const name = path.basename(decodeURIComponent(String(req.headers['x-file-name'] ?? 'file'))).replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file';
        fs.mkdirSync(shelf, { recursive: true });
        fs.writeFileSync(path.join(shelf, name), await readBody(req));
        return send(200, { ok: true, name });
      }
      if (req.method === 'POST' && url.pathname === '/api/shelf/remove') {
        const b = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}');
        const p = path.join(shelf, path.basename(String(b.name ?? '')));
        try { fs.unlinkSync(p); } catch {}
        return send(200, { ok: true });
      }
      // Hold-to-talk (Coucou for Windows): the recording in, the words out,
      // typed where you are when ?type=1 (pasted: Enter is never pressed).
      if (req.method === 'POST' && url.pathname === '/api/dictate') {
        const buf = await readBody(req, 25 * 1024 * 1024);
        if (!buf.length) return send(400, { error: 'no audio' });
        const f = path.join(os.tmpdir(), `ox-voice-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${/ogg/.test(req.headers['content-type'] ?? '') ? 'ogg' : /wav/.test(req.headers['content-type'] ?? '') ? 'wav' : 'webm'}`);
        fs.writeFileSync(f, buf);
        try {
          const tr = transcribeAudio
            ? await transcribeAudio(f)
            : await (await import('./video-edit.js')).transcribe(f);
          const text = tr.segments.map((x) => x.text).join(' ').replace(/\s+/g, ' ').trim();
          let typed = false;
          if (url.searchParams.get('type') === '1' && text) {
            const O = await import('./tools/operator.js');
            const r = await O.type_text({ text }, { yolo: true });
            typed = !r.isError;
          }
          return send(200, { text, typed });
        } catch (e) {
          return send(500, { error: String(e?.message ?? e) });
        } finally {
          for (const x of [f, f.replace(/\.\w+$/, '.transcript.srt')]) { try { fs.rmSync(x, { force: true }); } catch {} }
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/ask') {
        const b = JSON.parse((await readBody(req, 16384)).toString('utf8') || '{}');
        const name = path.basename(String(b.name ?? ''));
        if (!name || !fs.existsSync(path.join(shelf, name))) return send(404, { error: 'not on the shelf' });
        const q = String(b.question ?? '').trim() || 'Summarise this file in a few lines.';
        const r = await runOx(['--mode', 'ask', '-p', `${q}\n\nThe file: @${name}`], shelf);
        return send(200, { ok: r.code === 0, answer: cleanAnswer(r.out) });
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(500, { error: String(e?.message ?? e) });
    }
  });
  const scanTimer = setInterval(() => watcher.scan(), 1000);
  scanTimer.unref?.();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      watcher.scan();
      const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;
      resolve({
        url,
        token,
        port: server.address().port,
        close: () => new Promise((r) => { clearInterval(scanTimer); watcher.close(); server.close(() => r()); }),
      });
    });
  });
}

// The island window: a chromeless app window from a browser that is already
// there (Edge ships with Windows). The page centres itself at the top.
export function findAppBrowser(platform = process.platform, env = process.env) {
  const candidates = platform === 'win32'
    ? [
        path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    : platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
  for (const c of candidates) {
    if (path.isAbsolute(c)) { if (fs.existsSync(c)) return c; continue; }
    const r = spawnSync(platform === 'win32' ? 'where' : 'which', [c], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split('\n')[0];
  }
  return null;
}

export function openIslandWindow(url, { platform = process.platform } = {}) {
  const browser = findAppBrowser(platform);
  const profile = path.join(os.homedir(), '.ox', 'island', 'browser-profile');
  if (browser) {
    const child = spawn(browser, [`--app=${url}`, '--window-size=520,72', '--window-position=0,0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--use-mock-keychain', '--password-store=basic'], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {});
    child.unref();
    if (platform === 'win32') keepOnTopWindows(child.pid);
    return { how: 'app-window', browser };
  }
  const opener = platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return { how: 'browser-tab', browser: null };
}

// Windows: an app window cannot ask to stay on top, so the island's window is
// found by its title and pinned with SetWindowPos(HWND_TOPMOST).
function keepOnTopWindows() {
  const ps = [
    "Add-Type -Name W -Namespace Ox -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);'",
    'for ($i = 0; $i -lt 40; $i++) {',
    "  $w = Get-Process | Where-Object { $_.MainWindowTitle -eq 'ox island' } | Select-Object -First 1",
    '  if ($w) { [void][Ox.W]::SetWindowPos($w.MainWindowHandle, [IntPtr](-1), 0, 0, 0, 0, 0x0003); break }',
    '  Start-Sleep -Milliseconds 250',
    '}',
  ].join('\n');
  const child = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

// `ox island` off macOS: serve, mark the island live, open the window, and stay
// up until stopped. The presence file is what makes ox runs connect.
export async function runWebIsland({ log = console.log, open = true, port = Number(process.env.OX_ISLAND_PORT) || 0 } = {}) {
  const srv = await createIslandServer({ port });
  fs.mkdirSync(path.dirname(islandFile()), { recursive: true });
  fs.writeFileSync(islandFile(), JSON.stringify({ pid: process.pid, kind: 'web', url: srv.url, startedAt: new Date().toISOString() }));
  const cleanup = () => {
    try {
      const rec = JSON.parse(fs.readFileSync(islandFile(), 'utf8'));
      if (rec.pid === process.pid) fs.unlinkSync(islandFile());
    } catch {}
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(0); });
  const how = open ? openIslandWindow(srv.url) : { how: 'none' };
  log(`OX Island is live${how.how === 'app-window' ? '' : how.how === 'browser-tab' ? ' (opened in your browser: no Edge/Chrome found for an app window)' : ''} — every ox run now shows up there`);
  log(`  ${srv.url}`);
  return srv;
}
