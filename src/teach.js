// Teach ox a skill by showing it. A screen recording (yours, or one made here) becomes a normal
// skill: what the frames and your voice show, written as steps ox can follow later through the
// desktop tool, by the names of the controls and not by pixels. The recording stays on this Mac.
// The frames do go to the model you run this with, so it says which one before it starts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { replyOf } from './ask-agent.js';
import { understand } from './video-edit.js';
import { screenPersistText } from './memory.js';

const OX_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
const oxHome = (home) => process.env.OX_HOME || path.join(home, '.ox');
const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

export const TEACH_SYSTEM = `You are watching a screen recording of a person showing how to do something on their computer, so that an agent can do it later. You get frames in time order and what they said, if anything.
Write what they did, as a skill. Answer with JSON only:
{"name":"short-kebab-name","description":"Use when ... (one line: the request this answers)","body":"markdown"}
The body has these parts:
## Steps: numbered, one action each. Name the app, the window and the control by the words on it ("the Export button", "the Format menu"), never by position or pixels.
## What changes each time: what the person would want different next time (a file name, a date, a recipient), or "nothing".
## How to know it worked: what is on screen when it is done.
Only what the recording shows. If frames skip something, write "(not shown)" at that step. Never guess a name you cannot read. Leave out passwords, keys, card numbers, one-time codes and other people's private messages, even when on screen.
If the recording shows no clear task, answer {"name":"","description":"","body":""}.`;

/** The model's JSON, read leniently. → { name, description, body } or null */
export function parseSkill(text) {
  const m = /\{[\s\S]*\}/.exec(String(text ?? ''));
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return typeof j.body === 'string' && j.body.trim() ? { name: String(j.name ?? ''), description: String(j.description ?? ''), body: j.body.trim() } : null;
  } catch { return null; }
}

/** Write the skill where ox looks for yours. A secret in it means nothing is written. */
export function saveSkill(skill, { name = null, recording = null, home = os.homedir(), force = false } = {}) {
  const leak = screenPersistText(`${skill.description}\n${skill.body}`, 'skill', 'ox teach');
  if (leak) throw new Error('what it wrote down looks like it holds a password or key from the screen, so nothing was saved: record it again without that on screen');
  const id = slug(name ?? skill.name) || `taught-${Date.now().toString(36)}`;
  const dir = path.join(oxHome(home), 'skills', id);
  if (fs.existsSync(dir) && !force) throw new Error(`a skill named ${id} exists: --force to replace it, or --name`);
  fs.mkdirSync(dir, { recursive: true });
  const description = skill.description.replace(/\s+/g, ' ').trim() || `Use when asked to do what was shown in the recording ${id}.`;
  const text = [
    '---',
    `name: ${id}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    `# ${id}`,
    '',
    'Shown by the user in a screen recording. Follow it with the `desktop` tool: map the app, act on its refs, read it again after each step. Anything that sends, pays, deletes or publishes stays theirs to press.',
    ...(recording ? ['', `The recording: ${recording}. If a step is unclear, look with edit_video, op understand.`] : []),
    '',
    skill.body,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
  return { name: id, dir, file: path.join(dir, 'SKILL.md'), description };
}

function askWithFrames({ spec, prompt, frames, cwd, env }) {
  const args = [OX_BIN, '-p', prompt, '--json', '--mode', 'ask', ...(spec ? ['--bot', spec] : []), ...frames.flatMap((f) => ['--image', f])];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...env, OX_ISLAND: '0', OX_LEARN: '0', OX_MEMORY: '0', OX_MCP: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    child.on('error', (e) => resolve({ code: 1, out, err: e.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

/** A recording → a skill. `ask` stands in for the model in tests. */
export async function learnFromRecording(file, { name = null, bot = null, force = false, home = os.homedir(), env = process.env, ask = askWithFrames, see = understand, maxFrames = 12 } = {}) {
  const full = path.resolve(file);
  if (!fs.existsSync(full)) throw new Error(`no recording at ${full}`);
  const raw = see(full, { maxFrames, width: 1280 });
  const seen = { ...raw, frames: raw.frames.map((f) => (typeof f === 'string' ? f : f.file ?? f.path)) };
  try {
    const prompt = `${TEACH_SYSTEM}\n\nThe recording is ${Math.round(seen.duration)} s long; ${seen.frames.length} frames follow, in time order.\n\nWhat they said:\n${seen.text || '(nothing: there is no speech)'}`;
    const r = await ask({ spec: bot, prompt, frames: seen.frames, cwd: os.tmpdir(), env });
    const { reply, error } = replyOf(r.out);
    if (!reply) throw new Error(`the model did not answer: ${error || r.err.trim().split('\n').pop() || `exit ${r.code}`}`);
    const skill = parseSkill(reply);
    if (!skill) throw new Error('it could not make out a clear task in the recording, so nothing was saved');
    return { ...saveSkill(skill, { name, recording: full, home, force }), frames: seen.frames.length, heard: !!seen.text, body: skill.body };
  } finally {
    const dir = seen.frames[0] ? path.dirname(seen.frames[0]) : null;
    if (dir && path.basename(dir).startsWith('ox-frames-')) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Record the screen for a while, into ~/.ox/recordings. `voice` adds the microphone. */
export function recordScreen({ seconds = 60, voice = false, home = os.homedir(), run = spawnSync } = {}) {
  if (process.platform !== 'darwin') throw new Error('recording here needs macOS: on other systems, pass ox teach a video you recorded');
  const dir = path.join(oxHome(home), 'recordings');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.mov`);
  const r = run('screencapture', ['-v', '-V', String(seconds), ...(voice ? ['-g'] : []), file], { stdio: 'ignore', timeout: (seconds + 30) * 1000 });
  if (r.status !== 0 || !fs.existsSync(file)) throw new Error('the recording did not start: turn on Screen Recording for this app in System Settings > Privacy & Security');
  return file;
}
