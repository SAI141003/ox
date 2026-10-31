// Settings › Plugins & connectors › Connectors: the services people know (Google
// Drive, Gmail, Notion, GitHub, Slack, Outlook, WhatsApp…) as one gallery, each
// with its logo and its real state on this machine. Every entry is backed by
// something ox already does: a curated MCP template it can add, or an app on
// this Mac it drives. Nothing is shown as connected unless it is: an added MCP
// server is "Added" (it signs in on first use), an app found on this Mac is
// "On this Mac", and only a verified messaging gateway is "Connected".

import { execFileSync } from 'node:child_process';
import { getTemplate } from './mcp-templates.js';

// id, name, what it does, how ox reaches it.
export const GALLERY = Object.freeze([
  { id: 'gdrive', name: 'Google Drive', desc: 'Search, read and open your Drive files', template: 'gsuite' },
  { id: 'gmail', name: 'Gmail', desc: 'Search your inbox, summarize threads, draft replies', template: 'gsuite' },
  { id: 'gcal', name: 'Google Calendar', desc: 'See your schedule and plan meetings', template: 'gsuite' },
  { id: 'gdocs', name: 'Google Docs', desc: 'Read and summarize your documents', template: 'gsuite' },
  { id: 'gsheets', name: 'Google Sheets', desc: 'Read and analyze your spreadsheets', template: 'gsuite' },
  { id: 'notion', name: 'Notion', desc: 'Search and work with your pages and databases', template: 'notion' },
  { id: 'github', name: 'GitHub', desc: 'Repositories, issues, pull requests and Actions', template: 'github' },
  { id: 'slack', name: 'Slack', desc: 'Read channels and post messages after your OK', template: 'slack', app: 'slack', channel: 'slack' },
  { id: 'outlook', name: 'Microsoft Outlook', desc: 'Draft emails in Outlook on this Mac; you press Send', app: 'outlook' },
  { id: 'mail', name: 'Apple Mail', desc: 'Draft emails in Mail on this Mac; you press Send', app: 'mail' },
  { id: 'whatsapp', name: 'WhatsApp', desc: 'Open a chat with a message ready; you press Enter', app: 'whatsapp', channel: 'whatsapp' },
  { id: 'messages', name: 'Messages', desc: 'iMessage and SMS from this Mac, after your OK', app: 'messages' },
  { id: 'telegram', name: 'Telegram', desc: 'Talk to ox from Telegram through your own bot', app: 'telegram', channel: 'telegram' },
  { id: 'browser', name: 'Browser', desc: 'A real browser ox can click and fill, in its own profile', template: 'browser' },
]);

const defaultHas = (cmd) => {
  try { execFileSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore', timeout: 2000 }); return true; } catch { return false; }
};

// What a template needs on this machine before it can run.
const NEEDS = { gsuite: { cmd: 'uvx', how: 'Install uv first: brew install uv' }, notion: { cmd: 'npx', how: 'Install Node.js first' }, github: { cmd: 'docker', how: 'Install and start Docker Desktop first' }, browser: { cmd: 'npx', how: 'Install Node.js first' } };

/**
 * The gallery with each entry's state:
 *   added      an MCP server ox will use (signs in on first use)
 *   connected  a messaging gateway that is paired or verified
 *   local      the app is on this Mac and ox drives it
 *   connect    one click adds it
 *   needs      something is missing first (`why` says what)
 *   broken     added, but it has been failing to start (`why` says why)
 */
export function galleryView({ servers = {}, apps = {}, channels = {}, env = process.env, has = defaultHas, health = {} } = {}) {
  const hasCache = new Map();
  const haveCmd = (c) => { if (!hasCache.has(c)) hasCache.set(c, has(c)); return hasCache.get(c); };
  return GALLERY.map((g) => {
    const tpl = g.template ? getTemplate(g.template) : null;
    const ch = g.channel ? channels[g.channel] : null;
    const app = g.app ? apps[g.app] : null;
    const base = { id: g.id, name: g.name, desc: g.desc, template: g.template ?? null };
    if (tpl && Object.prototype.hasOwnProperty.call(servers, g.template)) {
      // Added, but it has not been starting: say so and why, instead of a quiet "Added".
      const h = health[g.template];
      if (h && typeof h === 'object') {
        const why = h.status === 'slow' ? 'never finished starting: finish its sign-in in the browser' : h.status === 'http-error' ? 'its login was refused: sign in again' : /docker/i.test(`${h.why ?? ''} ${g.template}`) || g.template === 'github' ? 'did not start: Docker is not running' : `did not start (${h.status})`;
        return { ...base, state: 'broken', why };
      }
      return { ...base, state: 'added', why: g.template === 'gsuite' ? 'Google sign-in opens on first use' : 'Signs in on first use' };
    }
    if (ch && (ch.paired || ch.reachable)) return { ...base, state: 'connected', why: ch.paired ? 'Paired' : 'Verified' };
    if (app?.installed && !tpl) return { ...base, state: 'local', why: `${app.name ?? g.name} on this Mac${app.version ? ` · ${app.version}` : ''}` };
    if (tpl) {
      const missing = (tpl.requires ?? []).filter((k) => !env[k]);
      if (missing.length) return { ...base, state: app?.installed ? 'local' : 'needs', why: app?.installed ? `${app.name} on this Mac · add ${missing.join(', ')} for the connector` : `Needs ${missing.join(', ')}`, open: 'messaging' };
      const need = NEEDS[g.template];
      if (need && !haveCmd(need.cmd)) return { ...base, state: 'needs', why: need.how };
      return { ...base, state: 'connect', why: tpl.risk === 'write' ? 'Asks before every action' : 'Read-only' };
    }
    return { ...base, state: 'needs', why: g.app === 'telegram' ? 'Set up a bot in Messaging' : `Install ${g.name} on this Mac`, open: 'messaging' };
  });
}

/** The MCP server entry a gallery item adds (shared by the Google ones). */
export function galleryEntry(id) {
  const g = GALLERY.find((x) => x.id === id);
  if (!g?.template) throw new Error(`${g?.name ?? id} is not added as a connector; set it up in Messaging`);
  const tpl = getTemplate(g.template);
  if (!tpl) throw new Error(`no template ${g.template}`);
  return { name: g.template, entry: tpl.entry() };
}
