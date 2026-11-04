// set_project: move this session to another folder, or make one for a new
// project, the way you would `mkdir` and `cd` in a terminal. Every later step
// of the run (files, commands) happens there, and the app's session follows
// (its folder, terminal and files switch too). A new project goes beside your
// others: in the folder you are working in, or where you keep projects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isOxInstall, newProjectDir } from '../workspace.js';

export const PROJECT_TOOL_SCHEMAS = Object.freeze([{
  name: 'set_project',
  description: 'Work in another folder from now on, like mkdir + cd. Use it when the user asks for a NEW project or app and the current folder is not that project (a home folder, a folder of several projects, an unrelated repo): give "name" to make a new folder for it beside the others, or "path" for a folder the user named (made if missing). Then build there. Also for "work in ~/code/shop".',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'A new project: its short name; a free folder is made for it' },
      path: { type: 'string', description: 'A folder the user named (absolute or ~/…); made if it does not exist' },
    },
  },
}]);

// A task of its own, noticed along the way: offered to you as a card, and started only if you say so.
export const SIDE_SESSION_SCHEMA = Object.freeze({
  name: 'start_session',
  description: 'Offer the user a separate, self-contained task (a bug you noticed, a follow-up that is not part of this request) as its own chat in this project. They choose whether it starts. Never for part of what they asked you to do.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A few words naming the task' },
      task: { type: 'string', description: 'A complete brief: that chat will not see this one' },
    },
    required: ['title', 'task'],
  },
});

export async function start_session(args = {}, ctx = {}) {
  const title = String(args.title ?? '').trim().slice(0, 80);
  const task = String(args.task ?? '').trim().slice(0, 4000);
  if (!title || !task) return { content: 'start_session: give a title and a task.', isError: true };
  if (typeof ctx.onSideSession !== 'function') return { content: 'start_session: only in the app. Tell the user about the task instead.', isError: true };
  ctx.onSideSession({ title, task });
  return { content: 'Offered to the user as its own chat; they decide. Do not do that work here: carry on with this task.' };
}

export async function set_project(args = {}, ctx = {}) {
  const home = os.homedir();
  const from = typeof ctx.cwd === 'string' && ctx.cwd ? ctx.cwd : process.cwd();
  let dir;
  if (args.path) dir = path.resolve(from, String(args.path).replace(/^~(?=$|[\\/])/, home));
  else if (args.name) {
    // Beside the others: in the folder you are in when it holds projects, else where you keep projects.
    const inWorkspace = from !== home && !isOxInstall(from) && !['.git', 'package.json'].some((f) => fs.existsSync(path.join(from, f)));
    dir = inWorkspace ? newProjectDir(args.name, { env: { ...process.env, OX_PROJECTS_DIR: from } }) : newProjectDir(args.name);
  } else return { content: 'set_project: give "name" for a new project or "path" for a folder.', isError: true };
  if (dir === path.parse(dir).root) return { content: 'set_project: not the root of the disk.', isError: true };
  if (isOxInstall(dir) || isOxInstall(path.dirname(dir))) return { content: 'set_project: that is ox\'s own folder; a project goes in a folder of its own.', isError: true };
  const exists = fs.existsSync(dir);
  if (exists && !fs.statSync(dir).isDirectory()) return { content: `set_project: ${dir} is a file.`, isError: true };
  // Outside your home folder, a new folder is made only with your OK.
  if (!exists && !dir.startsWith(home + path.sep) && typeof ctx.requestApproval === 'function') {
    const ok = await ctx.requestApproval('set_project', { path: dir }, `make the folder ${dir} and work there?`);
    if (ok !== true) return { content: `set_project: making ${dir} was declined.`, isError: true };
  }
  if (!exists) fs.mkdirSync(dir, { recursive: true });
  ctx.cwd = dir;
  try { ctx.onProject?.(dir); } catch {}
  return { content: `Now working in ${dir}${exists ? '' : ' (new folder)'}. Every file and command from here on is there; tell the user this path when you finish.` };
}
