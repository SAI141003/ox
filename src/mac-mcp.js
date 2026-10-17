// ox's hands for a plan you pay for: an MCP server (stdio) that gives the
// vendor's own CLI (Codex, Claude Code…) ox's everyday Mac actions. A plan's
// run happens inside that CLI, which only sees its own tools, so "open
// WhatsApp" had nothing to open it with. Run as `ox mcp-mac`.
//
// Exposed on purpose: open an installed app, open a web page, the browser's
// front tab, a YouTube transcript, and the small offline tasks of `ox do`
// (notes, to-dos, email drafts that are never sent, music, volume, timers).
// Not exposed: typing into other apps, shell commands, sending anything.
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
