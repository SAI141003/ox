// ox's hands for a plan you pay for: an MCP server (stdio) that gives the
// vendor's own CLI (Codex, Claude Code…) ox's everyday Mac actions. A plan's
// run happens inside that CLI, which only sees its own tools, so "open
// WhatsApp" had nothing to open it with. Run as `ox mcp-mac`.
//
// Exposed on purpose: open an installed app, open a web page, the browser's
// front tab, a YouTube transcript, and the small offline tasks of `ox do`
// (notes, to-dos, email drafts that are never sent, music, volume, timers).
// Click and type (src/mac-control.js): see an app's controls, click one, type
// where the cursor is, press a navigation key; never Return, Send, Pay or
// Delete, so a message is written and left for the owner to send.
// Not exposed: shell commands, sending anything.
import { listElements, describeElements, click, typeText, pressKey } from './mac-control.js';
import { doOffline, resolveApp } from './offline.js';
import { osCmd } from './tools/operator.js';
import { currentPageTool } from './tools/current-page.js';
import { youtubeTranscriptTool } from './tools/youtube.js';
import { spawnSync } from 'node:child_process';

export const MAC_TOOLS = [
  { name: 'open_app', description: 'Open an application on this Mac by name (WhatsApp, Safari, Spotify, Notes, Mail…). Only apps that are installed.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'open_url', description: 'Open a web page or app link in the default browser or app (https://…, whatsapp://, spotify:, mailto: for a draft).', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'current_page', description: "The page open in the user's browser right now: title, address, browser.", inputSchema: { type: 'object', properties: {} } },
  { name: 'youtube_transcript', description: 'What a YouTube video says, as timestamped text, from its link or id.', inputSchema: { type: 'object', properties: { video: { type: 'string' }, lang: { type: 'string' } }, required: ['video'] } },
  { name: 'ox_do', description: 'A small Mac task in plain words, done without AI: "note buy milk", "add task call mum", "email anna@x.com about lunch saying …" (opens a draft, never sends), "check my email", "pause the music", "next song", "volume 30", "timer 10 minutes", "what time is it". Says plainly when it is not one of these.', inputSchema: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] } },
  { name: 'notify', description: 'Show a notification on this Mac.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'ui_elements', description: "The controls of an app's front window (buttons, text boxes, list rows, labels) with a number and where each is on screen. Call it before clicking. app: the app's name, or leave it out for the app in front.", inputSchema: { type: 'object', properties: { app: { type: 'string' } } } },
  { name: 'click', description: 'Click a control in an app: element is its name as ui_elements shows it ("Search", "Anna Smith") or its number from ui_elements; role narrows it ("button", "text field", "row"); or x and y in screen points. double for a double click. Never presses Send, Pay, Buy, Delete or the like: those are left for the user.', inputSchema: { type: 'object', properties: { app: { type: 'string' }, element: { type: 'string' }, role: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, double: { type: 'boolean' } } } },
  { name: 'type_text', description: 'Type text where the cursor is in an app (any language, emoji, several lines). into: a text box to click first, by its name from ui_elements. Never presses Return, so a chat message is written and left for the user to send.', inputSchema: { type: 'object', properties: { app: { type: 'string' }, text: { type: 'string' }, into: { type: 'string' } }, required: ['text'] } },
  { name: 'press_key', description: 'Press a key in an app: tab, shift+tab, escape, space, delete, up, down, left, right, home, end, pageup, pagedown, or ⌘ with A C F K L N T V X Z (cmd+f to search, cmd+n for new). Never Return or Enter. times repeats it.', inputSchema: { type: 'object', properties: { app: { type: 'string' }, key: { type: 'string' }, times: { type: 'number' } }, required: ['key'] } },
];

const ALLOWED_SCHEMES = /^(https?:\/\/|whatsapp:|spotify:|mailto:|tel:|facetime:|maps:|zoommtg:|slack:|discord:|tg:|music:)/i;

function run(cmd) {
  if (!cmd) return { ok: false, err: `not supported on ${process.platform}` };
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', timeout: 15000 });
  return r.status === 0 ? { ok: true } : { ok: false, err: (r.stderr || r.error?.message || `exit ${r.status}`).trim() };
}

export async function callMacTool(name, args = {}, { dryRun = false } = {}) {
  switch (name) {
    case 'open_app': {
      const app = resolveApp(args.name);
      if (!app) return { isError: true, text: `"${args.name}" is not an app on this Mac.` };
      if (dryRun) return { text: `would open ${app}` };
      const r = run(osCmd('open_app', app));
      return r.ok ? { text: `opened ${app}` } : { isError: true, text: `could not open ${app}: ${r.err}` };
    }
    case 'open_url': {
      const url = String(args.url ?? '').trim();
      if (!ALLOWED_SCHEMES.test(url)) return { isError: true, text: 'only web pages and app links (https, whatsapp, spotify, mailto, tel, facetime, maps, zoom, slack, discord, telegram, music) are opened' };
      if (dryRun) return { text: `would open ${url}` };
      const r = run(process.platform === 'darwin' ? ['open', url] : osCmd('open_url', url));
      return r.ok ? { text: `opened ${url}` } : { isError: true, text: r.err };
    }
    case 'current_page': { const r = await currentPageTool({}); return { isError: !!r.isError, text: r.content }; }
    case 'youtube_transcript': { const r = await youtubeTranscriptTool(args); return { isError: !!r.isError, text: r.content }; }
    case 'ox_do': {
      const r = doOffline(String(args.request ?? ''), { dryRun });
      return r.handled ? { isError: r.ok === false, text: r.message } : { isError: true, text: r.message };
    }
    case 'notify': {
      if (dryRun) return { text: 'would notify' };
      const r = run(osCmd('notify', String(args.text ?? '').slice(0, 240)));
      return r.ok ? { text: 'shown' } : { isError: true, text: r.err };
    }
    case 'ui_elements': {
      if (dryRun) return { text: `would list the controls of ${args.app || 'the app in front'}` };
      const l = await listElements(args.app);
      return l.error ? { isError: true, text: l.error } : { text: describeElements(l) };
    }
    case 'click': return await click(args, { dryRun });
    case 'type_text': return await typeText(args, { dryRun });
    case 'press_key': return await pressKey(args, { dryRun });
    default: return { isError: true, text: `no tool ${name}` };
  }
}

export function serveMacMcp({ input = process.stdin, output = process.stdout } = {}) {
  let buf = '';
  const send = (o) => output.write(`${JSON.stringify(o)}\n`);
  input.setEncoding('utf8');
  input.on('data', async (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ox-mac', version: '0.1.0' } } });
      else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: MAC_TOOLS } });
      else if (msg.method === 'tools/call') {
        try {
          const r = await callMacTool(msg.params?.name, msg.params?.arguments ?? {});
          send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: r.text }], isError: !!r.isError } });
        } catch (e) {
          send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(e?.message ?? e) }], isError: true } });
        }
      } else if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  });
}
